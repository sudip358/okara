/**
 * Bounded sitemap parsing ([A20]): urlset and sitemapindex (one level), max 3 child sitemaps, 2 MB per
 * file, max 500 URLs total. Every sitemap URL, index child, and listed page URL must be on the verified
 * host and pass the SSRF guard; anything else is refused and reported. gzip sitemaps are not read
 * (reported). Uses htmlparser2 in xmlMode (streaming tokenizer; see extract.ts for why not HTMLRewriter).
 */
import { Parser } from "htmlparser2";
import { assertCrawlableUrl, CrawlFetchError, guardedFetch } from "../ssrf";

export const SITEMAP_MAX_BYTES = 2 * 1024 * 1024;
export const SITEMAP_MAX_CHILDREN = 3;
export const SITEMAP_MAX_URLS = 500;

export interface ParsedSitemap {
  kind: "urlset" | "sitemapindex" | "unknown";
  locs: string[];
  truncated: boolean;
}

/** Parse sitemap XML (or a plain-text sitemap, one URL per line), stopping after `maxLocs`. */
export function parseSitemap(body: string, maxLocs = SITEMAP_MAX_URLS): ParsedSitemap {
  const trimmed = body.trimStart();
  if (!trimmed.startsWith("<")) {
    const lines = trimmed.split(/\r?\n/).map((l) => l.trim()).filter((l) => /^https?:\/\//i.test(l));
    return { kind: "urlset", locs: lines.slice(0, maxLocs), truncated: lines.length > maxLocs };
  }
  let kind: ParsedSitemap["kind"] = "unknown";
  const locs: string[] = [];
  let inLoc = false;
  let buf = "";
  let truncated = false;
  const parser = new Parser(
    {
      onopentag(name) {
        const local = name.toLowerCase().replace(/^.*:/, "");
        if (kind === "unknown" && (local === "urlset" || local === "sitemapindex")) kind = local;
        if (local === "loc") {
          inLoc = true;
          buf = "";
        }
      },
      ontext(text) {
        if (inLoc) buf += text;
      },
      onclosetag(name) {
        const local = name.toLowerCase().replace(/^.*:/, "");
        if (local === "loc" && inLoc) {
          inLoc = false;
          const v = buf.trim();
          if (v) {
            if (locs.length < maxLocs) locs.push(v);
            else truncated = true;
          }
        }
      },
    },
    { xmlMode: true, decodeEntities: true },
  );
  parser.write(body);
  parser.end();
  return { kind, locs, truncated };
}

export interface SitemapResult {
  urls: string[];
  /** URL -> sitemap file name it came from (for sitemap-membership page-type hints). */
  source: Map<string, string>;
  fetched: string[];
  refused: Array<{ url: string; reason: string }>;
  notes: string[];
}

export async function collectSitemapUrls(
  fetchImpl: typeof fetch,
  opts: { verifiedHost: string; sitemapUrls: string[]; userAgent: string; timeoutMs?: number; maxUrls?: number },
): Promise<SitemapResult> {
  const maxUrls = opts.maxUrls ?? SITEMAP_MAX_URLS;
  const out: SitemapResult = { urls: [], source: new Map(), fetched: [], refused: [], notes: [] };
  const seen = new Set<string>();
  const add = (u: string, file: string) => {
    if (out.urls.length >= maxUrls) return false;
    let url: URL;
    try {
      url = assertCrawlableUrl(u, opts.verifiedHost);
    } catch (e) {
      if (out.refused.length < 50) out.refused.push({ url: u.slice(0, 300), reason: (e as Error).message });
      return true;
    }
    const s = url.toString();
    if (!seen.has(s)) {
      seen.add(s);
      out.urls.push(s);
      out.source.set(s, file);
    }
    return true;
  };

  const fetchOne = async (u: string): Promise<ParsedSitemap | null> => {
    try {
      assertCrawlableUrl(u, opts.verifiedHost);
    } catch (e) {
      out.refused.push({ url: u.slice(0, 300), reason: (e as Error).message });
      return null;
    }
    if (/\.gz($|\?)/i.test(u)) {
      out.notes.push(`Skipped gzip sitemap ${u} (not supported).`);
      return null;
    }
    try {
      const res = await guardedFetch(fetchImpl, u, {
        verifiedHost: opts.verifiedHost,
        maxBytes: SITEMAP_MAX_BYTES,
        timeoutMs: opts.timeoutMs ?? 10_000,
        maxRedirects: 5,
        kind: "sitemap",
        userAgent: opts.userAgent,
      });
      if (res.status < 200 || res.status >= 300) {
        out.notes.push(`Sitemap ${u} returned ${res.status}.`);
        return null;
      }
      out.fetched.push(u);
      return parseSitemap(res.body, maxUrls);
    } catch (e) {
      const code = e instanceof CrawlFetchError ? e.code : "error";
      out.refused.push({ url: u.slice(0, 300), reason: code });
      return null;
    }
  };

  const fileName = (u: string) => {
    try {
      return new URL(u).pathname.split("/").pop() ?? u;
    } catch {
      return u;
    }
  };

  let childBudget = SITEMAP_MAX_CHILDREN;
  for (const top of [...new Set(opts.sitemapUrls)].slice(0, SITEMAP_MAX_CHILDREN)) {
    if (out.urls.length >= maxUrls) break;
    const parsed = await fetchOne(top);
    if (!parsed) continue;
    if (parsed.kind === "sitemapindex") {
      const children = parsed.locs;
      if (children.length > childBudget) out.notes.push(`Sitemap index ${top} lists ${children.length} sitemaps; read ${Math.max(childBudget, 0)} (cap ${SITEMAP_MAX_CHILDREN}).`);
      for (const child of children) {
        if (childBudget <= 0 || out.urls.length >= maxUrls) break;
        // Validate before counting against the budget so a refused child does not consume a slot silently.
        try {
          assertCrawlableUrl(child, opts.verifiedHost);
        } catch (e) {
          out.refused.push({ url: child.slice(0, 300), reason: (e as Error).message });
          continue;
        }
        childBudget--;
        const sub = await fetchOne(child);
        if (!sub) continue;
        if (sub.kind === "sitemapindex") {
          out.notes.push(`Nested sitemap index ${child} not followed (one level only).`);
          continue;
        }
        for (const loc of sub.locs) if (!add(loc, fileName(child))) break;
      }
    } else {
      for (const loc of parsed.locs) if (!add(loc, fileName(top))) break;
    }
  }
  if (out.urls.length >= maxUrls) out.notes.push(`Sitemap URLs capped at ${maxUrls}.`);
  return out;
}
