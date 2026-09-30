/**
 * Stale-deploy recovery. Route chunks are content-hashed, so a tab opened before a redeploy asks for chunk
 * files that no longer exist and the dynamic import rejects. We reload once to pick up the new index.html;
 * a sessionStorage timestamp stops a reload loop when the failure is not a stale deploy (offline, real 404).
 * Pure (storage and reload are injected) so it is unit-tested in Node; the browser wiring is in preload-reload.ts.
 */

const KEY = "okara.chunkReloadAt";
/** A second failure within this window after a guarded reload is shown to the user instead of reloading again. */
export const RELOAD_GUARD_MS = 60_000;

/** True when the error is a failed dynamic import / module preload (message text differs per browser). */
export function isChunkLoadError(err: unknown): boolean {
  const msg = err instanceof Error ? `${err.name} ${err.message}` : typeof err === "string" ? err : "";
  return /Failed to fetch dynamically imported module|error loading dynamically imported module|Importing a module script failed|Unable to preload CSS|ChunkLoadError|Loading (CSS )?chunk \S+ failed/i.test(msg);
}

export interface ReloadDeps {
  storage: () => { getItem(key: string): string | null; setItem(key: string, value: string): void } | null;
  reload: () => void;
  now: () => number;
}

/**
 * Reloads the page unless a guarded reload already happened within RELOAD_GUARD_MS. Returns true when it
 * reloaded. Storage may be missing or throw (private mode, blocked site data); then it never auto-reloads,
 * so a loop is impossible and the error UI offers a manual reload.
 */
export function reloadOnce(deps: ReloadDeps): boolean {
  try {
    const store = deps.storage();
    if (!store) return false;
    const last = Number(store.getItem(KEY) ?? 0);
    const now = deps.now();
    if (Number.isFinite(last) && last > 0 && now - last < RELOAD_GUARD_MS) return false;
    store.setItem(KEY, String(now));
  } catch {
    return false;
  }
  deps.reload();
  return true;
}
