/**
 * Site ownership verification. A project host counts as verified only after one of:
 *   dns  - TXT record `_okara-verify.<host>` = `okara-site-verification=<token>` (checked via DNS-over-HTTPS)
 *   file - https://<host>/.well-known/okara-verification.txt contains the token (no redirects, 5 s, 1 KB cap)
 *   gsc  - the connected Search Console property covers the host with a verified permission level
 * Possession of an input URL is never treated as ownership.
 */
import type { VerificationStatus } from "@shared/types";
import type { Env } from "../env";
import type { Db } from "../lib/db";
import { randomToken } from "../lib/ids";
import { iso } from "../lib/time";
import type { ProjectRow } from "./access";
import { resolveGscProvider } from "./gsc-maton";
import { isPublicHostname, siteHost } from "./projects";

export type VerificationMethod = "dns" | "file" | "gsc";

export const DOH_ENDPOINT = "https://cloudflare-dns.com/dns-query";
export const VERIFY_FILE_PATH = "/.well-known/okara-verification.txt";
export const VERIFY_TIMEOUT_MS = 5000;
export const VERIFY_FILE_MAX_BYTES = 1024;
/** Search Console permission levels that imply Google verified the user for the property. */
export const GSC_VERIFIED_LEVELS = new Set(["siteOwner", "siteFullUser", "siteRestrictedUser"]);

export const dnsRecordName = (host: string) => `_okara-verify.${host}`;
export const dnsRecordValue = (token: string) => `okara-site-verification=${token}`;
export const verifyFileUrl = (host: string) => `https://${host}${VERIFY_FILE_PATH}`;

export function verificationStatus(p: ProjectRow): VerificationStatus {
  const host = siteHost(p.site_url);
  const verified = p.verified_host === host && p.verification_method !== null;
  const token = p.verification_token;
  return {
    verified,
    method: verified ? (p.verification_method as VerificationStatus["method"]) : null,
    verifiedHost: verified ? p.verified_host : null,
    dnsRecord: !verified && token ? { name: dnsRecordName(host), type: "TXT", value: dnsRecordValue(token) } : null,
    fileCheck: !verified && token ? { url: verifyFileUrl(host), content: token } : null,
  };
}

/** Projects created outside this module may lack a token; mint one on first use. */
export async function ensureVerificationToken(db: Db, p: ProjectRow): Promise<ProjectRow> {
  if (p.verification_token) return p;
  const token = randomToken(24);
  await db.run(
    "UPDATE projects SET verification_token = ? WHERE workspace_id = ? AND id = ? AND verification_token IS NULL",
    token,
    p.workspace_id,
    p.id,
  );
  const row = await db.first<{ verification_token: string }>("SELECT verification_token FROM projects WHERE workspace_id = ? AND id = ?", p.workspace_id, p.id);
  return { ...p, verification_token: row?.verification_token ?? token };
}

export interface CheckResult {
  ok: boolean;
  detail: string;
}

function withTimeout(ms: number): { signal: AbortSignal; done: () => void } {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  return { signal: ctrl.signal, done: () => clearTimeout(t) };
}

/** TXT data arrives as one or more quoted character-strings: "\"part1\" \"part2\"". */
export function parseTxtData(data: string): string {
  const parts = data.match(/"((?:[^"\\]|\\.)*)"/g);
  if (!parts) return data.trim();
  return parts.map((p) => p.slice(1, -1).replace(/\\(.)/g, "$1")).join("");
}

export async function checkDns(host: string, token: string, fetchImpl: typeof fetch): Promise<CheckResult> {
  const name = dnsRecordName(host);
  const url = `${DOH_ENDPOINT}?name=${encodeURIComponent(name)}&type=TXT`;
  const t = withTimeout(VERIFY_TIMEOUT_MS);
  try {
    const res = await fetchImpl(url, { headers: { accept: "application/dns-json" }, signal: t.signal, redirect: "manual" });
    if (!res.ok) return { ok: false, detail: `DNS lookup failed (HTTP ${res.status}).` };
    const json = (await res.json().catch(() => null)) as { Status?: number; Answer?: Array<{ name?: string; type?: number; data?: string }> } | null;
    if (!json || json.Status !== 0) return { ok: false, detail: `No TXT record found at ${name}.` };
    const expected = dnsRecordValue(token);
    const values = (json.Answer ?? []).filter((a) => a.type === 16 && typeof a.data === "string").map((a) => parseTxtData(a.data!));
    if (values.some((v) => v.trim() === expected)) return { ok: true, detail: `TXT record found at ${name}.` };
    return { ok: false, detail: values.length ? `TXT records at ${name} do not contain the expected value.` : `No TXT record found at ${name}.` };
  } catch {
    return { ok: false, detail: "DNS lookup timed out or failed." };
  } finally {
    t.done();
  }
}

async function readCapped(res: Response, maxBytes: number): Promise<string | null> {
  if (!res.body) return "";
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  const buf = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    buf.set(c, off);
    off += c.byteLength;
  }
  return new TextDecoder().decode(buf);
}

export async function checkFile(host: string, token: string, fetchImpl: typeof fetch): Promise<CheckResult> {
  if (!isPublicHostname(host)) return { ok: false, detail: "Host is not a public domain name." };
  const url = verifyFileUrl(host);
  const target = new URL(url);
  if (target.protocol !== "https:" || target.hostname !== host || target.port) return { ok: false, detail: "Verification URL must be https on the project host." };
  const t = withTimeout(VERIFY_TIMEOUT_MS);
  try {
    const res = await fetchImpl(url, { redirect: "manual", signal: t.signal, headers: { accept: "text/plain" } });
    if (res.status >= 300 && res.status < 400) {
      await res.body?.cancel().catch(() => undefined);
      return { ok: false, detail: "The verification file URL redirected; redirects are not followed." };
    }
    if (res.status !== 200) return { ok: false, detail: `Verification file returned HTTP ${res.status}.` };
    if (res.url) {
      try {
        if (new URL(res.url).hostname !== host) return { ok: false, detail: "Response came from a different host." };
      } catch {
        /* ignore unparsable url from fakes */
      }
    }
    const body = await readCapped(res, VERIFY_FILE_MAX_BYTES);
    if (body === null) return { ok: false, detail: `Verification file is larger than ${VERIFY_FILE_MAX_BYTES} bytes.` };
    if (body.includes(token)) return { ok: true, detail: `Token found at ${url}.` };
    return { ok: false, detail: `Token not found in ${url}.` };
  } catch {
    return { ok: false, detail: "Fetching the verification file timed out or failed." };
  } finally {
    t.done();
  }
}

/**
 * True when a Search Console property covers the whole host:
 * - URL-prefix property: same https origin with path "/" (a sub-path property does not cover the host)
 * - Domain property sc-domain:<domain>: host equals domain or is a subdomain of it
 */
export function gscPropertyCoversHost(property: string, host: string): boolean {
  const h = host.toLowerCase();
  if (property.startsWith("sc-domain:")) {
    const domain = property.slice("sc-domain:".length).trim().toLowerCase().replace(/\.$/, "");
    if (!domain) return false;
    return h === domain || h.endsWith(`.${domain}`);
  }
  let u: URL;
  try {
    u = new URL(property);
  } catch {
    return false;
  }
  return u.protocol === "https:" && !u.port && !u.username && !u.password && u.hostname.toLowerCase() === h && (u.pathname === "/" || u.pathname === "");
}

export function gscEntryVerifiesHost(entry: { siteUrl: string; permissionLevel: string } | undefined, host: string): CheckResult {
  if (!entry) return { ok: false, detail: "The selected property is not available to the connected Google account." };
  if (!GSC_VERIFIED_LEVELS.has(entry.permissionLevel)) {
    return { ok: false, detail: `Permission level ${entry.permissionLevel} does not prove verified access to the property.` };
  }
  if (!gscPropertyCoversHost(entry.siteUrl, host)) return { ok: false, detail: `Property ${entry.siteUrl} does not cover ${host}.` };
  return { ok: true, detail: `Search Console property ${entry.siteUrl} (${entry.permissionLevel}) covers ${host}.` };
}

export async function checkGsc(env: Env, db: Db, p: ProjectRow, fetchImpl: typeof fetch): Promise<CheckResult> {
  if (!p.gsc_property) return { ok: false, detail: "Select a Search Console property first." };
  // Direct OAuth first; the Maton source when the project chose it (platform/gsc-maton.ts).
  const gsc = await resolveGscProvider(env, db, { id: p.id, workspaceId: p.workspace_id }, fetchImpl, undefined, { purpose: "verification" });
  if (!gsc) return { ok: false, detail: "Search Console is not connected." };
  try {
    const props = await gsc.listProperties();
    return gscEntryVerifiesHost(
      props.find((e) => e.siteUrl === p.gsc_property),
      siteHost(p.site_url),
    );
  } catch (e) {
    return { ok: false, detail: e instanceof Error ? e.message.slice(0, 200) : "Search Console request failed." };
  }
}

export async function markVerified(db: Db, p: ProjectRow, method: VerificationMethod, now: Date): Promise<void> {
  const ts = iso(now);
  await db.run(
    "UPDATE projects SET verified_host = ?, verification_method = ?, verified_at = ?, updated_at = ? WHERE workspace_id = ? AND id = ?",
    siteHost(p.site_url),
    method,
    ts,
    ts,
    p.workspace_id,
    p.id,
  );
}

/** Run one check; on success record verified_host/method/verified_at. A failed check never removes an existing verification. */
export async function runVerificationCheck(
  env: Env,
  db: Db,
  project: ProjectRow,
  method: VerificationMethod,
  fetchImpl: typeof fetch,
  now: Date,
): Promise<{ status: VerificationStatus; check: CheckResult }> {
  const p = await ensureVerificationToken(db, project);
  const host = siteHost(p.site_url);
  const token = p.verification_token!;
  const check =
    method === "dns" ? await checkDns(host, token, fetchImpl) : method === "file" ? await checkFile(host, token, fetchImpl) : await checkGsc(env, db, p, fetchImpl);
  if (check.ok) await markVerified(db, p, method, now);
  const fresh = (await db.first<ProjectRow>("SELECT * FROM projects WHERE workspace_id = ? AND id = ?", p.workspace_id, p.id))!;
  return { status: verificationStatus(fresh), check };
}
