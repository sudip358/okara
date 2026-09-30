/** Auth bootstrap: GET /api/me, CSRF token, current workspace. OWNED BY: web-shell. */
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import type { Me } from "@shared/types";
import { api, ApiError, setCsrfToken, setUnauthorizedHandler } from "./api";

const WS_KEY = "okara.workspaceId";

function readStoredWorkspace(): string | null {
  try {
    return localStorage.getItem(WS_KEY);
  } catch {
    return null;
  }
}
function storeWorkspace(id: string) {
  try {
    localStorage.setItem(WS_KEY, id);
  } catch {
    /* per-viewer convenience only */
  }
}

export interface SessionValue {
  me: Me | null;
  /** "loading" until /me resolves; "anonymous" on 401; "error" on other failures. */
  status: "loading" | "authenticated" | "anonymous" | "error";
  error: unknown;
  workspaceId: string | null;
  setWorkspaceId: (id: string) => void;
  reload: () => Promise<void>;
  signOut: () => Promise<void>;
}

const SessionContext = createContext<SessionValue | null>(null);

export function SessionProvider({ children }: { children: ReactNode }) {
  const [me, setMe] = useState<Me | null>(null);
  const [status, setStatus] = useState<SessionValue["status"]>("loading");
  const [error, setError] = useState<unknown>(null);
  const [workspaceId, setWs] = useState<string | null>(readStoredWorkspace());

  const load = useCallback(async () => {
    try {
      const m = await api<Me>("/me");
      setCsrfToken(m.csrfToken, m.user.id);
      setMe(m);
      setStatus("authenticated");
      setError(null);
      setWs((cur) => (cur && m.workspaces.some((w) => w.id === cur) ? cur : (m.workspaces[0]?.id ?? null)));
    } catch (e) {
      setCsrfToken(null);
      setMe(null);
      setError(e);
      setStatus(e instanceof ApiError && e.status === 401 ? "anonymous" : "error");
    }
  }, []);

  useEffect(() => {
    void load();
    setUnauthorizedHandler(() => {
      setCsrfToken(null);
      setMe(null);
      setStatus("anonymous");
    });
    return () => setUnauthorizedHandler(null);
  }, [load]);

  const setWorkspaceId = useCallback((id: string) => {
    storeWorkspace(id);
    setWs(id);
  }, []);

  const signOut = useCallback(async () => {
    try {
      await api("/auth/logout", { method: "POST" });
    } finally {
      setCsrfToken(null);
      setMe(null);
      setStatus("anonymous");
    }
  }, []);

  const value = useMemo<SessionValue>(
    () => ({ me, status, error, workspaceId, setWorkspaceId, reload: load, signOut }),
    [me, status, error, workspaceId, setWorkspaceId, load, signOut],
  );
  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionValue {
  const v = useContext(SessionContext);
  if (!v) throw new Error("useSession must be used inside <SessionProvider>");
  return v;
}

/** Authenticated `Me` (only call under the auth gate). */
export function useMe(): Me {
  const { me } = useSession();
  if (!me) throw new Error("useMe called without an authenticated session");
  return me;
}
