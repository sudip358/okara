/**
 * Client-side mirror of project input validation (the server remains authoritative).
 * OWNED BY: web-shell.
 */
import type { Competitor, ProjectInput } from "@shared/types";
import { MAX_COMPETITORS, MAX_COMPETITOR_DOMAINS, cleanCompetitorDomain } from "@shared/competitors";

/** Shared with the Worker schema (src/shared/competitors.ts). */
export { MAX_COMPETITORS };
export const LIMITS = {
  name: 100,
  brandName: 100,
  alias: 100,
  aliases: 20,
  productDescription: 2000,
  audience: 1000,
  voice: 2000,
  domains: MAX_COMPETITOR_DOMAINS,
} as const;

const HOST_RE = /^(?=.{1,253}$)(?!-)[a-z0-9-]{1,63}(?<!-)(\.(?!-)[a-z0-9-]{1,63}(?<!-))+$/;

/**
 * "https://www.Example.com/path" → "example.com" (shared cleaning rules: hostname only, lowercase, no "www.", no path).
 * Values that cannot be cleaned are returned trimmed and lowercased so domainError can explain why.
 */
export function normalizeDomain(raw: string): string {
  const r = cleanCompetitorDomain(raw);
  return r.ok ? r.domain : raw.trim().toLowerCase();
}

/** Validity only (used for domains already on the project). */
function domainInvalid(d: string): string | null {
  const r = cleanCompetitorDomain(d);
  return !r.ok || !HOST_RE.test(r.domain) ? `"${d}" is not a valid domain name.` : null;
}

/** Why a (normalized) competitor domain is rejected when it is added; a likely "ww." / "wwww." typo is rejected with the suggestion, never corrected silently. */
export function domainError(d: string): string | null {
  const r = cleanCompetitorDomain(d);
  if (!r.ok || !HOST_RE.test(r.domain)) return `"${d}" is not a valid domain name.`;
  if (r.typoOf) return `"${d}" looks like a typo. Did you mean ${r.typoOf}? Type the corrected domain to add it.`;
  return null;
}

export function siteUrlError(raw: string): string | null {
  const v = raw.trim();
  if (!v) return "Website URL is required.";
  let u: URL;
  try {
    u = new URL(v);
  } catch {
    return "Enter a full URL, e.g. https://www.example.com";
  }
  if (u.protocol !== "https:") return "The website must use https://.";
  if (u.username || u.password) return "The URL must not contain a username or password.";
  if (u.port) return "Non-standard ports are not supported.";
  if (!HOST_RE.test(u.hostname)) return "Enter a public domain name (no IP addresses or localhost).";
  return null;
}

export interface ValidationResult {
  errors: Record<string, string>;
  warnings: string[];
}

export function validateProjectInput(input: ProjectInput): ValidationResult {
  const errors: Record<string, string> = {};
  const warnings: string[] = [];
  const len = (k: keyof typeof LIMITS, v: string, label: string) => {
    if (v.length > LIMITS[k]) errors[k] = `${label} must be at most ${LIMITS[k]} characters.`;
  };

  if (!input.name.trim()) errors.name = "Project name is required.";
  len("name", input.name, "Project name");
  const urlErr = siteUrlError(input.siteUrl);
  if (urlErr) errors.siteUrl = urlErr;
  if (!input.brandName.trim()) errors.brandName = "Brand name is required.";
  len("brandName", input.brandName, "Brand name");
  if (input.brandAliases.length > LIMITS.aliases) errors.brandAliases = `Up to ${LIMITS.aliases} aliases.`;
  len("productDescription", input.productDescription, "Product description");
  len("audience", input.audience, "Audience");
  len("voice", input.voice, "Voice instructions");
  if (!/^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/.test(input.locale.trim())) errors.locale = "Use a locale code such as en-US.";
  if (!/^[a-z]{2,3}$/.test(input.language.trim())) errors.language = "Use a language code such as en.";

  if (input.competitors.length > MAX_COMPETITORS) errors.competitors = `Up to ${MAX_COMPETITORS} competitors.`;
  input.competitors.forEach((c, i) => {
    if (!c.name.trim()) errors[`competitors.${i}.name`] = "Competitor name is required.";
    if (c.domains.length > LIMITS.domains) errors[`competitors.${i}.domains`] = `Up to ${LIMITS.domains} domains.`;
    const bad = c.domains.find((d) => domainInvalid(d));
    if (bad) errors[`competitors.${i}.domains`] = domainInvalid(bad)!;
  });

  warnings.push(...aliasCollisions(input.brandName, input.brandAliases, input.competitors, input.siteUrl));
  return { errors, warnings };
}

/** Brand vs competitor name/alias/domain collisions must be resolved manually (spec: GEO alias handling). */
export function aliasCollisions(brandName: string, brandAliases: string[], competitors: Competitor[], siteUrl = ""): string[] {
  const out: string[] = [];
  const brandTerms = new Map<string, string>();
  for (const t of [brandName, ...brandAliases]) if (t.trim()) brandTerms.set(t.trim().toLowerCase(), t.trim());
  let ownHost = "";
  try {
    ownHost = new URL(siteUrl).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    /* ignore */
  }
  const seen = new Map<string, string>();
  for (const c of competitors) {
    for (const t of [c.name, ...c.aliases]) {
      const k = t.trim().toLowerCase();
      if (!k) continue;
      if (brandTerms.has(k)) out.push(`"${t.trim()}" is used both as your brand name/alias and by competitor "${c.name}". Detection will be ambiguous.`);
      const other = seen.get(k);
      if (other && other !== c.name) out.push(`"${t.trim()}" is used by two competitors ("${other}" and "${c.name}").`);
      seen.set(k, c.name);
    }
    for (const d of c.domains) {
      if (ownHost && d.replace(/^www\./, "") === ownHost) out.push(`Competitor "${c.name}" lists your own domain ${d}.`);
    }
  }
  return Array.from(new Set(out));
}
