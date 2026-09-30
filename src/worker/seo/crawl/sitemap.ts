/**
 * Bounded sitemap parsing ([A20]): urlset and sitemapindex (one level), max 3 child sitemaps, 2 MB per
 * file, max 500 URLs total. Every sitemap URL, index child, and listed page URL must be on the verified
 * host and pass the SSRF guard; anything else is refused and reported. gzip sitemaps are not read
 * (reported). Uses htmlparser2 in xmlMode (streaming tokenizer; see extract.ts for why not HTMLRewriter).
 * Each listed URL keeps its <lastmod> text (raw, capped at LASTMOD_MAX_CHARS; null when absent) for the
 * sitemap health rules; refused entries record whether they were a listed page URL or a sitemap file.
 */
import { Parser } from "htmlparser2";
import { assertCrawlableUrl, CrawlFetchError, guardedFetch } from "../ssrf";

export const SITEMAP_MAX_BYTES = 2 * 1024 * 1024;
export const SITEMAP_MAX_CHILDREN = 3;
export const SITEMAP_MAX_URLS = 500;
export const LASTMOD_MAX_CHARS = 64;

export interface ParsedSitemap {
  kind: "urlset" | "sitemapindex" | "unknown";
  locs: string[];
  truncated: boolean;
}

export interface ParsedSitemapWithLastmod extends ParsedSitemap {
  /** <lastmod> per <loc> (raw text, capped; null when the entry has none). */
  lastmod: Map<string, string | null>;
}

/** Parse sitemap XML (or a plain-text sitemap, one URL per line), stopping after `maxLocs`. */
export function parseSitemap(body: string, maxLocs = SITEMAP_MAX_URLS): ParsedSitemap {
  const { kind, locs, truncated } = parseSitemapWithLastmod(body, maxLocs);
  return { kind, locs, truncated };
}

/** parseSitemap plus each entry's <lastmod> text (for the sitemap health rules). */
export function parseSitemapWithLastmod(body: string, maxLocs = SITEMAP_MAX_URLS): ParsedSitemapWithLastmod {
  const trimmed = body.trimStart();
  if (!trimmed.startsWith("<")) {
    const lines = trimmed.split(/\r?\n/).map((l) => l.trim()).filter((l) => /^https?:\/\//i.test(l));
    const locs = lines.slice(0, maxLocs);
    return { kind: "urlset", locs, lastmod: new Map(locs.map((l) => [l, null])), truncated: lines.length > maxLocs };
  }
  let kind: ParsedSitemap["kind"] = "unknown";
  const locs: string[] = [];
  const lastmod = new Map<string, string | null>();
  let inLoc = false;
  let buf = "";
  let truncated = false;
  // The current <url>/<sitemap> entry: its <loc> and <lastmod> may come in either order.
  let entry: { loc: string | null; lastmod: string | null } | null = null;
  let inLastmod = false;
  let lastmodBuf = "";
  const parser = new Parser(
    {
      onopentag(name) {
        const local = name.toLowerCase().replace(/^.*:/, "");
        if (kind === "unknown" && (local === "urlset" || local === "sitemapindex")) kind = local;
        if (local === "url" || local === "sitemap") entry = { loc: null, lastmod: null };
        if (local === "loc") {
          inLoc = true;
          buf = "";
        }
        if (local === "lastmod") {
          inLastmod = true;
          lastmodBuf = "";
        }
      },
      ontext(text) {
        if (inLoc) buf += text;
        if (inLastmod && lastmodBuf.length <= LASTMOD_MAX_CHARS) lastmodBuf += text;
      },
      onclosetag(name) {
        const local = name.toLowerCase().replace(/^.*:/, "");
        if (local === "loc" && inLoc) {
          inLoc = false;
          const v = buf.trim();
          if (v) {
            if (locs.length < maxLocs) {
              locs.push(v);
              if (!lastmod.has(v)) lastmod.set(v, entry?.lastmod ?? null);
              if (entry) entry.loc = v;
            } else truncated = true;
          }
        }
        if (local === "lastmod" && inLastmod) {
          inLastmod = false;
          const v = lastmodBuf.trim().slice(0, LASTMOD_MAX_CHARS);
          if (entry) {
            entry.lastmod = v;
            if (entry.loc && lastmod.has(entry.loc)) lastmod.set(entry.loc, v);
          }
        }
        if (local === "url" || local === "sitemap") entry = null;
      },
    },
    { xmlMode: true, decodeEntities: true },
  );
  parser.write(body);
  parser.end();
  return { kind, locs, lastmod, truncated };
}

export interface SitemapRefusal {
  url: string;
  reason: string;
  /** "page": a URL listed in a urlset; "sitemap": a sitemap file (robots.txt Sitemap: line or index child). */
  kind: "page" | "sitemap";
}

export interface SitemapResult {
  urls: string[];
  /** URL -> sitemap file name it came from (for sitemap-membership page-type hints). */
  source: Map<string, string>;
  /** One entry per URL in `urls` (same order): the raw <lastmod> text, or null when absent. */
  entries: Array<{ url: string; lastmod: string | null }>;
  fetched: string[];
  refused: SitemapRefusal[];
  notes: string[];
}

export async function collectSitemapUrls(
  fetchImpl: typeof fetch,
  opts: { verifiedHost: string; sitemapUrls: string[]; userAgent: string; timeoutMs?: number; maxUrls?: number },
): Promise<SitemapResult> {
  const maxUrls = opts.maxUrls ?? SITEMAP_MAX_URLS;
  const out: SitemapResult = { urls: [], source: new Map(), entries: [], fetched: [], refused: [], notes: [] };
  const seen = new Set<string>();
  const add = (u: string, file: string, lastmod: string | null) => {
    if (out.urls.length >= maxUrls) return false;
    let url: URL;
    try {
      url = assertCrawlableUrl(u, opts.verifiedHost);
    } catch (e) {
      if (out.refused.length < 50) out.refused.push({ url: u.slice(0, 300), reason: (e as Error).message, kind: "page" });
      return true;
    }
    const s = url.toString();
    if (!seen.has(s)) {
      seen.add(s);
      out.urls.push(s);
      out.source.set(s, file);
      out.entries.push({ url: s, lastmod });
    }
    return true;
  };

  const fetchOne = async (u: string): Promise<ParsedSitemapWithLastmod | null> => {
    try {
      assertCrawlableUrl(u, opts.verifiedHost);
    } catch (e) {
      out.refused.push({ url: u.slice(0, 300), reason: (e as Error).message, kind: "sitemap" });
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
      return parseSitemapWithLastmod(res.body, maxUrls);
    } catch (e) {
      const code = e instanceof CrawlFetchError ? e.code : "error";
      out.refused.push({ url: u.slice(0, 300), reason: code, kind: "sitemap" });
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
          out.refused.push({ url: child.slice(0, 300), reason: (e as Error).message, kind: "sitemap" });
          continue;
        }
        childBudget--;
        const sub = await fetchOne(child);
        if (!sub) continue;
        if (sub.kind === "sitemapindex") {
          out.notes.push(`Nested sitemap index ${child} not followed (one level only).`);
          continue;
        }
        for (const loc of sub.locs) if (!add(loc, fileName(child), sub.lastmod.get(loc) ?? null)) break;
      }
    } else {
      for (const loc of parsed.locs) if (!add(loc, fileName(top), parsed.lastmod.get(loc) ?? null)) break;
    }
  }
  if (out.urls.length >= maxUrls) out.notes.push(`Sitemap URLs capped at ${maxUrls}.`);
  return out;
}
