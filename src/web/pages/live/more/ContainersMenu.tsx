/**
 * "Containers ▾" in the Live header (docs/live-view-design.md section 17): show or hide each container of the
 * shown mode. Default all on; the choice is remembered per viewer and mode in localStorage (LivePage, wrapped in
 * try/catch). Menu button pattern: Enter / Space / ArrowDown open it, arrows / Home / End move, Space or Enter
 * toggles the focused item (the menu stays open), Escape or Tab closes it and returns focus to the button.
 */
import { useEffect, useId, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { cx } from "@web/components/ui";
import type { ContainerDef } from "./registry";

export function ContainersMenu({
  defs,
  hidden,
  onToggle,
  onShowAll,
  defaultOpen = false,
}: {
  defs: readonly ContainerDef[];
  hidden: ReadonlySet<string>;
  onToggle: (key: string) => void;
  onShowAll: () => void;
  /** Start open (server-rendered previews and tests). */
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const btn = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const menuId = useId();
  const items = () => Array.from(menu.current?.querySelectorAll<HTMLElement>('[role="menuitemcheckbox"],[role="menuitem"]') ?? []);
  const shown = defs.filter((d) => !hidden.has(d.key)).length;
  useEffect(() => {
    if (!open) return;
    items()[0]?.focus();
    const onDown = (e: MouseEvent) => {
      if (!menu.current?.contains(e.target as Node) && !btn.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);
  const close = () => {
    setOpen(false);
    btn.current?.focus();
  };
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
      close();
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
        title={`Containers shown: ${shown} of ${defs.length}`}
        onClick={() => setOpen((o) => !o)}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") {
            e.preventDefault();
            setOpen(true);
          }
        }}
        className="inline-flex h-7 shrink-0 items-center gap-1 rounded-md border border-zinc-300 bg-white px-2 text-xs font-medium whitespace-nowrap text-zinc-800 hover:bg-zinc-100 focus-visible:outline-2 focus-visible:outline-sky-600 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-200 dark:hover:bg-zinc-800"
      >
        <span aria-hidden="true">▦</span>
        <span className="sr-only sm:not-sr-only">Containers</span>
        {shown < defs.length && <span className="text-zinc-600 dark:text-zinc-400">{`${defs.length - shown} hidden`}</span>}
        <span aria-hidden="true">▾</span>
      </button>
      {open && (
        <div
          ref={menu}
          id={menuId}
          role="menu"
          aria-label="Show or hide containers"
          onKeyDown={onMenuKey}
          className="absolute right-0 z-40 mt-1 max-h-[70vh] w-[min(20rem,calc(100vw-2rem))] overflow-y-auto rounded-lg border border-zinc-200 bg-white p-1 shadow-lg dark:border-zinc-700 dark:bg-zinc-900"
        >
          {defs.map((d) => {
            const on = !hidden.has(d.key);
            return (
              <button
                key={d.key}
                type="button"
                role="menuitemcheckbox"
                aria-checked={on}
                tabIndex={-1}
                data-container={d.key}
                onClick={() => onToggle(d.key)}
                className="flex w-full min-w-0 items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm text-zinc-900 hover:bg-zinc-100 focus:bg-zinc-100 focus-visible:outline-2 focus-visible:outline-sky-600 dark:text-zinc-100 dark:hover:bg-zinc-800 dark:focus:bg-zinc-800"
              >
                <span
                  aria-hidden="true"
                  className={cx(
                    "inline-flex h-4 w-4 shrink-0 items-center justify-center rounded border text-[10px] font-bold",
                    on ? "border-zinc-900 bg-zinc-900 text-white dark:border-zinc-100 dark:bg-zinc-100 dark:text-zinc-900" : "border-zinc-400 dark:border-zinc-500",
                  )}
                >
                  {on ? "✓" : ""}
                </span>
                {d.num && <span className="shrink-0 font-mono text-xs text-zinc-500 dark:text-zinc-400">{d.num}</span>}
                <span className="min-w-0 truncate">{d.title}</span>
              </button>
            );
          })}
          <div className="my-1 border-t border-zinc-200 dark:border-zinc-700" role="none" />
          <button
            type="button"
            role="menuitem"
            tabIndex={-1}
            onClick={() => {
              onShowAll();
              close();
            }}
            className="block w-full rounded-md px-2 py-1.5 text-left text-sm text-zinc-900 hover:bg-zinc-100 focus:bg-zinc-100 focus-visible:outline-2 focus-visible:outline-sky-600 dark:text-zinc-100 dark:hover:bg-zinc-800 dark:focus:bg-zinc-800"
          >
            Show all
          </button>
        </div>
      )}
    </div>
  );
}
