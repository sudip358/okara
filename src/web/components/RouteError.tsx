/**
 * Route error boundary (errorElement). A failed route-chunk import after a redeploy reloads once
 * automatically (guarded, see chunk-reload.ts), else shows a "new version" message and a reload button; anything else gets a plain error with reload and a way back to projects.
 * Error text is shown as plain text only.
 */
import { useEffect } from "react";
import { isRouteErrorResponse, Link, useRouteError } from "react-router";
import { Button, EmptyState, buttonClass } from "./ui";
import { isChunkLoadError } from "./chunk-reload";
import { reloadOnceInBrowser } from "./preload-reload";

export function RouteError({ embedded = false }: { embedded?: boolean }) {
  const error = useRouteError();
  const staleChunk = isChunkLoadError(error);
  // Covers imports Vite does not route through vite:preloadError; the shared guard prevents a reload loop.
  useEffect(() => {
    if (staleChunk) reloadOnceInBrowser();
  }, [staleChunk]);
  const Tag = embedded ? "div" : "main";
  const reload = () => window.location.reload();
  const actions = (
    <div className="flex flex-wrap justify-center gap-2">
      <Button variant="primary" onClick={reload}>
        Reload
      </Button>
      <Link to="/projects" reloadDocument className={buttonClass("secondary")}>
        Go to projects
      </Link>
    </div>
  );

  let title = "Something went wrong";
  let message = "This page failed to load. Reloading usually fixes it.";
  if (staleChunk) {
    title = "A new version is available";
    message = "Okara was updated since this tab was opened. Reload to continue.";
  } else if (isRouteErrorResponse(error)) {
    title = error.status === 404 ? "Page not found" : `Request failed (${error.status})`;
    message = error.statusText || message;
  } else if (error instanceof Error && error.message) {
    message = error.message;
  }

  return (
    <Tag id={embedded ? undefined : "main"} className="mx-auto max-w-xl px-4 py-12" role="alert">
      <EmptyState title={title} action={actions}>
        {message}
      </EmptyState>
    </Tag>
  );
}
