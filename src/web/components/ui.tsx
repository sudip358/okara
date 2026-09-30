/**
 * Shared UI primitives. OWNED BY: web-shell; web-features pages import from "@web/components/ui".
 * Rules: render untrusted text as plain text children (never dangerouslySetInnerHTML); metrics always
 * carry numerator/denominator, window, source, and freshness via MetricTile sublabels.
 */
import {
  useEffect,
  useId,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type HTMLAttributes,
  type InputHTMLAttributes,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  type SelectHTMLAttributes,
  type TdHTMLAttributes,
  type TextareaHTMLAttributes,
  type ThHTMLAttributes,
} from "react";
import type { CapabilityState, Completeness, RunStatus, Tier } from "@shared/types";
import { errorMessage, isRateLimited, isSetupRequired } from "@web/lib/api";

export const cx = (...parts: Array<string | false | null | undefined>) => parts.filter(Boolean).join(" ");

// ------------------------------------------------------------------ layout
export function Card({
  title,
  description,
  actions,
  children,
  className,
  bodyClassName,
  id,
}: {
  title?: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  children?: ReactNode;
  className?: string;
  bodyClassName?: string;
  id?: string;
}) {
  const headingId = useId();
  return (
    <section
      id={id}
      aria-labelledby={title ? headingId : undefined}
      className={cx(
        "min-w-0 rounded-xl border border-zinc-200 bg-white shadow-sm dark:border-zinc-800 dark:bg-zinc-900",
        className,
      )}
    >
      {(title || actions) && (
        <header className="flex flex-wrap items-start justify-between gap-2 border-b border-zinc-100 px-4 py-3 dark:border-zinc-800">
          <div className="min-w-0">
            {title && (
              <h2 id={headingId} className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">
                {title}
              </h2>
            )}
            {description && <p className="mt-0.5 text-xs text-zinc-600 dark:text-zinc-400">{description}</p>}
          </div>
          {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
        </header>
      )}
      <div className={cx("p-4", bodyClassName)}>{children}</div>
    </section>
  );
}

export function PageHeader({ title, description, actions }: { title: ReactNode; description?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
      <div className="min-w-0">
        <h1 className="text-xl font-semibold tracking-tight text-zinc-900 dark:text-zinc-50">{title}</h1>
        {description && <p className="mt-1 max-w-3xl text-sm text-zinc-600 dark:text-zinc-400">{description}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

// ------------------------------------------------------------------ badge
export type BadgeTone = "neutral" | "success" | "warning" | "danger" | "info" | "demo";
const badgeTones: Record<BadgeTone, string> = {
  neutral: "bg-zinc-100 text-zinc-700 ring-zinc-300 dark:bg-zinc-800 dark:text-zinc-300 dark:ring-zinc-700",
  success: "bg-emerald-50 text-emerald-800 ring-emerald-300 dark:bg-emerald-950 dark:text-emerald-300 dark:ring-emerald-800",
  warning: "bg-amber-50 text-amber-900 ring-amber-300 dark:bg-amber-950 dark:text-amber-300 dark:ring-amber-800",
  danger: "bg-red-50 text-red-800 ring-red-300 dark:bg-red-950 dark:text-red-300 dark:ring-red-800",
  info: "bg-sky-50 text-sky-800 ring-sky-300 dark:bg-sky-950 dark:text-sky-300 dark:ring-sky-800",
  demo: "bg-fuchsia-50 text-fuchsia-800 ring-fuchsia-300 dark:bg-fuchsia-950 dark:text-fuchsia-300 dark:ring-fuchsia-800",
};

export function Badge({ tone = "neutral", children, className, title }: { tone?: BadgeTone; children: ReactNode; className?: string; title?: string }) {
  return (
    <span
      title={title}
      className={cx(
        "inline-flex max-w-full items-center gap-1 truncate rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset",
        badgeTones[tone],
        className,
      )}
    >
      {children}
    </span>
  );
}

// ------------------------------------------------------------------ button
export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";
export type ButtonSize = "sm" | "md";
const focusRing =
  "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-600 dark:focus-visible:outline-sky-400";

/** Class string for Links styled as buttons: <Link className={buttonClass("secondary")} /> */
export function buttonClass(variant: ButtonVariant = "secondary", size: ButtonSize = "md"): string {
  const base = cx(
    "inline-flex items-center justify-center gap-1.5 rounded-lg font-medium no-underline transition-colors hover:no-underline disabled:cursor-not-allowed disabled:opacity-50",
    focusRing,
    size === "sm" ? "px-2.5 py-1 text-xs" : "px-3.5 py-2 text-sm",
  );
  const variants: Record<ButtonVariant, string> = {
    primary: "bg-zinc-900 text-white hover:bg-zinc-700 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-300",
    secondary:
      "border border-zinc-300 bg-white text-zinc-800 hover:bg-zinc-50 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100 dark:hover:bg-zinc-800",
    ghost: "text-zinc-700 hover:bg-zinc-100 dark:text-zinc-300 dark:hover:bg-zinc-800",
    danger: "bg-red-700 text-white hover:bg-red-800 dark:bg-red-600 dark:hover:bg-red-500",
  };
  return cx(base, variants[variant]);
}

export function Button({
  variant = "secondary",
  size = "md",
  loading = false,
  className,
  children,
  disabled,
  type = "button",
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: ButtonVariant; size?: ButtonSize; loading?: boolean }) {
  return (
    <button
      type={type}
      className={cx(buttonClass(variant, size), className)}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      {...rest}
    >
      {loading && <Spinner className="h-3.5 w-3.5" />}
      {children}
    </button>
  );
}

// ------------------------------------------------------------------ forms
export const inputClass = cx(
  "block w-full rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-900 placeholder:text-zinc-400",
  "dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-100 dark:placeholder:text-zinc-500",
  "aria-[invalid=true]:border-red-600 dark:aria-[invalid=true]:border-red-500",
  focusRing,
);

export function Field({
  label,
  hint,
  error,
  children,
  htmlFor,
  required,
}: {
  label: ReactNode;
  hint?: ReactNode;
  error?: string | null;
  children: ReactNode;
  htmlFor: string;
  required?: boolean;
}) {
  return (
    <div className="min-w-0">
      <label htmlFor={htmlFor} className="mb-1 block text-sm font-medium text-zinc-800 dark:text-zinc-200">
        {label}
        {required && <span className="text-red-700 dark:text-red-400"> *</span>}
      </label>
      {children}
      {hint && !error && (
        <p id={`${htmlFor}-hint`} className="mt-1 text-xs text-zinc-600 dark:text-zinc-400">
          {hint}
        </p>
      )}
      {error && (
        <p id={`${htmlFor}-error`} role="alert" className="mt-1 text-xs text-red-700 dark:text-red-400">
          {error}
        </p>
      )}
    </div>
  );
}

type WithLabel = { label: ReactNode; hint?: ReactNode; error?: string | null };

export function TextField({ label, hint, error, id, className, required, ...rest }: InputHTMLAttributes<HTMLInputElement> & WithLabel) {
  const auto = useId();
  const fid = id ?? auto;
  return (
    <Field label={label} hint={hint} error={error} htmlFor={fid} required={required}>
      <input
        id={fid}
        className={cx(inputClass, className)}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? `${fid}-error` : hint ? `${fid}-hint` : undefined}
        required={required}
        {...rest}
      />
    </Field>
  );
}

export function TextArea({ label, hint, error, id, className, required, ...rest }: TextareaHTMLAttributes<HTMLTextAreaElement> & WithLabel) {
  const auto = useId();
  const fid = id ?? auto;
  return (
    <Field label={label} hint={hint} error={error} htmlFor={fid} required={required}>
      <textarea
        id={fid}
        className={cx(inputClass, "min-h-20", className)}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? `${fid}-error` : hint ? `${fid}-hint` : undefined}
        required={required}
        {...rest}
      />
    </Field>
  );
}

export function SelectField({
  label,
  hint,
  error,
  id,
  className,
  children,
  required,
  ...rest
}: SelectHTMLAttributes<HTMLSelectElement> & WithLabel) {
  const auto = useId();
  const fid = id ?? auto;
  return (
    <Field label={label} hint={hint} error={error} htmlFor={fid} required={required}>
      <select
        id={fid}
        className={cx(inputClass, className)}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? `${fid}-error` : hint ? `${fid}-hint` : undefined}
        required={required}
        {...rest}
      >
        {children}
      </select>
    </Field>
  );
}

// ------------------------------------------------------------------ table
/** Wraps a table in its own horizontal scroller so the page never scrolls sideways. */
export function Table({ caption, children, className }: { caption?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <div className="-mx-4 overflow-x-auto px-4 sm:mx-0 sm:px-0">
      <table className={cx("w-full border-collapse text-left text-sm", className)}>
        {caption && <caption className="sr-only">{caption}</caption>}
        {children}
      </table>
    </div>
  );
}
export const THead = ({ children }: { children: ReactNode }) => (
  <thead className="border-b border-zinc-200 text-xs uppercase tracking-wide text-zinc-600 dark:border-zinc-800 dark:text-zinc-400">
    {children}
  </thead>
);
export const TBody = ({ children }: { children: ReactNode }) => (
  <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">{children}</tbody>
);
export const TR = ({ children, className, ...rest }: HTMLAttributes<HTMLTableRowElement>) => (
  <tr className={cx("align-top", className)} {...rest}>
    {children}
  </tr>
);
export const TH = ({ children, className, ...rest }: ThHTMLAttributes<HTMLTableCellElement>) => (
  <th scope="col" className={cx("whitespace-nowrap px-2 py-2 font-medium first:pl-0 last:pr-0", className)} {...rest}>
    {children}
  </th>
);
export const TD = ({ children, className, ...rest }: TdHTMLAttributes<HTMLTableCellElement>) => (
  <td className={cx("px-2 py-2 text-zinc-800 first:pl-0 last:pr-0 dark:text-zinc-200", className)} {...rest}>
    {children}
  </td>
);

// ------------------------------------------------------------------ states
export function Spinner({ className }: { className?: string }) {
  return (
    <svg className={cx("h-4 w-4 animate-spin", className)} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle cx="12" cy="12" r="10" stroke="currentColor" strokeOpacity="0.25" strokeWidth="4" />
      <path d="M22 12a10 10 0 0 0-10-10" stroke="currentColor" strokeWidth="4" strokeLinecap="round" />
    </svg>
  );
}

export function LoadingState({ label = "Loading…", className }: { label?: string; className?: string }) {
  return (
    <div role="status" aria-live="polite" className={cx("flex items-center gap-2 py-6 text-sm text-zinc-600 dark:text-zinc-400", className)}>
      <Spinner />
      <span>{label}</span>
    </div>
  );
}

export function EmptyState({ title, children, action }: { title: ReactNode; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="rounded-lg border border-dashed border-zinc-300 px-4 py-8 text-center dark:border-zinc-700">
      <p className="text-sm font-medium text-zinc-800 dark:text-zinc-200">{title}</p>
      {children && <div className="mx-auto mt-1 max-w-prose text-sm text-zinc-600 dark:text-zinc-400">{children}</div>}
      {action && <div className="mt-3 flex justify-center">{action}</div>}
    </div>
  );
}

/**
 * Error display. Maps HTTP 412/setup_required to a "Setup required" banner and 429 to "Rate limited"
 * so pages don't have to.
 */
export function ErrorState({ error, onRetry, title }: { error: unknown; onRetry?: () => void; title?: string }) {
  const state: HonestState = isSetupRequired(error) ? "setup_required" : isRateLimited(error) ? "rate_limited" : "failed";
  return (
    <StateBanner
      state={state}
      title={title}
      message={errorMessage(error)}
      action={onRetry ? <Button size="sm" onClick={onRetry}>Retry</Button> : undefined}
    />
  );
}

/** Every honest state named in the spec, plus capability states. */
export type HonestState =
  | CapabilityState
  | RunStatus
  | "no_data"
  | "insufficient_evidence"
  | "not_connected";

const stateMeta: Record<HonestState, { label: string; tone: BadgeTone }> = {
  ready: { label: "Ready", tone: "success" },
  setup_required: { label: "Setup required", tone: "warning" },
  disabled: { label: "Disabled", tone: "neutral" },
  error: { label: "Error", tone: "danger" },
  demo: { label: "Demo", tone: "demo" },
  pending: { label: "Pending", tone: "neutral" },
  running: { label: "Running", tone: "info" },
  partial: { label: "Partial", tone: "warning" },
  completed: { label: "Completed", tone: "success" },
  failed: { label: "Failed", tone: "danger" },
  rate_limited: { label: "Rate limited", tone: "warning" },
  cancelled: { label: "Cancelled", tone: "neutral" },
  no_data: { label: "No data", tone: "neutral" },
  insufficient_evidence: { label: "Insufficient evidence", tone: "neutral" },
  not_connected: { label: "Not connected", tone: "neutral" },
};

export function stateLabel(state: HonestState): string {
  return stateMeta[state]?.label ?? state;
}

export function StateBadge({ state }: { state: HonestState }) {
  const m = stateMeta[state] ?? { label: state, tone: "neutral" as const };
  return <Badge tone={m.tone}>{m.label}</Badge>;
}

const bannerTones: Record<BadgeTone, string> = {
  neutral: "border-zinc-300 bg-zinc-50 text-zinc-800 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-200",
  success: "border-emerald-300 bg-emerald-50 text-emerald-900 dark:border-emerald-800 dark:bg-emerald-950 dark:text-emerald-200",
  warning: "border-amber-300 bg-amber-50 text-amber-950 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-200",
  danger: "border-red-300 bg-red-50 text-red-900 dark:border-red-800 dark:bg-red-950 dark:text-red-200",
  info: "border-sky-300 bg-sky-50 text-sky-900 dark:border-sky-800 dark:bg-sky-950 dark:text-sky-200",
  demo: "border-fuchsia-300 bg-fuchsia-50 text-fuchsia-900 dark:border-fuchsia-800 dark:bg-fuchsia-950 dark:text-fuchsia-200",
};

/** Honest-state banner: "Setup required: connect Google Search Console." etc. */
export function StateBanner({
  state,
  message,
  title,
  action,
  className,
}: {
  state: HonestState;
  message?: ReactNode;
  title?: ReactNode;
  action?: ReactNode;
  className?: string;
}) {
  const m = stateMeta[state] ?? { label: state, tone: "neutral" as const };
  const urgent = state === "failed" || state === "error";
  return (
    <div
      role={urgent ? "alert" : "status"}
      className={cx("flex flex-wrap items-start justify-between gap-2 rounded-lg border px-3 py-2 text-sm", bannerTones[m.tone], className)}
    >
      <div className="min-w-0">
        <span className="font-semibold">{title ?? m.label}</span>
        {message !== undefined && message !== null && (typeof message === "string" || typeof message === "number" ? <span className="break-words">{": "}{message}</span> : <div className="mt-1 break-words">{message}</div>)}
      </div>
      {action && <div className="shrink-0">{action}</div>}
    </div>
  );
}

/** Persistent label required on every demo screen (OPERATING RULE 6). */
export function DemoBanner() {
  return (
    <div
      role="note"
      aria-label="Demo data notice"
      className="sticky top-0 z-30 border-b border-fuchsia-300 bg-fuchsia-100 px-4 py-1.5 text-center text-sm font-semibold text-fuchsia-900 dark:border-fuchsia-800 dark:bg-fuchsia-950 dark:text-fuchsia-100"
    >
      Demo data – simulated run. Nothing on this project was measured from a live source.
    </div>
  );
}

// ------------------------------------------------------------------ metrics
/**
 * A metric with its provenance. `sublabel` for free text; `numerator`/`denominator`/`window`/`source`/
 * `freshness` render as a compact provenance line under the value.
 */
export function MetricTile({
  label,
  value,
  sublabel,
  numerator,
  denominator,
  window,
  source,
  freshness,
  state,
  className,
}: {
  label: ReactNode;
  value: ReactNode;
  sublabel?: ReactNode;
  numerator?: number;
  denominator?: number;
  window?: string;
  source?: string;
  freshness?: string;
  state?: HonestState;
  className?: string;
}) {
  const provenance = [
    numerator !== undefined && denominator !== undefined ? `${numerator.toLocaleString()} of ${denominator.toLocaleString()}` : null,
    window,
    source ? `Source: ${source}` : null,
    freshness,
  ].filter(Boolean) as string[];
  return (
    <div className={cx("min-w-0 rounded-lg border border-zinc-200 p-3 dark:border-zinc-800", className)}>
      <div className="flex items-start justify-between gap-2">
        <p className="text-xs font-medium text-zinc-600 dark:text-zinc-400">{label}</p>
        {state && <StateBadge state={state} />}
      </div>
      <p className="mt-1 text-xl font-semibold tabular-nums text-zinc-900 dark:text-zinc-50">{value}</p>
      {sublabel && <p className="mt-0.5 text-xs text-zinc-600 dark:text-zinc-400">{sublabel}</p>}
      {provenance.length > 0 && <p className="mt-0.5 text-xs text-zinc-500 dark:text-zinc-400">{provenance.join(" · ")}</p>}
    </div>
  );
}

export function CompletenessNote({ completeness, className }: { completeness: Completeness | null | undefined; className?: string }) {
  if (!completeness || !completeness.note) return null;
  return (
    <p className={cx("text-xs text-zinc-600 dark:text-zinc-400", className)}>
      <span className="font-medium">Coverage:</span> {completeness.note}
    </p>
  );
}

// ------------------------------------------------------------------ run status / tier
export function StatusBadge({ status }: { status: RunStatus }) {
  return <StateBadge state={status} />;
}

/** [A13] tiers: act = Jev value used; flag = "Check this yourself"; drop = value withheld. */
export function TierBadge({ tier }: { tier: Tier | null | undefined }) {
  if (!tier || tier === "n/a") return <Badge tone="neutral">No Jev tier</Badge>;
  if (tier === "act") return <Badge tone="success" title="Used directly in ranking">Jev: act</Badge>;
  if (tier === "flag") return <Badge tone="warning" title="Used, but verify">Check this yourself</Badge>;
  return <Badge tone="neutral" title="Jev value withheld; deterministic signals only">Jev value withheld</Badge>;
}

// ------------------------------------------------------------------ tabs
export interface TabItem {
  id: string;
  label: ReactNode;
  content: ReactNode;
}

/** Accessible tabs (roving tabindex, arrow keys, Home/End). Controlled when `value` is given. */
export function Tabs({
  tabs,
  value,
  onChange,
  label,
  className,
}: {
  tabs: TabItem[];
  value?: string;
  onChange?: (id: string) => void;
  label: string;
  className?: string;
}) {
  const base = useId();
  const [internal, setInternal] = useState(tabs[0]?.id ?? "");
  const active = value ?? internal;
  const refs = useRef<Array<HTMLButtonElement | null>>([]);
  const select = (id: string) => {
    if (value === undefined) setInternal(id);
    onChange?.(id);
  };
  const onKey = (e: ReactKeyboardEvent, i: number) => {
    let next = -1;
    if (e.key === "ArrowRight") next = (i + 1) % tabs.length;
    else if (e.key === "ArrowLeft") next = (i - 1 + tabs.length) % tabs.length;
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = tabs.length - 1;
    if (next >= 0) {
      e.preventDefault();
      const t = tabs[next];
      if (t) {
        select(t.id);
        refs.current[next]?.focus();
      }
    }
  };
  return (
    <div className={className}>
      <div role="tablist" aria-label={label} className="flex gap-1 overflow-x-auto border-b border-zinc-200 dark:border-zinc-800">
        {tabs.map((t, i) => {
          const selected = t.id === active;
          return (
            <button
              key={t.id}
              ref={(el) => {
                refs.current[i] = el;
              }}
              role="tab"
              type="button"
              id={`${base}-tab-${t.id}`}
              aria-selected={selected}
              aria-controls={`${base}-panel-${t.id}`}
              tabIndex={selected ? 0 : -1}
              onClick={() => select(t.id)}
              onKeyDown={(e) => onKey(e, i)}
              className={cx(
                "-mb-px whitespace-nowrap border-b-2 px-3 py-2 text-sm font-medium",
                focusRing,
                selected
                  ? "border-zinc-900 text-zinc-900 dark:border-zinc-100 dark:text-zinc-50"
                  : "border-transparent text-zinc-600 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-100",
              )}
            >
              {t.label}
            </button>
          );
        })}
      </div>
      {tabs.map((t) =>
        t.id === active ? (
          <div key={t.id} role="tabpanel" id={`${base}-panel-${t.id}`} aria-labelledby={`${base}-tab-${t.id}`} tabIndex={0} className="pt-4 focus-visible:outline-none">
            {t.content}
          </div>
        ) : null,
      )}
    </div>
  );
}

// ------------------------------------------------------------------ drawer
const FOCUSABLE =
  'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * Accessible side drawer: role="dialog", aria-modal, focus trap, Esc closes, focus returns to the opener.
 */
export function Drawer({
  open,
  onClose,
  title,
  children,
  footer,
  widthClassName = "sm:max-w-2xl",
}: {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  widthClassName?: string;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    if (!open) return;
    const opener = document.activeElement as HTMLElement | null;
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const panel = panelRef.current;
    const first = panel?.querySelector<HTMLElement>(FOCUSABLE);
    (first ?? panel)?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onCloseRef.current();
        return;
      }
      if (e.key !== "Tab" || !panel) return;
      const items = Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((el) => el.offsetParent !== null);
      if (items.length === 0) {
        e.preventDefault();
        panel.focus();
        return;
      }
      const firstEl = items[0]!;
      const lastEl = items[items.length - 1]!;
      if (e.shiftKey && (document.activeElement === firstEl || document.activeElement === panel)) {
        e.preventDefault();
        lastEl.focus();
      } else if (!e.shiftKey && document.activeElement === lastEl) {
        e.preventDefault();
        firstEl.focus();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prevOverflow;
      opener?.focus?.();
    };
  }, [open]);

  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex justify-end">
      <div className="absolute inset-0 bg-zinc-950/40" aria-hidden="true" onClick={onClose} />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        className={cx(
          "relative flex h-full w-full flex-col bg-white shadow-xl focus:outline-none dark:bg-zinc-900",
          widthClassName,
        )}
      >
        <div className="flex items-start justify-between gap-3 border-b border-zinc-200 px-4 py-3 dark:border-zinc-800">
          <h2 id={titleId} className="min-w-0 break-words text-base font-semibold text-zinc-900 dark:text-zinc-50">
            {title}
          </h2>
          <Button variant="ghost" size="sm" onClick={onClose} aria-label="Close">
            <span aria-hidden="true">✕</span>
          </Button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">{children}</div>
        {footer && <div className="border-t border-zinc-200 px-4 py-3 dark:border-zinc-800">{footer}</div>}
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ misc
/** Plain-text block for untrusted text (HTML, AI answers). Never interprets markup. */
export function PlainText({ text, className }: { text: string | null | undefined; className?: string }) {
  if (!text) return null;
  return <div className={cx("whitespace-pre-wrap break-words text-sm", className)}>{text}</div>;
}

export function Definition({ term, children }: { term: ReactNode; children: ReactNode }) {
  return (
    <div className="flex flex-wrap gap-x-2 text-sm">
      <dt className="text-zinc-600 dark:text-zinc-400">{term}</dt>
      <dd className="min-w-0 break-words text-zinc-900 dark:text-zinc-100">{children}</dd>
    </div>
  );
}
