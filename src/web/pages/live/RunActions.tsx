/**
 * Live view run controls (docs/live-view-design.md section 16): the small "▶ Run …" button in a panel header,
 * the header "Run all" menu, and the one confirm dialog they share. The mapping (which panel runs what, labels,
 * disabled reasons, confirm text) is pure in ./run-actions.ts.
 *
 * - Panels read their action from PanelActionsContext by their testId (engine columns by `lane:<provider>`), so
 *   no panel component needs a new prop. No entry = no button.
 * - A disabled action stays focusable (aria-disabled) so keyboard and touch users can read why (tooltip and a
 *   screen-reader description).
 * - Every action that starts work asks first, saying what it calls and what it uses; the dialog lives at the
 *   Live view root (panels are size-contained, which would clip a fixed overlay).
 * - After a run starts, the Live view switches to that run (LIVE mode); a tool call reloads its panel's data.
 */
import { createContext, useCallback, useContext, useEffect, useId, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";
import { Link } from "react-router";
import type { RunSummary } from "@shared/types";
import { api, errorMessage, isRateLimited, isSetupRequired } from "@web/lib/api";
import { Button, cx } from "@web/components/ui";
import type { ReloadKey, SectionAction } from "./run-actions";

export const PanelActionsContext = createContext<Record<string, SectionAction> | null>(null);

interface Runner {
  request: (action: SectionAction, opener: HTMLElement | null) => void;
  busy: string | null;
}
const RunnerContext = createContext<Runner | null>(null);

const FOCUSABLE = 'button:not([disabled]), [href], input:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** POST /import/syncs/:id/run answers 200 with {outcome: {status, message}}: a non-ok outcome is the error shown. */
export function syncFailure(res: unknown): string | null {
  const o = (res as { outcome?: { status?: string; message?: string | null } } | null)?.outcome;
  if (!o || o.status === "ok") return null;
  return o.status === "busy" ? (o.message ?? "A sync of this tab is already running.") : `Sync failed: ${o.message ?? "the sheet could not be read."}`;
}

/** Body of POST /projects/:pid/runs for one run spec. */
export function runBody(spec: { agent: string; steps: string[] | null; engines?: string[] }): Record<string, unknown> {
  return { agent: spec.agent, ...(spec.steps ? { steps: spec.steps } : {}), ...(spec.engines ? { engines: spec.engines } : {}) };
}

export function RunActionsProvider({
  projectId,
  onStarted,
  onReload,
  children,
}: {
  projectId: string;
  /** First run started (the view switches to it); all runs started. */
  onStarted: (run: RunSummary, all: RunSummary[]) => void;
  onReload: (what: ReloadKey) => void;
  children: ReactNode;
}) {
  const [pending, setPending] = useState<{ action: Exclude<SectionAction, { kind: "link" }>; opener: HTMLElement | null } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [status, setStatus] = useState("");

  const request = useCallback((action: SectionAction, opener: HTMLElement | null) => {
    if (action.kind === "link" || action.disabled) return;
    setError(null);
    setPending({ action, opener });
  }, []);

  const close = useCallback(() => {
    setPending((p) => {
      p?.opener?.focus?.();
      return null;
    });
    setError(null);
  }, []);

  const confirm = async (choice?: string | null) => {
    if (!pending) return;
    const { action } = pending;
    setBusy(action.key);
    setError(null);
    try {
      if (action.kind === "run") {
        const started: RunSummary[] = [];
        let failure: unknown = null;
        for (const spec of action.runs) {
          try {
            started.push(await api<RunSummary>(`/projects/${encodeURIComponent(projectId)}/runs`, { method: "POST", body: runBody(spec) }));
          } catch (e) {
            failure = e;
            break;
          }
        }
        if (started.length > 0) {
          setStatus(`${action.label}: started.${failure ? ` One run did not start: ${errorMessage(failure)}` : ""}`);
          onStarted(started[0]!, started);
        }
        if (failure && started.length === 0) throw failure;
      } else {
        const body = action.choice ? { ...(action.body ?? {}), [action.choice.field]: choice ?? null } : action.body;
        const res = await api<unknown>(action.path, body === undefined ? { method: "POST" } : { method: "POST", body });
        onReload(action.reload);
        const failure = action.expect === "sync_outcome" ? syncFailure(res) : null;
        // The call returned but did not do the work (a sync recorded an error, or another sync of the tab runs).
        if (failure) throw new Error(failure);
        setStatus(`${action.label}: ${action.doneText ?? "done"}.`);
      }
      setPending(null);
    } catch (e) {
      setError(e);
    } finally {
      setBusy(null);
    }
  };

  const runner = useMemo(() => ({ request, busy }), [request, busy]);
  return (
    <RunnerContext.Provider value={runner}>
      {children}
      <p className="sr-only" role="status" aria-live="polite">
        {status}
      </p>
      {pending && <ConfirmDialog action={pending.action} busy={busy === pending.action.key} error={error} onCancel={close} onConfirm={confirm} />}
    </RunnerContext.Provider>
  );
}

export function ConfirmDialog({
  action,
  busy,
  error,
  onCancel,
  onConfirm,
}: {
  action: Exclude<SectionAction, { kind: "link" }>;
  busy: boolean;
  error: unknown;
  onCancel: () => void;
  onConfirm: (choice?: string | null) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const descId = useId();
  const choiceName = useId();
  const choice = action.kind === "call" ? action.choice : undefined;
  const [picked, setPicked] = useState<string | null>(() => choice?.options.find((o) => !o.disabled)?.value ?? null);
  const cancelRef = useRef(onCancel);
  cancelRef.current = onCancel;
  useEffect(() => {
    const panel = ref.current;
    // Paid actions: focus starts on Cancel, so Enter never starts work by accident.
    panel?.querySelector<HTMLElement>("[data-cancel]")?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        cancelRef.current();
        return;
      }
      if (e.key !== "Tab" || !panel) return;
      const items = Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE));
      if (items.length === 0) return;
      const first = items[0]!;
      const last = items[items.length - 1]!;
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, []);
  return (
    <div className="fixed inset-0 z-[60] flex items-end justify-center p-4 sm:items-center">
      <div className="absolute inset-0 bg-zinc-950/50" aria-hidden="true" onClick={busy ? undefined : onCancel} />
      <div
        ref={ref}
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descId}
        data-testid="run-confirm"
        className="relative w-full max-w-md rounded-xl border border-zinc-200 bg-white p-4 text-zinc-900 shadow-xl dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100"
      >
        <h2 id={titleId} className="text-base font-semibold">
          {action.confirm.title}
        </h2>
        <div id={descId} className="mt-2 space-y-1.5 text-sm text-zinc-700 dark:text-zinc-300">
          {action.confirm.lines.map((l) => (
            <p key={l}>{l}</p>
          ))}
        </div>
        {choice && (
          <fieldset className="mt-3 min-w-0 space-y-1" data-testid="run-choice">
            <legend className="text-xs font-semibold text-zinc-800 dark:text-zinc-200">{choice.legend}</legend>
            {choice.options.map((o) => (
              <label
                key={o.value}
                title={o.disabled ?? undefined}
                className={cx(
                  "flex min-w-0 items-start gap-2 rounded-md border px-2 py-1.5 text-sm",
                  o.disabled ? "cursor-not-allowed border-zinc-200 text-zinc-500 dark:border-zinc-800 dark:text-zinc-500" : "border-zinc-300 dark:border-zinc-700",
                )}
              >
                <input
                  type="radio"
                  name={choiceName}
                  value={o.value}
                  checked={picked === o.value}
                  disabled={!!o.disabled || busy}
                  onChange={() => setPicked(o.value)}
                  className="mt-1"
                />
                <span className="min-w-0">
                  <span className="block font-mono text-xs break-all">{o.label}</span>
                  {(o.disabled || o.note) && <span className="block text-xs text-zinc-500 dark:text-zinc-400">{o.disabled ?? o.note}</span>}
                </span>
              </label>
            ))}
          </fieldset>
        )}
        {error !== null && (
          <p role="alert" className={cx("mt-3 text-sm", isRateLimited(error) || isSetupRequired(error) ? "text-amber-800 dark:text-amber-300" : "text-red-700 dark:text-red-400")}>
            {isRateLimited(error) ? "Limit reached: " : isSetupRequired(error) ? "Setup required: " : ""}
            {errorMessage(error)}
          </p>
        )}
        <div className="mt-4 flex flex-wrap justify-end gap-2">
          <Button data-cancel="" onClick={onCancel} disabled={busy}>
            Cancel
          </Button>
          <Button variant="primary" onClick={() => onConfirm(picked)} loading={busy} disabled={!!choice && picked === null}>
            {action.kind === "run" ? (action.runs.length > 1 ? "Start both runs" : "Start run") : "Start"}
          </Button>
        </div>
      </div>
    </div>
  );
}

const BTN =
  "inline-flex h-7 shrink-0 items-center gap-1 rounded-md border px-2 text-xs font-medium whitespace-nowrap no-underline hover:no-underline focus-visible:outline-2 focus-visible:outline-sky-600";
const BTN_ON = "border-zinc-300 bg-white text-zinc-800 hover:bg-zinc-100 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-200 dark:hover:bg-zinc-800";
const BTN_OFF = "cursor-not-allowed border-zinc-200 bg-zinc-50 text-zinc-500 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-500";

/** "▶ Run crawl" for one panel; a link action renders as a link styled the same way. */
export function SectionButton({ action }: { action: SectionAction }) {
  const runner = useContext(RunnerContext);
  const reasonId = useId();
  if (action.kind === "link") {
    return (
      <Link to={action.to} className={cx(BTN, BTN_ON)} data-action={action.key}>
        <span aria-hidden="true">↗</span>
        {action.label}
      </Link>
    );
  }
  const off = !!action.disabled || !runner;
  const busy = runner?.busy === action.key;
  const label = action.disabled && action.busyLabel ? action.busyLabel : action.label;
  return (
    <>
      <button
        type="button"
        data-action={action.key}
        aria-disabled={off || undefined}
        aria-describedby={action.disabled ? reasonId : undefined}
        aria-busy={busy || undefined}
        title={action.disabled ?? undefined}
        onClick={(e) => {
          if (off || busy) return;
          runner!.request(action, e.currentTarget);
        }}
        className={cx(BTN, off ? BTN_OFF : BTN_ON)}
      >
        <span aria-hidden="true">{busy ? "…" : "▶"}</span>
        {label}
      </button>
      {action.disabled && (
        <span id={reasonId} className="sr-only">
          {action.disabled}
        </span>
      )}
    </>
  );
}

/** The panel's action (if any) from context; `key` is the panel testId or `lane:<provider>`. */
export function PanelAction({ panelKey }: { panelKey: string | undefined }) {
  const actions = useContext(PanelActionsContext);
  const action = panelKey ? actions?.[panelKey] : undefined;
  return action ? <SectionButton action={action} /> : null;
}

/** Header "Run all" menu (menu button pattern: arrows move, Escape closes, focus returns to the button). */
export function RunAllMenu({ actions }: { actions: SectionAction[] }) {
  const runner = useContext(RunnerContext);
  const [open, setOpen] = useState(false);
  const btn = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const menuId = useId();
  const items = () => Array.from(menu.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? []);
  useEffect(() => {
    if (!open) return;
    items()[0]?.focus();
    const onDown = (e: MouseEvent) => {
      if (!menu.current?.contains(e.target as Node) && !btn.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);
  const onMenuKey = (e: ReactKeyboardEvent) => {
    const list = items();
    const i = list.indexOf(document.activeElement as HTMLElement);
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const n = list.length;
      list[(i + (e.key === "ArrowDown" ? 1 : -1) + n) % n]?.focus();
    } else if (e.key === "Home" || e.key === "End") {
      e.preventDefault();
      list[e.key === "Home" ? 0 : list.length - 1]?.focus();
    } else if (e.key === "Escape" || e.key === "Tab") {
      if (e.key === "Escape") e.preventDefault();
      e.stopPropagation();
      setOpen(false);
      btn.current?.focus();
    }
  };
  return (
    <div className="relative">
      <button
        ref={btn}
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        onClick={() => setOpen((o) => !o)}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") {
            e.preventDefault();
            setOpen(true);
          }
        }}
        className={cx(BTN, "border-zinc-900 bg-zinc-900 text-white hover:bg-zinc-700 dark:border-zinc-100 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-300")}
      >
        <span aria-hidden="true">▶</span>
        Run all
        <span aria-hidden="true">▾</span>
      </button>
      {open && (
        <div
          ref={menu}
          id={menuId}
          role="menu"
          aria-label="Run all"
          onKeyDown={onMenuKey}
          className="absolute right-0 z-40 mt-1 w-[min(18rem,calc(100vw-2rem))] rounded-lg border border-zinc-200 bg-white p-1 shadow-lg dark:border-zinc-700 dark:bg-zinc-900"
        >
          {actions.map((a) => (
            <button
              key={a.key}
              type="button"
              role="menuitem"
              tabIndex={-1}
              data-action={a.key}
              aria-disabled={a.disabled ? true : undefined}
              title={a.disabled ?? undefined}
              onClick={(e) => {
                if (a.disabled || !runner) return;
                setOpen(false);
                runner.request(a, btn.current ?? e.currentTarget);
              }}
              className={cx(
                "block w-full rounded-md px-2.5 py-2 text-left text-sm focus-visible:outline-2 focus-visible:outline-sky-600",
                a.disabled ? "cursor-not-allowed text-zinc-500 dark:text-zinc-500" : "text-zinc-900 hover:bg-zinc-100 focus:bg-zinc-100 dark:text-zinc-100 dark:hover:bg-zinc-800 dark:focus:bg-zinc-800",
              )}
            >
              <span className="block font-medium">{a.label}</span>
              {a.disabled && <span className="block text-xs text-zinc-500 dark:text-zinc-400">{a.disabled}</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
