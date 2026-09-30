/** Sign in with Google (OIDC via /api/auth/login). Dev bypass shown only in Vite dev builds. OWNED BY: web-shell. */
import { useState } from "react";
import { Navigate, useSearchParams } from "react-router";
import { api, errorMessage } from "@web/lib/api";
import { useSession } from "@web/lib/session";
import { Button, Card, StateBanner } from "@web/components/ui";

function safeReturnTo(raw: string | null): string {
  // Only same-app relative paths; never protocol-relative or absolute URLs.
  if (!raw || !raw.startsWith("/") || raw.startsWith("//") || raw.startsWith("/\\")) return "/";
  return raw;
}

export function SignInPage() {
  const [params] = useSearchParams();
  const returnTo = safeReturnTo(params.get("returnTo"));
  const session = useSession();
  const [busy, setBusy] = useState(false);
  const [setupMessage, setSetupMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const authError = params.get("error");

  if (session.status === "authenticated") return <Navigate to={returnTo} replace />;

  const loginUrl = `/api/auth/login?returnTo=${encodeURIComponent(returnTo)}`;

  const signIn = async () => {
    setBusy(true);
    setError(null);
    setSetupMessage(null);
    try {
      // Preflight without following the redirect so a 412 (Google OIDC not configured) can be shown in-app.
      const res = await fetch(loginUrl, { redirect: "manual", credentials: "same-origin", headers: { Accept: "application/json" } });
      if (res.type === "opaqueredirect" || (res.status >= 300 && res.status < 400)) {
        window.location.assign(loginUrl);
        return;
      }
      const json = (await res.json().catch(() => null)) as { error?: { code: string; message: string } } | null;
      if (res.status === 412 || json?.error?.code === "setup_required") {
        setSetupMessage(json?.error?.message ?? "Google sign-in is not configured on this server.");
      } else {
        setError(json?.error?.message ?? `Sign-in failed (${res.status}).`);
      }
    } catch {
      // Network-level failure of the preflight: fall back to a plain navigation.
      window.location.assign(loginUrl);
      return;
    } finally {
      setBusy(false);
    }
  };

  const devLogin = async () => {
    setBusy(true);
    setError(null);
    try {
      await api("/auth/dev-login", { method: "POST" });
      await session.reload();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <main id="main" className="mx-auto flex min-h-dvh max-w-md flex-col justify-center px-4 py-12">
      <h1 className="mb-1 text-2xl font-semibold tracking-tight">Okara</h1>
      <p className="mb-6 text-sm text-zinc-600 dark:text-zinc-400">
        Evidence-backed SEO recommendations and API-sampled AI visibility tracking. Private beta.
      </p>
      <Card title="Sign in">
        <div className="space-y-4">
          {authError && <StateBanner state="failed" message="Sign-in did not complete. Please try again." />}
          {setupMessage && <StateBanner state="setup_required" message={setupMessage} />}
          {error && <StateBanner state="failed" message={error} />}
          {session.status === "error" && <StateBanner state="failed" message={errorMessage(session.error)} />}
          <Button variant="primary" className="w-full" loading={busy} onClick={() => void signIn()}>
            Sign in with Google
          </Button>
          <p className="text-xs text-zinc-600 dark:text-zinc-400">
            Sign-in only shares your name and email. Search Console access is requested separately, per project, with read-only scope.
          </p>
          {import.meta.env.DEV && (
            <div className="border-t border-zinc-200 pt-4 dark:border-zinc-800">
              <p className="mb-2 text-xs text-zinc-600 dark:text-zinc-400">
                Local development only. Works when the server has DEV_AUTH_BYPASS=true in development on localhost.
              </p>
              <Button size="sm" onClick={() => void devLogin()} disabled={busy}>
                Dev login (local)
              </Button>
            </div>
          )}
        </div>
      </Card>
    </main>
  );
}
