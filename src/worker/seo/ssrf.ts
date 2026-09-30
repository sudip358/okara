/**
 * SSRF guard for every crawler fetch (pages, robots.txt, sitemaps, sitemap-index children, llms.txt).
 *
 * Controls (build kit "WORKFLOWS, BUDGETS, AND SAFETY" + [A20]):
 *  - https only; no userinfo; default port only.
 *  - The request host must equal the project's verified host exactly (case-insensitive, trailing dot
 *    stripped). This allowlist is the primary control.
 *  - IP-literal hosts in private, loopback, link-local, CGNAT, metadata, ULA, v4-mapped, unspecified,
 *    documentation, multicast, and reserved ranges are refused, including decimal/octal/hex IPv4 forms.
 *  - redirect: "manual"; every hop is re-validated with the same rules (same verified host only) and
 *    hops are capped (default 5).
 *  - An AbortSignal timeout covers connect + headers + body.
 *  - Bodies are streamed through a reader and the read is cancelled as soon as the byte cap is
 *    exceeded; the full body is never buffered before the cap check.
 *  - Only allowlisted content types are read (text/html for pages; text/plain / XML for robots and
 *    sitemaps).
 *
 * DNS rebinding: Cloudflare Workers do not expose DNS resolution to user code, so a resolve-then-pin
 * check is not possible here. The verified-host allowlist is therefore the primary control: only the
 * single verified public hostname is ever requested, and fetches from Workers to private/internal
 * addresses are not routable (Workers egress is the public internet). A rebinding attacker can at most
 * point the verified host's own DNS at another public address; they cannot make us request an
 * arbitrary host or an internal service. Tests run the same guard in Node with a fake fetch.
 */

export type CrawlFetchErrorCode =
  | "blocked_url" // scheme/userinfo/port/IP-range/host allowlist violation on the initial URL
  | "redirect_offsite" // a redirect hop left the verified host or hit a blocked address
  | "too_many_redirects"
  | "too_large"
  | "timeout"
  | "non_html" // disallowed content type on a 2xx response
  | "error"; // network or other failure

export class CrawlFetchError extends Error {
  constructor(
    public readonly code: CrawlFetchErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "CrawlFetchError";
  }
}

// ---------------------------------------------------------------------------------------------- hosts

/** Lowercase, strip IPv6 brackets and a single trailing dot. */
export function normalizeHost(host: string): string {
  let h = host.trim().toLowerCase();
  if (h.startsWith("[") && h.endsWith("]")) h = h.slice(1, -1);
  while (h.endsWith(".")) h = h.slice(0, -1);
  return h;
}

const LOCAL_SUFFIXES = [".localhost", ".local", ".internal", ".lan", ".home.arpa", ".intranet", ".corp"];

/**
 * Parse an IPv4 address the way inet_aton / the WHATWG URL parser does: 1-4 dot-separated parts,
 * each decimal, octal (leading 0) or hex (0x). Returns the 32-bit value, or null if not IPv4-like.
 */
export function parseIPv4Loose(host: string): number | null {
  const h = host.endsWith(".") ? host.slice(0, -1) : host;
  const parts = h.split(".");
  if (parts.length < 1 || parts.length > 4) return null;
  const nums: number[] = [];
  for (const p of parts) {
    if (p === "") return null;
    let n: number;
    if (/^0x[0-9a-f]*$/i.test(p)) n = p.length === 2 ? 0 : parseInt(p.slice(2), 16);
    else if (/^0[0-7]+$/.test(p)) n = parseInt(p.slice(1), 8);
    else if (/^(0|[1-9][0-9]*)$/.test(p)) n = parseInt(p, 10);
    else return null;
    if (!Number.isFinite(n)) return null;
    nums.push(n);
  }
  const last = nums.pop()!;
  for (const n of nums) if (n > 255) return null;
  const remainingBytes = 4 - nums.length;
  if (last >= 2 ** (8 * remainingBytes)) return null;
  let value = 0;
  nums.forEach((n, i) => {
    value += n * 2 ** (8 * (3 - i));
  });
  return value + last;
}

/** Parse an IPv6 literal (no brackets) into 8 16-bit groups. Zone ids are refused (null). */
export function parseIPv6(host: string): number[] | null {
  if (!host.includes(":") || host.includes("%")) return null;
  let h = host;
  // Embedded IPv4 tail (e.g. ::ffff:127.0.0.1)
  let tail: number[] = [];
  const lastColon = h.lastIndexOf(":");
  const maybeV4 = h.slice(lastColon + 1);
  if (maybeV4.includes(".")) {
    if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(maybeV4)) return null;
    const o = maybeV4.split(".").map(Number);
    if (o.some((x) => x > 255)) return null;
    tail = [(o[0]! << 8) | o[1]!, (o[2]! << 8) | o[3]!];
    h = h.slice(0, lastColon + 1) + "0:0";
  }
  const dbl = h.split("::");
  if (dbl.length > 2) return null;
  const parseGroups = (s: string) => (s === "" ? [] : s.split(":"));
  const head = parseGroups(dbl[0]!);
  const rest = dbl.length === 2 ? parseGroups(dbl[1]!) : [];
  const all = [...head, ...rest];
  if (all.some((g) => !/^[0-9a-f]{1,4}$/i.test(g))) return null;
  let groups: number[];
  if (dbl.length === 2) {
    const missing = 8 - head.length - rest.length;
    if (missing < 1) return null;
    groups = [...head.map((g) => parseInt(g, 16)), ...new Array<number>(missing).fill(0), ...rest.map((g) => parseInt(g, 16))];
  } else {
    if (head.length !== 8) return null;
    groups = head.map((g) => parseInt(g, 16));
  }
  if (tail.length === 2) {
    groups[6] = tail[0]!;
    groups[7] = tail[1]!;
  }
  return groups;
}

const V4_BLOCKS: Array<[string, number]> = [
  ["0.0.0.0", 8], // "this network" / unspecified
  ["10.0.0.0", 8], // private
  ["100.64.0.0", 10], // CGNAT
  ["127.0.0.0", 8], // loopback
  ["169.254.0.0", 16], // link-local incl. 169.254.169.254 metadata
  ["172.16.0.0", 12], // private
  ["192.0.0.0", 24], // IETF protocol assignments
  ["192.0.2.0", 24], // TEST-NET-1 documentation
  ["192.88.99.0", 24], // 6to4 relay anycast (deprecated)
  ["192.168.0.0", 16], // private
  ["198.18.0.0", 15], // benchmarking
  ["198.51.100.0", 24], // TEST-NET-2
  ["203.0.113.0", 24], // TEST-NET-3
  ["224.0.0.0", 4], // multicast
  ["240.0.0.0", 4], // reserved + broadcast
];

function v4InBlock(ip: number, base: string, bits: number): boolean {
  const b = parseIPv4Loose(base)!;
  const size = 2 ** (32 - bits);
  return Math.floor(ip / size) === Math.floor(b / size);
}

export function isBlockedIPv4(ip: number): boolean {
  return V4_BLOCKS.some(([base, bits]) => v4InBlock(ip, base, bits));
}

export function isBlockedIPv6(g: number[]): boolean {
  const [g0, g1, g2, g3, g4, g5] = g as [number, number, number, number, number, number, number, number];
  const allZeroPrefix = g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0;
  if (allZeroPrefix && g5 === 0) return true; // :: unspecified, ::1 loopback, ::/96 v4-compatible (deprecated)
  if (allZeroPrefix && g5 === 0xffff) return true; // ::ffff:0:0/96 v4-mapped
  if (g0 === 0x64 && g1 === 0xff9b) return true; // 64:ff9b::/96 NAT64 (embeds v4)
  if (g0 === 0x100 && g1 === 0 && g2 === 0 && g3 === 0) return true; // 100::/64 discard
  if (g0 === 0x2001 && g1 < 0x200) return true; // 2001::/23 IETF protocol assignments (incl. Teredo)
  if (g0 === 0x2001 && g1 === 0xdb8) return true; // 2001:db8::/32 documentation
  if (g0 === 0x2002) return true; // 6to4 (can embed private v4)
  if (g0 === 0x3fff && g1 < 0x1000) return true; // 3fff::/20 documentation
  if ((g0 & 0xfe00) === 0xfc00) return true; // fc00::/7 ULA
  if ((g0 & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
  if ((g0 & 0xffc0) === 0xfec0) return true; // fec0::/10 site-local (deprecated)
  if ((g0 & 0xff00) === 0xff00) return true; // ff00::/8 multicast
  return false;
}

/** Classify a hostname: 'ipv4' / 'ipv6' literal (with blocked flag) or 'name'. */
export function classifyHost(host: string): { kind: "ipv4" | "ipv6"; blocked: boolean } | { kind: "name" } {
  const h = normalizeHost(host);
  const v6 = parseIPv6(h);
  if (v6) return { kind: "ipv6", blocked: isBlockedIPv6(v6) };
  if (host.includes(":")) return { kind: "ipv6", blocked: true }; // unparseable v6-ish literal: fail closed
  const v4 = parseIPv4Loose(h);
  if (v4 !== null) return { kind: "ipv4", blocked: isBlockedIPv4(v4) };
  return { kind: "name" };
}

function isLocalName(h: string): boolean {
  return h === "localhost" || !h.includes(".") || LOCAL_SUFFIXES.some((s) => h.endsWith(s));
}

/**
 * Validate a crawl URL. Returns the parsed URL (hash stripped) or throws CrawlFetchError('blocked_url').
 * The WHATWG URL parser already canonicalizes decimal/octal/hex IPv4 hosts (e.g. 2130706433 ->
 * 127.0.0.1); we additionally parse loosely so exotic encodings never slip through as "names".
 */
export function assertCrawlableUrl(input: string | URL, verifiedHost: string): URL {
  let url: URL;
  try {
    url = new URL(String(input));
  } catch {
    throw new CrawlFetchError("blocked_url", "Invalid URL.");
  }
  if (url.protocol !== "https:") throw new CrawlFetchError("blocked_url", "Only https URLs are crawled.");
  if (url.username || url.password) throw new CrawlFetchError("blocked_url", "URLs with credentials are refused.");
  if (url.port !== "") throw new CrawlFetchError("blocked_url", "Non-default ports are refused.");
  const host = normalizeHost(url.hostname);
  const cls = classifyHost(host);
  if (cls.kind !== "name" && cls.blocked) throw new CrawlFetchError("blocked_url", "Private, reserved, or metadata addresses are refused.");
  const allowed = normalizeHost(verifiedHost);
  if (!allowed || (classifyHost(allowed).kind === "name" && isLocalName(allowed))) {
    throw new CrawlFetchError("blocked_url", "Verified host is not a public hostname.");
  }
  if (cls.kind === "name" && isLocalName(host)) throw new CrawlFetchError("blocked_url", "Local hostnames are refused.");
  if (host !== allowed) throw new CrawlFetchError("blocked_url", "Host is not the verified host.");
  url.hash = "";
  return url;
}

// ---------------------------------------------------------------------------------------------- fetch

export type ContentKind = "html" | "robots" | "sitemap" | "llms";

const CONTENT_TYPES: Record<ContentKind, string[]> = {
  html: ["text/html", "application/xhtml+xml"],
  robots: ["text/plain"],
  sitemap: ["application/xml", "text/xml", "text/plain", "application/rss+xml", "application/atom+xml"],
  llms: ["text/plain", "text/markdown", "text/x-markdown"],
};

export interface GuardedFetchOptions {
  verifiedHost: string;
  maxBytes: number;
  timeoutMs: number;
  maxRedirects?: number;
  /** Which content types are readable for a 2xx response. Default 'html'. */
  kind?: ContentKind;
  userAgent?: string;
  /** robots.txt may be served with a missing/odd content type; allow any text-like body. */
  lenientContentType?: boolean;
  /**
   * robots.txt only (RFC 9309 2.5: parse at least 500 KiB): stop reading at the cap and return the
   * truncated prefix instead of failing. The reader is still cancelled at the cap.
   */
  truncateAtCap?: boolean;
}

export interface GuardedResponse {
  /** Requested URL. */
  url: string;
  /** Final URL after same-host redirects. */
  finalUrl: string;
  status: number;
  contentType: string | null;
  headers: Headers;
  /** Decoded body for readable 2xx responses; '' otherwise (body cancelled, never read). */
  body: string;
  bytes: number;
  redirects: string[];
  truncated: boolean;
}

const REDIRECTS = new Set([301, 302, 303, 307, 308]);

function mediaType(ct: string | null): string {
  return (ct ?? "").split(";")[0]!.trim().toLowerCase();
}

async function cancelBody(res: Response) {
  try {
    await res.body?.cancel();
  } catch {
    /* ignore */
  }
}

/**
 * Fetch a URL on the verified host with the full guard. `fetchImpl` is ctx.crawlFetch (or a test
 * fake); it is always called with redirect: "manual".
 */
export async function guardedFetch(fetchImpl: typeof fetch, url: string, opts: GuardedFetchOptions): Promise<GuardedResponse> {
  const maxRedirects = opts.maxRedirects ?? 5;
  const kind = opts.kind ?? "html";
  const controller = new AbortController();
  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const abortPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
      reject(new CrawlFetchError("timeout", `Timed out after ${opts.timeoutMs} ms.`));
    }, opts.timeoutMs);
  });
  abortPromise.catch(() => undefined);

  try {
    let current = assertCrawlableUrl(url, opts.verifiedHost);
    const redirects: string[] = [];
    for (let hop = 0; ; hop++) {
      let res: Response;
      try {
        res = await Promise.race([
          fetchImpl(current.toString(), {
            method: "GET",
            redirect: "manual",
            signal: controller.signal,
            headers: {
              ...(opts.userAgent ? { "User-Agent": opts.userAgent } : {}),
              Accept: CONTENT_TYPES[kind].join(", ") + ";q=1.0, */*;q=0.1",
            },
          }),
          abortPromise,
        ]);
      } catch (e) {
        if (e instanceof CrawlFetchError) throw e;
        if (timedOut) throw new CrawlFetchError("timeout", `Timed out after ${opts.timeoutMs} ms.`);
        throw new CrawlFetchError("error", "Network error.");
      }

      if (REDIRECTS.has(res.status)) {
        const loc = res.headers.get("location");
        await cancelBody(res);
        if (!loc) throw new CrawlFetchError("error", `Redirect ${res.status} without Location.`);
        if (hop + 1 > maxRedirects) throw new CrawlFetchError("too_many_redirects", `More than ${maxRedirects} redirects.`);
        let next: URL;
        try {
          next = assertCrawlableUrl(new URL(loc, current), opts.verifiedHost);
        } catch (e) {
          throw new CrawlFetchError("redirect_offsite", `Redirect hop ${hop + 1} refused: ${(e as Error).message}`);
        }
        redirects.push(next.toString());
        current = next;
        continue;
      }

      const contentType = res.headers.get("content-type");
      const base: Omit<GuardedResponse, "body" | "bytes" | "truncated"> = {
        url,
        finalUrl: current.toString(),
        status: res.status,
        contentType,
        headers: res.headers,
        redirects,
      };
      if (res.status < 200 || res.status >= 300) {
        await cancelBody(res);
        return { ...base, body: "", bytes: 0, truncated: false };
      }
      const mt = mediaType(contentType);
      const typeOk = CONTENT_TYPES[kind].includes(mt) || (opts.lenientContentType && (mt === "" || mt.startsWith("text/")));
      if (!typeOk) {
        await cancelBody(res);
        throw new CrawlFetchError("non_html", `Content type ${mt || "(none)"} is not crawled.`);
      }
      const declared = Number(res.headers.get("content-length"));
      if (Number.isFinite(declared) && declared > opts.maxBytes && !opts.truncateAtCap) {
        await cancelBody(res);
        throw new CrawlFetchError("too_large", `Declared size ${declared} exceeds ${opts.maxBytes} bytes.`);
      }
      const { text, bytes, truncated } = await readCapped(res, opts.maxBytes, abortPromise, opts.truncateAtCap ?? false);
      return { ...base, body: text, bytes, truncated };
    }
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Stream the body, cancelling the reader as soon as the cap is exceeded. */
async function readCapped(
  res: Response,
  maxBytes: number,
  abortPromise: Promise<never>,
  truncate: boolean,
): Promise<{ text: string; bytes: number; truncated: boolean }> {
  if (!res.body) return { text: "", bytes: 0, truncated: false };
  const reader = res.body.getReader();
  const decoder = new TextDecoder("utf-8");
  let bytes = 0;
  let text = "";
  try {
    for (;;) {
      const { done, value } = await Promise.race([reader.read(), abortPromise]);
      if (done) break;
      if (bytes + value.byteLength > maxBytes) {
        await reader.cancel("size cap exceeded").catch(() => undefined);
        if (truncate) {
          text += decoder.decode(value.subarray(0, maxBytes - bytes));
          return { text, bytes: maxBytes, truncated: true };
        }
        throw new CrawlFetchError("too_large", `Body exceeded ${maxBytes} bytes.`);
      }
      bytes += value.byteLength;
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
    return { text, bytes, truncated: false };
  } catch (e) {
    await reader.cancel().catch(() => undefined);
    if (e instanceof CrawlFetchError) throw e;
    throw new CrawlFetchError("error", "Body read failed.");
  } finally {
    try {
      reader.releaseLock();
    } catch {
      /* ignore */
    }
  }
}
