/**
 * Versioned AES-GCM envelope for secrets at rest (refresh tokens, BYO provider keys).
 * Format: "v<keyVersion>.<base64url iv>.<base64url ciphertext>". A fresh 96-bit random IV per value.
 * Keys come from TOKEN_ENCRYPTION_KEY_V<n> (base64, 32 bytes). The highest configured version encrypts;
 * any configured version decrypts, which allows rotation.
 */
import type { Env } from "../env";
import { base64Url } from "./ids";

const PREFIX = /^v(\d+)\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)$/;

function keyMaterial(env: Env): Map<number, string> {
  const keys = new Map<number, string>();
  for (const [name, value] of Object.entries(env)) {
    const m = /^TOKEN_ENCRYPTION_KEY_V(\d+)$/.exec(name);
    if (m && typeof value === "string" && value.trim()) keys.set(Number(m[1]), value.trim());
  }
  return keys;
}

async function importKey(b64: string): Promise<CryptoKey> {
  const raw = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  if (raw.byteLength !== 32) throw new Error("Encryption key must be 32 bytes (base64).");
  return crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
}

function fromBase64Url(s: string): Uint8Array {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4);
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}

export function encryptionConfigured(env: Env): boolean {
  return keyMaterial(env).size > 0;
}

export async function encryptSecret(env: Env, plaintext: string, aad = ""): Promise<string> {
  const keys = keyMaterial(env);
  if (keys.size === 0) throw new Error("No TOKEN_ENCRYPTION_KEY_V<n> configured.");
  const version = Math.max(...keys.keys());
  const key = await importKey(keys.get(version)!);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: new TextEncoder().encode(aad) },
    key,
    new TextEncoder().encode(plaintext),
  );
  return `v${version}.${base64Url(iv)}.${base64Url(new Uint8Array(ct))}`;
}

export async function decryptSecret(env: Env, envelope: string, aad = ""): Promise<string> {
  const m = PREFIX.exec(envelope);
  if (!m) throw new Error("Malformed secret envelope.");
  const material = keyMaterial(env).get(Number(m[1]));
  if (!material) throw new Error(`Encryption key version ${m[1]} is not configured.`);
  const key = await importKey(material);
  const pt = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: fromBase64Url(m[2]!), additionalData: new TextEncoder().encode(aad) },
    key,
    fromBase64Url(m[3]!),
  );
  return new TextDecoder().decode(pt);
}
