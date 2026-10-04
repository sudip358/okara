/**
 * Tracked competitors: the shared cap and the domain cleaning rules used by the Worker (authoritative: project
 * schema, import destination) and the web (project form, import preview). Pure functions, no I/O.
 *
 * [A39] (owner request 2026-10-04 "add competitors data from sheet"): the cap is 60 tracked competitors per project
 * (one constant for worker and web). Everything that scales with the competitor count is bounded elsewhere: GEO
 * detection asks Jev only about brands actually found in an answer (src/worker/geo/analyze.ts), AI request states
 * carry at most a few competitor names (most relevant first, with a note), reads are bounded, and DataForSEO
 * auto-fetch is spread over days by the daily cap (src/worker/competitors/dataforseo.ts).
 *
 * Domain cleaning (cleanCompetitorDomain), in this order:
 *   1. trim; empty -> no domain; whitespace inside -> "not a domain name";
 *   2. URL -> hostname: a scheme other than http(s), credentials or a port -> skipped with the reason;
 *      a path, query or fragment beyond "/" is dropped and the domain is noted "from a page URL";
 *   3. lowercase (the URL API also punycodes IDNs), trailing dot removed, a leading "www." removed;
 *   4. not a public DNS name (IP literal, localhost / .local / .internal ..., single label, bad label) -> skipped;
 *   5. a host starting with "ww." or "wwww." (or more w's) is a LIKELY TYPO: the suggestion drops that label
 *      ("ww.lumens.com" -> "lumens.com"). It is never applied silently: the owner accepts it in the preview.
 * Callers then dedupe on the cleaned domain, skip the project's own domain, and group a subdomain under a listed
 * parent domain (parentDomainIn) as an extra domain of the parent's competitor.
 */

/** Tracked competitors per project (worker schema, web form, import room). */
export const MAX_COMPETITORS = 60;
/** Domains per competitor (worker schema and web form). */
export const MAX_COMPETITOR_DOMAINS = 5;
/** Aliases per competitor. */
export const MAX_COMPETITOR_ALIASES = 10;

const BLOCKED_SUFFIXES = [".localhost", ".local", ".internal", ".lan", ".home.arpa", ".onion"];

/** A public-looking DNS hostname: no IP literal, no local names, at least two valid labels. */
export function isPublicHostname(host: string): boolean {
  if (!host || host.length > 253) return false;
  if (host.startsWith("[") || /^\d+(\.\d+){3}$/.test(host) || /^[0-9.]+$/.test(host)) return false; // IP literals
  if (host === "localhost" || BLOCKED_SUFFIXES.some((s) => host.endsWith(s))) return false;
  const labels = host.split(".");
  if (labels.length < 2) return false;
  return labels.every((l) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(l));
}

export type CleanedDomain =
  | {
      ok: true;
      /** Cleaned hostname: lowercase, no scheme, no "www.", no path. */
      domain: string;
      /** The cell was a page URL (path/query dropped). */
      fromPage: boolean;
      /** Likely typo ("ww." / "wwww." prefix): the suggested domain, never applied without the owner's consent. */
      typoOf: string | null;
    }
  | { ok: false; reason: string };

const SCHEME = /^[a-z][a-z0-9+.-]*:\/\//i;

/** Suggested domain for a likely "www" typo ("ww.lumens.com" / "wwww.lumens.com" -> "lumens.com"); null otherwise. */
export function wwwTypoSuggestion(host: string): string | null {
  const m = /^(w{2}|w{4,})\.(.+)$/.exec(host);
  if (!m) return null;
  const rest = m[2]!;
  return isPublicHostname(rest) ? rest : null;
}

/** Clean one competitor domain cell (see the module header for the rules). */
export function cleanCompetitorDomain(raw: string): CleanedDomain {
  const s = (raw ?? "").trim();
  if (!s) return { ok: false, reason: "empty" };
  if (/\s/.test(s)) return { ok: false, reason: "not a domain name" };
  const withScheme = SCHEME.test(s) ? s : `https://${s}`;
  let u: URL;
  try {
    u = new URL(withScheme);
  } catch {
    return { ok: false, reason: "not a domain name" };
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") return { ok: false, reason: "not a web address (only http/https)" };
  if (u.username || u.password) return { ok: false, reason: "contains a user name or password" };
  if (u.port) return { ok: false, reason: "contains a port" };
  let host = u.hostname.toLowerCase().replace(/\.$/, "");
  if (host.startsWith("www.")) host = host.slice(4);
  if (!isPublicHostname(host)) return { ok: false, reason: "not a public domain name (IP addresses and local names are not tracked)" };
  const fromPage = (u.pathname !== "/" && u.pathname !== "") || u.search !== "" || u.hash !== "";
  return { ok: true, domain: host, fromPage, typoOf: wwwTypoSuggestion(host) };
}

/** True when `host` is `parent` or a subdomain of it. */
export const isSameOrSubdomain = (host: string, parent: string) => host === parent || host.endsWith(`.${parent}`);

/** The longest listed domain that `host` is a strict subdomain of ("the-edit.lumens.com" -> "lumens.com"); null otherwise. */
export function parentDomainIn(host: string, listed: Iterable<string>): string | null {
  let best: string | null = null;
  for (const d of listed) {
    if (d === host || !host.endsWith(`.${d}`)) continue;
    if (!best || d.length > best.length) best = d;
  }
  return best;
}
