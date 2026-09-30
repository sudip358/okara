/** Chip list input (aliases, domains). Enter or comma adds; Backspace on empty removes last. OWNED BY: web-shell. */
import { useId, useState, type KeyboardEvent } from "react";
import { cx, inputClass } from "./ui";

export function ChipInput({
  label,
  values,
  onChange,
  placeholder,
  hint,
  error,
  max = 20,
  normalize = (s: string) => s.trim(),
  validate,
}: {
  label: string;
  values: string[];
  onChange: (next: string[]) => void;
  placeholder?: string;
  hint?: string;
  error?: string | null;
  max?: number;
  normalize?: (s: string) => string;
  /** Return an error message to reject a value. */
  validate?: (v: string) => string | null;
}) {
  const id = useId();
  const [draft, setDraft] = useState("");
  const [localError, setLocalError] = useState<string | null>(null);

  const add = (raw: string) => {
    const parts = raw.split(",").map(normalize).filter(Boolean);
    if (parts.length === 0) return;
    const next = [...values];
    for (const p of parts) {
      const err = validate?.(p) ?? null;
      if (err) {
        setLocalError(err);
        return;
      }
      if (next.length >= max) {
        setLocalError(`Up to ${max} values.`);
        break;
      }
      if (!next.some((v) => v.toLowerCase() === p.toLowerCase())) next.push(p);
    }
    setLocalError(null);
    onChange(next);
    setDraft("");
  };

  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter" || e.key === ",") {
      e.preventDefault();
      add(draft);
    } else if (e.key === "Backspace" && draft === "" && values.length > 0) {
      onChange(values.slice(0, -1));
    }
  };
  const shownError = localError ?? error ?? null;

  return (
    <div className="min-w-0">
      <label htmlFor={id} className="mb-1 block text-sm font-medium text-zinc-800 dark:text-zinc-200">
        {label}
      </label>
      {values.length > 0 && (
        <ul className="mb-1.5 flex flex-wrap gap-1.5" aria-label={`${label} values`}>
          {values.map((v) => (
            <li
              key={v}
              className="inline-flex max-w-full items-center gap-1 rounded-full bg-zinc-100 py-0.5 pl-2.5 pr-1 text-xs text-zinc-800 dark:bg-zinc-800 dark:text-zinc-200"
            >
              <span className="truncate">{v}</span>
              <button
                type="button"
                onClick={() => onChange(values.filter((x) => x !== v))}
                className="rounded-full px-1 text-zinc-500 hover:bg-zinc-200 hover:text-zinc-900 focus-visible:outline-2 focus-visible:outline-sky-600 dark:hover:bg-zinc-700 dark:hover:text-zinc-100"
                aria-label={`Remove ${v}`}
              >
                ✕
              </button>
            </li>
          ))}
        </ul>
      )}
      <input
        id={id}
        className={cx(inputClass)}
        value={draft}
        placeholder={placeholder}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={onKey}
        onBlur={() => draft.trim() && add(draft)}
        aria-invalid={shownError ? true : undefined}
        aria-describedby={shownError ? `${id}-err` : hint ? `${id}-hint` : undefined}
      />
      {hint && !shownError && (
        <p id={`${id}-hint`} className="mt-1 text-xs text-zinc-600 dark:text-zinc-400">
          {hint}
        </p>
      )}
      {shownError && (
        <p id={`${id}-err`} role="alert" className="mt-1 text-xs text-red-700 dark:text-red-400">
          {shownError}
        </p>
      )}
    </div>
  );
}
