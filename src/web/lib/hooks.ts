/** Data hooks over the typed api client. OWNED BY: web-shell. */
import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "./api";

export interface ApiState<T> {
  data: T | null;
  error: unknown;
  loading: boolean;
  /** Re-fetch; keeps current data visible while loading. */
  reload: () => void;
  /** Replace local data (e.g. after a mutation returned the new object). */
  setData: (next: T | null) => void;
}

/**
 * GET `/api${path}`. Pass `null` to skip (e.g. while a dependency is missing).
 * Re-fetches when `path` or any value in `deps` changes. Aborts stale requests.
 */
export function useApi<T>(path: string | null, deps: unknown[] = []): ApiState<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [loading, setLoading] = useState<boolean>(path !== null);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    if (path === null) {
      setLoading(false);
      return;
    }
    const ctrl = new AbortController();
    setLoading(true);
    setError(null);
    api<T>(path, { signal: ctrl.signal })
      .then((d) => {
        if (!ctrl.signal.aborted) setData(d);
      })
      .catch((e: unknown) => {
        if (ctrl.signal.aborted) return;
        setError(e);
      })
      .finally(() => {
        if (!ctrl.signal.aborted) setLoading(false);
      });
    return () => ctrl.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, tick, ...deps]);

  const reload = useCallback(() => setTick((t) => t + 1), []);
  return { data, error, loading, reload, setData };
}

export interface MutationState<TArgs extends unknown[], TResult> {
  /** Runs the mutation; resolves to the result, or undefined if it threw (error is stored). */
  run: (...args: TArgs) => Promise<TResult | undefined>;
  loading: boolean;
  error: unknown;
  data: TResult | null;
  reset: () => void;
}

/**
 * Wraps an async action with loading/error state.
 * Example: const save = useMutation((body: X) => api<Project>(`/projects/${id}`, { method: "PATCH", body }));
 */
export function useMutation<TArgs extends unknown[], TResult>(fn: (...args: TArgs) => Promise<TResult>): MutationState<TArgs, TResult> {
  const fnRef = useRef(fn);
  fnRef.current = fn;
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [data, setData] = useState<TResult | null>(null);

  const run = useCallback(async (...args: TArgs) => {
    setLoading(true);
    setError(null);
    try {
      const result = await fnRef.current(...args);
      setData(result);
      return result;
    } catch (e) {
      setError(e);
      return undefined;
    } finally {
      setLoading(false);
    }
  }, []);
  const reset = useCallback(() => {
    setError(null);
    setData(null);
  }, []);
  return { run, loading, error, data, reset };
}

/** Calls `fn` every `ms` while `active` (e.g. reload while a run is pending/running). Pauses when the tab is hidden. */
export function usePolling(fn: () => void, active: boolean, ms = 10_000): void {
  const ref = useRef(fn);
  ref.current = fn;
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => {
      if (typeof document === "undefined" || document.visibilityState === "visible") ref.current();
    }, ms);
    return () => clearInterval(t);
  }, [active, ms]);
}
