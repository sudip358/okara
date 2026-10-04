/**
 * Backlink page analysis (pure, no I/O). Untrusted HTML is evidence only: nothing here executes, follows or obeys it;
 * only compact facts leave this module (meta robots / X-Robots-Tag verdicts, canonical, and the links that point to
 * our site with their rel tokens and plain anchor text, capped).
 *
 * CPU: Workers Free allows ~10 ms of CPU per invocation, so the page is not parsed into a DOM. Comments and
 * <script>/<style> blocks are removed, then only `<a>` tags whose attributes contain our host name are parsed (links to
 * our site from an external article are absolute or protocol-relative; a relative href resolves to the article's own
 * host, never ours). Meta and link tags are read with one bounded regex pass each.
 */
import { linkUrlKey } from "@shared/import";
import type { BacklinkFoundLink, LinkRel } from "@shared/backlinks";

export const MAX_FOUND_LINKS = 20;
export const ANCHOR_TEXT_CHARS = 200;
const MAX_META_TAGS = 400;
const MAX_LINK_TAGS = 400;
/** Characters of an anchor's inner HTML read for its text. */
const ANCHOR_INNER_CHARS = 5_000;
/** Robots agents whose directives apply to us: the generic group, Google (whose nofollow semantics owners care about) and our own token. */
const ROBOTS_AGENTS = new Set(["robots", "googlebot", "okarabot"]);

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", "#39": "'" };

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]{1,6}|#[0-9]{1,7}|[a-z]{2,8}|#39);/gi, (m, e: string) => {
    const k = e.toLowerCase();
    if (k.startsWith("#x")) {
      const n = parseInt(k.slice(2), 16);
      return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : m;
    }
    if (k.startsWith("#")) {
      const n = parseInt(k.slice(1), 10);
      return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : m;
    }
    return ENTITIES[k] ?? m;
  });
}

/** Attributes of one start tag (`<a href=... rel=...>`), names lower-cased, values entity-decoded. */
export function parseAttributes(tag: string): Map<string, string> {
  const out = new Map<string, string>();
  const body = tag.replace(/^<\s*[a-z0-9-]+/i, "").replace(/\/?>$/, "");
  const re = /([^\s"'=<>/]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
  let m: RegExpExecArray | null;
  let n = 0;
  while ((m = re.exec(body)) !== null && n++ < 64) {
    const name = m[1]!.toLowerCase();
    if (out.has(name)) continue;
    out.set(name, decodeEntities(m[2] ?? m[3] ?? m[4] ?? ""));
  }
  return out;
}

/** Plain text of an anchor's inner HTML (tags removed, entities decoded, whitespace collapsed); image alt as a fallback. */
export function anchorText(inner: string): string {
  const text = decodeEntities(inner.replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ").trim();
  if (text) return text.slice(0, ANCHOR_TEXT_CHARS);
  const alt = /<img\b[^>]*\balt\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(inner);
  const a = alt ? decodeEntities(alt[1] ?? alt[2] ?? "").replace(/\s+/g, " ").trim() : "";
  return a ? `[image: ${a.slice(0, ANCHOR_TEXT_CHARS - 9)}]` : "";
}

/** dofollow unless rel says otherwise; sponsored > ugc > nofollow when several are present. */
export function relClass(rel: string | null | undefined): Exclude<LinkRel, "missing"> {
  const tokens = new Set((rel ?? "").toLowerCase().split(/\s+/).filter(Boolean));
  if (tokens.has("sponsored")) return "sponsored";
  if (tokens.has("ugc")) return "ugc";
  if (tokens.has("nofollow")) return "nofollow";
  return "dofollow";
}

export interface RobotsDirectives {
  noindex: boolean;
  nofollow: boolean;
}

/** Directives of a meta robots content value ("noindex, nofollow"; "none" = both). */
export function parseRobotsContent(content: string): RobotsDirectives {
  const tokens = content.toLowerCase().split(/[\s,]+/).filter(Boolean);
  const none = tokens.includes("none");
  return { noindex: none || tokens.includes("noindex"), nofollow: none || tokens.includes("nofollow") };
}

/**
 * X-Robots-Tag (possibly several headers joined with ", "): directives without a user-agent prefix, or after a
 * "googlebot:" / "okarabot:" prefix, apply; directives after another agent's prefix do not. Value directives such as
 * "unavailable_after: <date>" are not agent prefixes.
 */
export function parseXRobotsTag(header: string | null): RobotsDirectives {
  const out: RobotsDirectives = { noindex: false, nofollow: false };
  if (!header) return out;
  const VALUE_DIRECTIVES = new Set(["unavailable_after", "max-snippet", "max-image-preview", "max-video-preview"]);
  let agent: string | null = null;
  for (const raw of header.toLowerCase().split(",")) {
    let seg = raw.trim();
    const m = /^([a-z0-9_-]+)\s*:\s*(.*)$/.exec(seg);
    if (m && !VALUE_DIRECTIVES.has(m[1]!)) {
      agent = m[1]!;
      seg = m[2]!;
    }
    if (agent !== null && !ROBOTS_AGENTS.has(agent)) continue;
    const d = parseRobotsContent(seg);
    out.noindex ||= d.noindex;
    out.nofollow ||= d.nofollow;
  }
  return out;
}

export interface PageAnalysis {
  /** Combined content of the meta robots tags that apply (robots, googlebot, okarabot), capped. */
  metaRobots: string | null;
  metaNoindex: boolean;
  metaNofollow: boolean;
  /** Canonical URL when it points to a different URL than the page itself (normalized comparison); null otherwise. */
  canonicalElsewhere: string | null;
  /** Links to our site, target matches first, capped at MAX_FOUND_LINKS. */
  links: BacklinkFoundLink[];
  /** Links to our site seen (before the cap). */
  linkCount: number;
}

const stripHost = (h: string) => h.toLowerCase().replace(/\.$/, "").replace(/^www\./, "");

/**
 * Analyse one fetched article page for links to our site.
 * @param ourHost our site's host (www. twin accepted), e.g. "residencesupply.com"
 * @param targetKey linkUrlKey of the target URL (scheme, www., trailing slash, fragment and utm_* ignored)
 */
export function analyzePage(html: string, pageUrl: string, ourHost: string, targetKey: string): PageAnalysis {
  const clean = html.replace(/<!--[\s\S]*?-->/g, " ").replace(/<(script|style|template)\b[\s\S]*?<\/\1\s*>/gi, " ");
  const lower = clean.toLowerCase();
  const host = stripHost(ourHost);

  // <base href> changes how relative hrefs resolve (only matters for protocol-relative / odd forms here).
  let base = pageUrl;
  const baseTag = /<base\b[^>]*>/i.exec(clean);
  if (baseTag) {
    const href = parseAttributes(baseTag[0]).get("href");
    if (href) {
      try {
        base = new URL(href, pageUrl).toString();
      } catch {
        /* keep the page URL */
      }
    }
  }

  // Meta robots and canonical.
  let metaRobots: string[] = [];
  let metaNoindex = false;
  let metaNofollow = false;
  let canonical: string | null = null;
  {
    const re = /<meta\b[^>]*>/gi;
    let m: RegExpExecArray | null;
    let n = 0;
    while ((m = re.exec(clean)) !== null && n++ < MAX_META_TAGS) {
      const attrs = parseAttributes(m[0]);
      const name = (attrs.get("name") ?? "").trim().toLowerCase();
      if (!ROBOTS_AGENTS.has(name)) continue;
      const content = (attrs.get("content") ?? "").trim();
      if (!content) continue;
      metaRobots.push(`${name}: ${content.slice(0, 120)}`);
      const d = parseRobotsContent(content);
      metaNoindex ||= d.noindex;
      metaNofollow ||= d.nofollow;
    }
    const lre = /<link\b[^>]*>/gi;
    n = 0;
    while ((m = lre.exec(clean)) !== null && n++ < MAX_LINK_TAGS) {
      const attrs = parseAttributes(m[0]);
      if (!(attrs.get("rel") ?? "").toLowerCase().split(/\s+/).includes("canonical")) continue;
      const href = attrs.get("href");
      if (!href) continue;
      try {
        canonical = new URL(href, base).toString();
      } catch {
        canonical = null;
      }
      break;
    }
  }
  metaRobots = metaRobots.slice(0, 5);
  const canonicalElsewhere = canonical && linkUrlKey(canonical) !== linkUrlKey(pageUrl) ? canonical.slice(0, 2000) : null;

  // Links to our site: only <a> tags whose attributes contain our host name are parsed.
  const found: BacklinkFoundLink[] = [];
  let linkCount = 0;
  let from = 0;
  let lastTagEnd = -1;
  for (;;) {
    const idx = lower.indexOf(host, from);
    if (idx < 0) break;
    from = idx + host.length;
    const tagStart = lower.lastIndexOf("<", idx);
    if (tagStart < 0 || tagStart <= lastTagEnd) continue;
    if (!/^<a[\s/]/.test(lower.slice(tagStart, tagStart + 3))) continue;
    const tagEnd = lower.indexOf(">", idx);
    if (tagEnd < 0) break;
    // The host must sit inside this tag (no ">" between the tag start and the occurrence).
    if (lower.lastIndexOf(">", idx) > tagStart) continue;
    lastTagEnd = tagEnd;
    from = Math.max(from, tagEnd + 1);
    const attrs = parseAttributes(clean.slice(tagStart, tagEnd + 1));
    const href = (attrs.get("href") ?? "").trim();
    if (!href) continue;
    let resolved: URL;
    try {
      resolved = new URL(href, base);
    } catch {
      continue;
    }
    if (resolved.protocol !== "https:" && resolved.protocol !== "http:") continue;
    if (stripHost(resolved.hostname) !== host) continue;
    linkCount++;
    if (found.length >= MAX_FOUND_LINKS) continue;
    const close = lower.indexOf("</a", tagEnd + 1);
    const innerEnd = close < 0 ? Math.min(clean.length, tagEnd + 1 + 500) : Math.min(close, tagEnd + 1 + ANCHOR_INNER_CHARS);
    const rel = attrs.get("rel") ?? null;
    found.push({
      href: resolved.toString().slice(0, 2000),
      rel: rel ? rel.replace(/\s+/g, " ").trim().slice(0, 100) || null : null,
      anchor: anchorText(clean.slice(tagEnd + 1, innerEnd)),
      match: linkUrlKey(resolved.toString()) === targetKey ? "target" : "host",
      relClass: relClass(rel),
    });
  }
  found.sort((a, b) => (a.match === b.match ? 0 : a.match === "target" ? -1 : 1));
  return { metaRobots: metaRobots.length ? metaRobots.join("; ").slice(0, 400) : null, metaNoindex, metaNofollow, canonicalElsewhere, links: found, linkCount };
}
