/**
 * [A25] Sitemap health rules (reference: ian.is tools; queued for the SEO agent). Registered in the rule
 * registry (registry.ts RULES) and evaluated at crawl time from data the crawl already has:
 *
 *   SEO-SITEMAP-URL-ERROR         sitemap URL crawled with HTTP 4xx/5xx
 *   SEO-SITEMAP-URL-REDIRECT      sitemap URL crawled as a redirect (3xx, or refused as an off-site redirect)
 *   SEO-SITEMAP-URL-NOINDEX       sitemap URL served 2xx with a noindex robots directive (meta or X-Robots-Tag)
 *   SEO-SITEMAP-URL-NONCANONICAL  sitemap URL served 2xx whose canonical points to a different URL
 *   SEO-SITEMAP-LASTMOD-INVALID   <lastmod> that is not a W3C Datetime, or more than a day in the future
 *   SEO-SITEMAP-OFFHOST           sitemap-listed page URL outside the verified host (refused by the host guard)
 *
 * Inputs: RuleInput.sitemapUrls (bounded parse, at most 500 URLs, 3 child sitemaps), crawled snapshots
 * (`all`, including errors and redirects), RuleInput.sitemapEntries (<lastmod> per URL), and
 * RuleInput.sitemapRefused (entries the SSRF/host guard refused, at most 50). The URL rules only judge
 * sitemap URLs that were fetched in this crawl (the crawl is capped); URLs outside crawl coverage are
 * never claimed healthy or broken. Every finding carries an exact fix in `evidence.fix` and the detail.
 *
 * This module imports only types from registry.ts (the registry imports these rules at load time).
 */
import { normalizeHost } from "../ssrf";
import type { Rule, RuleContext, RuleSnapshot } from "./registry";

export const SITEMAP_HEALTH_VERSION = "sitemap-health-2026-09-30.1";
/** Findings per rule per crawl (the sitemap itself is capped at 500 URLs). */
export const SITEMAP_FINDINGS_CAP = 100;
/** A <lastmod> later than the crawl time by more than this is "in the future" (time zones allowed for). */
export const LASTMOD_FUTURE_TOLERANCE_MS = 24 * 3600 * 1000;
const HOST_REFUSAL = "Host is not the verified host.";

type Emitted = ReturnType<Rule["emit"]>[number];

/** Same normalization as registry.normalizeUrlKey (duplicated to keep this module free of runtime imports from it). */
function urlKey(u: string): string {
  try {
    const url = new URL(u);
    url.hash = "";
    url.hostname = normalizeHost(url.hostname);
    if (url.pathname.length > 1) url.pathname = url.pathname.replace(/\/+$/, "");
    return url.toString();
  } catch {
    return u;
  }
}

const isRedirect = (s: RuleSnapshot) => (s.statusCode !== null && s.statusCode >= 300 && s.statusCode < 400) || s.skippedReason === "redirect_offsite";
const isError = (s: RuleSnapshot) => !s.skippedReason && s.statusCode !== null && s.statusCode >= 400;
/** Served 2xx HTML whose robots/canonical were extracted (JS-rendered pages included). */
const served2xx = (s: RuleSnapshot) => s.statusCode !== null && s.statusCode >= 200 && s.statusCode < 300 && (!s.skippedReason || s.skippedReason === "js_rendered") && !isRedirect(s);
const isNoindex = (s: RuleSnapshot) => /\b(noindex|none)\b/.test(s.robotsMeta ?? "");

/**
 * Sitemap URLs (deduplicated) paired with the snapshot recorded for them in this crawl. An exact URL
 * match wins, so a sitemap URL that redirects to its trailing-slash variant keeps its own 3xx record.
 */
export function crawledSitemapUrls(ctx: Pick<RuleContext, "sitemapUrls" | "all">): Array<{ url: string; snap: RuleSnapshot }> {
  const exact = new Map<string, RuleSnapshot>();
  const byKey = new Map<string, RuleSnapshot>();
  for (const s of ctx.all) {
    if (!exact.has(s.url)) exact.set(s.url, s);
    const k = urlKey(s.url);
    if (!byKey.has(k)) byKey.set(k, s);
  }
  const seen = new Set<string>();
  const out: Array<{ url: string; snap: RuleSnapshot }> = [];
  for (const u of ctx.sitemapUrls) {
    const k = urlKey(u);
    if (seen.has(k)) continue;
    seen.add(k);
    const snap = exact.get(u) ?? byKey.get(k);
    if (snap) out.push({ url: u, snap });
  }
  return out;
}

const finding = (url: string, pageType: RuleSnapshot["pageType"] | null, what: string, fix: string, evidence: Record<string, unknown> = {}): Emitted => ({
  url,
  pageType,
  detail: `${what} Fix: ${fix}`,
  evidence: { ...evidence, fix, sitemapHealthVersion: SITEMAP_HEALTH_VERSION },
});

// ------------------------------------------------------------------ lastmod
/** W3C Datetime (the sitemaps.org lastmod format): YYYY, YYYY-MM, YYYY-MM-DD, or date + time + zone. */
const W3C_DATETIME = /^(\d{4})(?:-(0[1-9]|1[0-2])(?:-(0[1-9]|[12]\d|3[01])(?:T([01]\d|2[0-3]):([0-5]\d)(?::([0-5]\d)(?:\.\d+)?)?(Z|[+-](?:[01]\d|2[0-3]):[0-5]\d))?)?)?$/;

/** Parse a <lastmod> value; null when it is not a valid W3C Datetime (including impossible dates). */
export function parseLastmod(raw: string): Date | null {
  const v = raw.trim();
  const m = W3C_DATETIME.exec(v);
  if (!m) return null;
  const [, y, mo, d] = m;
  if (mo && d) {
    const probe = new Date(Date.UTC(Number(y), Number(mo) - 1, Number(d)));
    if (probe.getUTCMonth() !== Number(mo) - 1 || probe.getUTCDate() !== Number(d)) return null;
  }
  const iso = d ? v : mo ? `${v}-01` : `${v}-01-01`;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? new Date(t) : null;
}

export type LastmodProblem = { kind: "invalid" } | { kind: "future"; date: Date };

export function lastmodProblem(raw: string | null, now: Date | undefined): LastmodProblem | null {
  if (raw === null) return null; // absent lastmod is allowed (optional in the protocol)
  const d = parseLastmod(raw);
  if (!d) return { kind: "invalid" };
  if (now && d.getTime() > now.getTime() + LASTMOD_FUTURE_TOLERANCE_MS) return { kind: "future", date: d };
  return null;
}

// ------------------------------------------------------------------ rules
export const SITEMAP_HEALTH_RULES: readonly Rule[] = [
  {
    id: "SEO-SITEMAP-URL-ERROR",
    name: "Sitemap URL returns an error",
    area: "indexing",
    class: "fact",
    severity: "moderate",
    appliesTo: "all",
    templateable: false,
    applicability:
      "Only sitemap URLs fetched in this crawl are judged (the crawl and sitemap parsing are capped). A removed page may correctly return 404/410, but then it should not be in the sitemap. A single 5xx may be transient.",
    emit: (ctx) =>
      crawledSitemapUrls(ctx)
        .filter(({ snap }) => isError(snap))
        .slice(0, SITEMAP_FINDINGS_CAP)
        .map(({ url, snap }) => {
          const st = snap.statusCode!;
          const fix = st >= 500 ? `Remove this URL from the sitemap or fix the ${st} (recheck first: a single 5xx can be transient).` : `Remove this URL from the sitemap or fix the ${st}.`;
          return finding(url, snap.pageType, `Listed in the sitemap but returned HTTP ${st}.`, fix, { status: st });
        }),
  },
  {
    id: "SEO-SITEMAP-URL-REDIRECT",
    name: "Sitemap URL redirects",
    area: "indexing",
    class: "fact",
    severity: "minor",
    appliesTo: "all",
    templateable: false,
    applicability: "Only sitemap URLs fetched in this crawl are judged. Sitemaps should list final URLs; search engines follow redirects, but listing the redirecting URL wastes crawling and sends mixed signals.",
    emit: (ctx) => {
      const byKey = new Map(ctx.all.map((s) => [urlKey(s.url), s]));
      return crawledSitemapUrls(ctx)
        .filter(({ snap }) => isRedirect(snap))
        .slice(0, SITEMAP_FINDINGS_CAP)
        .map(({ url, snap }) => {
          if (snap.skippedReason === "redirect_offsite" || !snap.finalUrl) {
            return finding(url, snap.pageType, "Listed in the sitemap but redirects to another host.", "Remove this URL from the sitemap: it redirects to another host.", { status: snap.statusCode });
          }
          const final = snap.finalUrl;
          const target = ctx.all.find((s) => s.url === final && s !== snap) ?? (urlKey(final) !== urlKey(url) ? byKey.get(urlKey(final)) : undefined);
          const targetBad = !!target && (isError(target) || (served2xx(target) && isNoindex(target)));
          const fix = targetBad
            ? `Remove this URL from the sitemap: it redirects to ${final}, which ${isError(target!) ? `returned ${target!.statusCode}` : "is noindex"}.`
            : `Replace this URL in the sitemap with its final URL ${final}.`;
          return finding(url, snap.pageType, `Listed in the sitemap but redirects (HTTP ${snap.statusCode}) to ${final}.`, fix, { status: snap.statusCode, finalUrl: final });
        });
    },
  },
  {
    id: "SEO-SITEMAP-URL-NOINDEX",
    name: "Sitemap URL is noindex",
    area: "indexing",
    class: "fact",
    severity: "moderate",
    appliesTo: "all",
    templateable: false,
    applicability: "Only sitemap URLs fetched in this crawl are judged. A sitemap asks search engines to index its URLs; a noindex directive on the same URL contradicts it.",
    emit: (ctx) =>
      crawledSitemapUrls(ctx)
        .filter(({ snap }) => served2xx(snap) && isNoindex(snap))
        .slice(0, SITEMAP_FINDINGS_CAP)
        .map(({ url, snap }) =>
          finding(url, snap.pageType, `Listed in the sitemap but declares noindex ("${snap.robotsMeta}").`, "Remove this URL from the sitemap, or remove the noindex directive if the page should be indexed.", { robots: snap.robotsMeta }),
        ),
  },
  {
    id: "SEO-SITEMAP-URL-NONCANONICAL",
    name: "Sitemap URL is not canonical",
    area: "indexing",
    class: "fact",
    severity: "minor",
    appliesTo: "all",
    templateable: false,
    applicability: "Only sitemap URLs fetched in this crawl are judged. Sitemaps should list canonical URLs; a canonical is a hint, so check that the declared canonical is the URL you want indexed.",
    emit: (ctx) =>
      crawledSitemapUrls(ctx)
        .filter(({ url, snap }) => served2xx(snap) && !!snap.canonical && urlKey(snap.canonical) !== urlKey(url))
        .slice(0, SITEMAP_FINDINGS_CAP)
        .map(({ url, snap }) => {
          const c = snap.canonical!;
          let offHost = true;
          try {
            offHost = normalizeHost(new URL(c).hostname) !== normalizeHost(ctx.verifiedHost);
          } catch {
            offHost = true;
          }
          const fix = offHost ? `Remove this URL from the sitemap: its canonical points to another host (${c}).` : `Replace with the canonical URL ${c}`;
          return finding(url, snap.pageType, `Listed in the sitemap but its canonical is ${c}.`, fix, { canonical: c });
        }),
  },
  {
    id: "SEO-SITEMAP-LASTMOD-INVALID",
    name: "Sitemap lastmod is invalid or in the future",
    area: "indexing",
    class: "fact",
    severity: "minor",
    appliesTo: "all",
    templateable: false,
    applicability:
      "Checks every <lastmod> read from the sitemap (at most 500 URLs) against the W3C Datetime format and the crawl time (more than one day ahead counts as future). A missing lastmod is allowed. Search engines ignore lastmod values they cannot trust.",
    emit: (ctx) => {
      const pageTypes = new Map(ctx.all.map((s) => [urlKey(s.url), s.pageType]));
      const out: Emitted[] = [];
      const seen = new Set<string>();
      for (const e of ctx.sitemapEntries ?? []) {
        if (out.length >= SITEMAP_FINDINGS_CAP) break;
        const k = urlKey(e.url);
        if (seen.has(k)) continue;
        seen.add(k);
        const p = lastmodProblem(e.lastmod, ctx.now);
        if (!p) continue;
        const shown = JSON.stringify(e.lastmod);
        out.push(
          p.kind === "invalid"
            ? finding(e.url, pageTypes.get(k) ?? null, `The sitemap <lastmod> ${shown} is not a valid W3C Datetime.`, "Set <lastmod> to the page's last significant change in W3C Datetime format (for example 2026-09-30), or remove it.", { lastmod: e.lastmod })
            : finding(e.url, pageTypes.get(k) ?? null, `The sitemap <lastmod> ${shown} is in the future.`, "Set <lastmod> to the date of the page's last significant change, not a future date.", { lastmod: e.lastmod }),
        );
      }
      return out;
    },
  },
  {
    id: "SEO-SITEMAP-OFFHOST",
    name: "Sitemap lists URLs outside the verified host",
    area: "indexing",
    class: "fact",
    severity: "minor",
    appliesTo: "all",
    templateable: false,
    applicability:
      "Page URLs listed in a sitemap on the verified host must be on that host (the sitemaps protocol only allows cross-host URLs with robots.txt cross-submission, which this app does not follow). At most 50 refused entries are recorded per crawl.",
    emit: (ctx) => {
      const host = normalizeHost(ctx.verifiedHost);
      const out: Emitted[] = [];
      const seen = new Set<string>();
      const add = (url: string) => {
        if (seen.has(url) || out.length >= SITEMAP_FINDINGS_CAP) return;
        seen.add(url);
        let listedHost = "";
        try {
          listedHost = new URL(url).hostname;
        } catch {
          listedHost = "";
        }
        out.push(
          finding(
            url,
            null,
            `Listed in the sitemap but outside the verified host ${host}${listedHost ? ` (host ${listedHost})` : ""}.`,
            `Remove this URL from the sitemap: it is outside the verified host ${host}. List it in a sitemap on its own host.`,
            { verifiedHost: host, host: listedHost || null },
          ),
        );
      };
      for (const r of ctx.sitemapRefused ?? []) if ((r.kind ?? "page") === "page" && r.reason === HOST_REFUSAL) add(r.url);
      // Defense in depth: the crawler only passes on-host URLs, but a caller could pass others.
      for (const u of ctx.sitemapUrls) {
        try {
          if (normalizeHost(new URL(u).hostname) !== host) add(u);
        } catch {
          /* unparseable URLs are refused by the crawler, not judged here */
        }
      }
      return out;
    },
  },
];
