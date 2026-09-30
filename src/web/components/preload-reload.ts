/** Browser wiring for chunk-reload.ts (window, sessionStorage). */
import { reloadOnce, type ReloadDeps } from "./chunk-reload";

const browserDeps: ReloadDeps = {
  storage: () => sessionStorage,
  reload: () => window.location.reload(),
  now: () => Date.now(),
};

/** Guarded one-time reload; see reloadOnce. */
export const reloadOnceInBrowser = () => reloadOnce(browserDeps);

let installed = false;
/**
 * Vite fires `vite:preloadError` on window when a dynamic import's preload fails
 * (https://vite.dev/guide/build#load-error-handling). preventDefault() suppresses the throw while the page reloads.
 */
export function installPreloadErrorReload(): void {
  if (installed || typeof window === "undefined") return;
  installed = true;
  window.addEventListener("vite:preloadError", (event) => {
    if (reloadOnceInBrowser()) event.preventDefault();
  });
}
