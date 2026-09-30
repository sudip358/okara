/** Authenticated shell: auth gate, top bar, workspace switcher. OWNED BY: web-shell. */
import { Link, Navigate, Outlet, useLocation } from "react-router";
import { useSession } from "@web/lib/session";
import { Button, ErrorState, LoadingState } from "@web/components/ui";
import { WorkspaceSwitcher } from "@web/components/WorkspaceSwitcher";

export function AppLayout() {
  const session = useSession();
  const location = useLocation();

  if (session.status === "loading") {
    return (
      <div className="mx-auto max-w-md px-4 py-16">
        <LoadingState label="Checking your session…" />
      </div>
    );
  }
  if (session.status === "anonymous") {
    const returnTo = location.pathname + location.search;
    return <Navigate to={`/signin${returnTo && returnTo !== "/" ? `?returnTo=${encodeURIComponent(returnTo)}` : ""}`} replace />;
  }
  if (session.status === "error" || !session.me) {
    return (
      <div className="mx-auto max-w-md px-4 py-16">
        <ErrorState title="Could not load your session" error={session.error} onRetry={() => void session.reload()} />
      </div>
    );
  }

  const me = session.me;
  return (
    <div className="min-h-dvh">
      <a
        href="#main"
        className="sr-only z-50 rounded bg-white px-3 py-2 text-sm focus:not-sr-only focus:fixed focus:left-2 focus:top-2 dark:bg-zinc-900"
      >
        Skip to content
      </a>
      <header className="border-b border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900">
        <div className="mx-auto flex max-w-screen-2xl flex-wrap items-center gap-x-4 gap-y-2 px-4 py-2.5">
          <Link to="/projects" className="text-base font-semibold tracking-tight text-zinc-900 focus-visible:outline-2 focus-visible:outline-sky-600 dark:text-zinc-50">
            Okara
          </Link>
          <WorkspaceSwitcher />
          <div className="ml-auto flex min-w-0 items-center gap-3">
            {me.environment !== "production" && (
              <span className="hidden text-xs text-zinc-500 sm:inline dark:text-zinc-400">env: {me.environment}</span>
            )}
            <span className="max-w-48 truncate text-sm text-zinc-700 dark:text-zinc-300" title={me.user.email}>
              {me.user.name ?? me.user.email}
            </span>
            <Button size="sm" variant="ghost" onClick={() => void session.signOut()}>
              Sign out
            </Button>
          </div>
        </div>
      </header>
      <Outlet />
    </div>
  );
}
