/**
 * [A23] Draft check: parse a pasted draft into a compact document model.
 *
 * Markdown / plain text (the default):
 *  - headings: ATX lines ("# ", "## ", ...) and setext underlines ("===" -> h1, "---" -> h2)
 *  - paragraphs: consecutive non-blank prose lines; the first paragraph with 3+ words is the opening
 *  - lists ("-", "*", "+", "1."), blockquotes (">"), fenced code (``` / ~~~, excluded from flag scans)
 *  - tables: a pipe row followed by a separator row ("| --- | --- |")
 *  - links: [text](url), [text][ref] + "[ref]: url", <https://...>, and bare http(s) URLs; relative and
 *    same-host links are internal, other http(s) hosts are outbound
 *  - images: ![alt](src) (empty alt = missing alt text)
 * HTML (when the paste is clearly HTML markup): the crawler's own extractor (seo/crawl/extract.ts) over a
 * synthetic URL on the project host, plus a text-block pass for the flag scan.
 *
 * The draft is the user's own text, but it is still treated as data: nothing in it is executed or
 * followed, and it is rendered as plain text.
 */
import { Parser } from "htmlparser2";
import { CAPS, countWords, extractPage, isGenericAnchorText } from "../seo/crawl/extract";

export type BlockKind = "heading" | "paragraph" | "list" | "quote" | "table" | "code";

export interface DraftBlock {
  kind: BlockKind;
  /** Plain text (markdown syntax removed; quote blocks keep their line breaks). */
  text: string;
  /** The block contains a link, URL, or citation marker (used to treat its claims as sourced). */
  hasSource: boolean;
}

export interface DraftLink {
  href: string;
  text: string;
  internal: boolean;
}

export interface DraftDoc {
  format: "markdown" | "html";
  blocks: DraftBlock[];
  headings: Array<{ level: number; text: string }>;
  h1s: string[];
  firstParagraph: string | null;
  /** Full plain text (headings and body), newline-separated blocks. */
  text: string;
  wordCount: number;
  tableCount: number;
  links: DraftLink[];
  /** Distinct internal link targets (absolute URLs on the project host). */
  internalLinks: string[];
  /** Distinct outbound (other-host) http(s) URLs. */
  outboundLinks: string[];
  genericAnchors: Array<{ href: string; text: string }>;
  imagesTotal: number;
  imagesMissingAlt: number;
  /** HTML drafts only: head fields found in the markup. */
  html: { title: string | null; metaDescription: string | null; robotsMeta: string | null; canonical: string | null; jsonLdTypes: string[]; author: string | null } | null;
}

export const MAX_DRAFT_CHARS = 60_000;
const MAX_HEADINGS = 60;

const collapse = (s: string) => s.replace(/[ \t\f\v ]+/g, " ").trim();
const stripWww = (h: string) => h.toLowerCase().replace(/\.$/, "").replace(/^www\./, "");

/** Citation markers that make a sentence "sourced": [1], [^1], (Source: ...), "Source: ...". */
const CITATION_RE = /\[\^?\d{1,3}\]|\(\s*sources?\s*:|(?:^|\s)sources?\s*:\s*\S|\bhttps?:\/\/\S/i;

// ------------------------------------------------------------------ HTML detection
const HTML_TAG_RE = /<\/?(?:p|h[1-6]|div|article|section|main|ul|ol|li|table|tr|td|a|img|br|strong|em|span|blockquote|html|body|head)\b[^>]*>/gi;

export function looksLikeHtml(text: string): boolean {
  const n = (text.match(HTML_TAG_RE) ?? []).length;
  return n >= 3 && (/^\s*</.test(text) || /<\/(?:p|h[1-6]|div|li)>/i.test(text));
}

// ------------------------------------------------------------------ link classification
function classifyHref(raw: string, base: URL): { href: string; internal: boolean } | null {
  const h = raw.trim().replace(/^<|>$/g, "");
  if (!h || h.startsWith("#") || /^(javascript|mailto|tel|data|sms|ftp):/i.test(h)) return null;
  let u: URL;
  try {
    u = new URL(h, base);
  } catch {
    return null;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  u.hash = "";
  return { href: u.toString(), internal: stripWww(u.hostname) === stripWww(base.hostname) };
}

// ------------------------------------------------------------------ markdown inline processing
interface InlineResult {
  text: string;
  links: DraftLink[];
  images: number;
  imagesMissingAlt: number;
}

const IMAGE_RE = /!\[([^\]]*)\]\(\s*<?([^)\s>]+)>?(?:\s+["'(][^)]*["')])?\s*\)/g;
const LINK_RE = /\[([^\]]+)\]\(\s*<?([^)\s>]+)>?(?:\s+["'(][^)]*["')])?\s*\)/g;
const REF_LINK_RE = /\[([^\]]+)\]\[([^\]]*)\]/g;
const AUTOLINK_RE = /<(https?:\/\/[^>\s]+)>/gi;
const BARE_URL_RE = /(?<![("'<\]])\bhttps?:\/\/[^\s<>()\]]+/gi;

function inline(raw: string, base: URL, refs: Map<string, string>): InlineResult {
  const links: DraftLink[] = [];
  let images = 0;
  let imagesMissingAlt = 0;
  const addLink = (href: string, text: string) => {
    const c = classifyHref(href, base);
    if (c) links.push({ href: c.href, text: collapse(text), internal: c.internal });
  };
  let t = raw.replace(IMAGE_RE, (_m, alt: string) => {
    images++;
    if (!alt.trim()) imagesMissingAlt++;
    return " ";
  });
  t = t.replace(LINK_RE, (_m, text: string, href: string) => {
    addLink(href, text);
    return text;
  });
  t = t.replace(REF_LINK_RE, (m, text: string, ref: string) => {
    const href = refs.get((ref || text).trim().toLowerCase());
    if (!href) return m;
    addLink(href, text);
    return text;
  });
  t = t.replace(AUTOLINK_RE, (_m, href: string) => {
    addLink(href, href);
    return href;
  });
  for (const m of t.matchAll(BARE_URL_RE)) {
    const href = m[0].replace(/[.,;:!?]+$/, "");
    if (!links.some((l) => l.text === href)) addLink(href, href);
  }
  t = t
    .replace(/`([^`]+)`/g, "$1")
    .replace(/(\*\*|__)(?=\S)([\s\S]*?\S)\1/g, "$2")
    .replace(/(?<![\p{L}\p{N}*_])([*_])(?=\S)([^*_\n]*?\S)\1(?![\p{L}\p{N}*_])/gu, "$2")
    .replace(/~~(?=\S)([\s\S]*?\S)~~/g, "$1")
    .replace(/<\/?[a-z][a-z0-9]*(?:\s[^<>]*)?\/?>/gi, " ");
  return { text: t, links, images, imagesMissingAlt };
}

// ------------------------------------------------------------------ markdown block parsing
const ATX_RE = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;
const FENCE_RE = /^\s{0,3}(```|~~~)/;
const LIST_RE = /^\s*(?:[-*+]|\d{1,3}[.)])\s+(.*)$/;
const QUOTE_RE = /^\s{0,3}>\s?(.*)$/;
const TABLE_SEP_RE = /^\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)*\|?\s*$/;
const REF_DEF_RE = /^\s{0,3}\[([^\]]+)\]:\s*<?(\S+?)>?(?:\s+["'(].*["')])?\s*$/;
const HR_RE = /^\s{0,3}(?:(?:-\s*){3,}|(?:\*\s*){3,}|(?:_\s*){3,})$/;
const IMAGE_ONLY_RE = /^\s*(?:!\[[^\]]*\]\([^)]*\)\s*)+$/;

function tableCells(line: string): string {
  return line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((c) => c.trim())
    .filter(Boolean)
    .join(" | ");
}

function parseMarkdown(raw: string, base: URL): DraftDoc {
  const lines = raw.replace(/\r\n?/g, "\n").split("\n");
  const refs = new Map<string, string>();
  for (const l of lines) {
    const m = REF_DEF_RE.exec(l);
    if (m) refs.set(m[1]!.trim().toLowerCase(), m[2]!);
  }

  const blocks: DraftBlock[] = [];
  const headings: Array<{ level: number; text: string }> = [];
  const links: DraftLink[] = [];
  let images = 0;
  let imagesMissingAlt = 0;
  let tableCount = 0;

  const push = (kind: BlockKind, rawText: string, keepLines = false) => {
    const r = kind === "code" ? { text: rawText, links: [], images: 0, imagesMissingAlt: 0 } : inline(rawText, base, refs);
    images += r.images;
    imagesMissingAlt += r.imagesMissingAlt;
    links.push(...r.links);
    const text = keepLines ? r.text.split("\n").map(collapse).filter(Boolean).join("\n") : collapse(r.text.replace(/\n/g, " "));
    if (!text) return;
    blocks.push({ kind, text, hasSource: r.links.length > 0 || CITATION_RE.test(rawText) });
  };

  let para: string[] = [];
  let quote: string[] = [];
  const flushPara = () => {
    if (para.length) push("paragraph", para.join("\n"));
    para = [];
  };
  const flushQuote = () => {
    if (quote.length) push("quote", quote.join("\n"), true);
    quote = [];
  };
  const heading = (level: number, rawText: string) => {
    const r = inline(rawText, base, refs);
    links.push(...r.links);
    const text = collapse(r.text);
    if (!text) return;
    if (headings.length < MAX_HEADINGS) headings.push({ level, text });
    blocks.push({ kind: "heading", text, hasSource: r.links.length > 0 });
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (REF_DEF_RE.test(line)) {
      flushPara();
      flushQuote();
      continue;
    }
    if (FENCE_RE.test(line)) {
      flushPara();
      flushQuote();
      const fence = FENCE_RE.exec(line)![1]!;
      const code: string[] = [];
      i++;
      while (i < lines.length && !lines[i]!.trimStart().startsWith(fence)) code.push(lines[i++]!);
      push("code", code.join("\n"), true);
      continue;
    }
    if (!line.trim()) {
      flushPara();
      flushQuote();
      continue;
    }
    const q = QUOTE_RE.exec(line);
    if (q) {
      flushPara();
      quote.push(q[1]!);
      continue;
    }
    flushQuote();
    const atx = ATX_RE.exec(line);
    if (atx) {
      flushPara();
      heading(atx[1]!.length, atx[2]!);
      continue;
    }
    // Setext: a single prose line underlined with === (h1) or --- (h2).
    if (para.length === 1 && /^\s{0,3}=+\s*$/.test(line)) {
      heading(1, para[0]!);
      para = [];
      continue;
    }
    if (para.length === 1 && /^\s{0,3}-+\s*$/.test(line) && !LIST_RE.test(para[0]!)) {
      heading(2, para[0]!);
      para = [];
      continue;
    }
    if (HR_RE.test(line)) {
      flushPara();
      continue;
    }
    if (line.includes("|") && i + 1 < lines.length && TABLE_SEP_RE.test(lines[i + 1]!) && lines[i + 1]!.includes("-")) {
      flushPara();
      tableCount++;
      const rows = [tableCells(line)];
      i += 2;
      while (i < lines.length && lines[i]!.includes("|") && lines[i]!.trim()) rows.push(tableCells(lines[i++]!));
      i--;
      push("table", rows.join("\n"), true);
      continue;
    }
    const li = LIST_RE.exec(line);
    if (li) {
      flushPara();
      push("list", li[1]!);
      continue;
    }
    if (IMAGE_ONLY_RE.test(line)) {
      flushPara();
      const r = inline(line, base, refs);
      images += r.images;
      imagesMissingAlt += r.imagesMissingAlt;
      continue;
    }
    para.push(line);
  }
  flushPara();
  flushQuote();

  return finish("markdown", blocks, headings, links, { tableCount, images, imagesMissingAlt }, null);
}

// ------------------------------------------------------------------ HTML drafts
const HTML_BLOCK_TAGS = new Set(["p", "div", "section", "article", "main", "li", "ul", "ol", "br", "tr", "table", "h1", "h2", "h3", "h4", "h5", "h6", "blockquote", "pre", "dd", "dt", "figcaption", "header", "footer"]);
const HTML_SKIP_TAGS = new Set(["script", "style", "noscript", "template", "svg", "iframe", "object", "canvas", "head", "title"]);

function htmlBlocks(html: string): Array<{ kind: BlockKind; text: string; hasSource: boolean }> {
  const out: Array<{ kind: BlockKind; text: string; hasSource: boolean }> = [];
  let buf = "";
  let kind: BlockKind = "paragraph";
  let hasSource = false;
  let skip = 0;
  const kindStack: BlockKind[] = [];
  const flush = () => {
    const t = collapse(buf.replace(/\s+/g, " "));
    if (t) out.push({ kind, text: t, hasSource: hasSource || CITATION_RE.test(t) });
    buf = "";
    hasSource = false;
  };
  const kindFor = (name: string): BlockKind | null =>
    /^h[1-6]$/.test(name) ? "heading" : name === "li" ? "list" : name === "blockquote" ? "quote" : name === "pre" ? "code" : name === "table" ? "table" : null;
  const parser = new Parser(
    {
      onopentag(name, attrs) {
        if (HTML_SKIP_TAGS.has(name)) {
          skip++;
          return;
        }
        if (skip) return;
        if (HTML_BLOCK_TAGS.has(name)) {
          flush();
          const k = kindFor(name);
          if (k) kindStack.push(k);
          kind = kindStack[kindStack.length - 1] ?? "paragraph";
        }
        if (name === "a" && /^https?:\/\//i.test(attrs.href ?? "")) hasSource = true;
        if (name === "sup") buf += " ";
      },
      ontext(text) {
        if (!skip) buf += text;
      },
      onclosetag(name) {
        if (HTML_SKIP_TAGS.has(name)) {
          if (skip) skip--;
          return;
        }
        if (skip) return;
        if (HTML_BLOCK_TAGS.has(name)) {
          flush();
          if (kindFor(name)) kindStack.pop();
          kind = kindStack[kindStack.length - 1] ?? "paragraph";
        }
      },
    },
    { decodeEntities: true, lowerCaseTags: true, lowerCaseAttributeNames: true },
  );
  parser.write(html);
  parser.end();
  flush();
  return out;
}

/** The crawler's extractor reads text, images, and paragraphs inside <body> only: wrap fragments. */
function withBody(html: string): string {
  if (/<body[\s>]/i.test(html)) return html;
  if (/<\/head>/i.test(html)) return html.replace(/<\/head>/i, "</head><body>");
  return `<body>${html}</body>`;
}

function parseHtml(html: string, base: URL): DraftDoc {
  const ex = extractPage(withBody(html), base.toString());
  const blocks = htmlBlocks(html);
  // Anchors (all <a href>) for the internal/outbound split and generic-anchor detection.
  const links: DraftLink[] = [];
  let currentHref: string | null = null;
  let anchorText = "";
  const parser = new Parser(
    {
      onopentag(name, attrs) {
        if (name === "a" && attrs.href) {
          currentHref = attrs.href;
          anchorText = "";
        }
      },
      ontext(text) {
        if (currentHref !== null) anchorText += text;
      },
      onclosetag(name) {
        if (name === "a" && currentHref !== null) {
          const c = classifyHref(currentHref, base);
          if (c) links.push({ href: c.href, text: collapse(anchorText), internal: c.internal });
          currentHref = null;
        }
      },
    },
    { decodeEntities: true, lowerCaseTags: true, lowerCaseAttributeNames: true },
  );
  parser.write(html);
  parser.end();
  const doc = finish(
    "html",
    blocks,
    ex.headings.map((h) => ({ level: h.level, text: h.text })),
    links,
    { tableCount: ex.tableCount, images: ex.imagesTotal, imagesMissingAlt: ex.imagesMissingAlt },
    { title: ex.title, metaDescription: ex.metaDescription, robotsMeta: ex.metaRobots, canonical: ex.canonical, jsonLdTypes: ex.jsonLdTypes, author: ex.author },
  );
  // The crawler's extractor defines the opening paragraph and word count for HTML.
  return { ...doc, firstParagraph: ex.firstParagraph ?? doc.firstParagraph, wordCount: ex.wordCount || doc.wordCount };
}

// ------------------------------------------------------------------ assembly
function finish(
  format: DraftDoc["format"],
  blocks: DraftBlock[],
  headings: Array<{ level: number; text: string }>,
  links: DraftLink[],
  counts: { tableCount: number; images: number; imagesMissingAlt: number },
  html: DraftDoc["html"],
): DraftDoc {
  const firstPara = blocks.find((b) => b.kind === "paragraph" && countWords(b.text) >= 3)?.text ?? null;
  const text = blocks.map((b) => b.text).join("\n");
  const internal = [...new Set(links.filter((l) => l.internal).map((l) => l.href))];
  const outbound = [...new Set(links.filter((l) => !l.internal).map((l) => l.href))];
  const generic = links.filter((l) => l.internal && isGenericAnchorText(l.text)).map((l) => ({ href: l.href, text: l.text.slice(0, CAPS.anchorText) }));
  return {
    format,
    blocks,
    headings: headings.slice(0, MAX_HEADINGS),
    h1s: headings.filter((h) => h.level === 1).map((h) => h.text),
    firstParagraph: firstPara ? firstPara.slice(0, CAPS.firstParagraph) : null,
    text,
    wordCount: countWords(blocks.map((b) => b.text).join(" ")),
    tableCount: counts.tableCount,
    links,
    internalLinks: internal,
    outboundLinks: outbound,
    genericAnchors: generic.slice(0, CAPS.genericAnchors),
    imagesTotal: counts.images,
    imagesMissingAlt: counts.imagesMissingAlt,
    html,
  };
}

/**
 * Parse a draft. `baseUrl` is a synthetic URL on the project host: relative links resolve against it, and
 * links on that host (with or without www.) count as internal.
 */
export function parseDraft(text: string, baseUrl: string): DraftDoc {
  const base = new URL(baseUrl);
  const raw = text.slice(0, MAX_DRAFT_CHARS);
  return looksLikeHtml(raw) ? parseHtml(raw, base) : parseMarkdown(raw, base);
}
