/**
 * Finalized Search Console windows.
 *
 * Assumptions (documented, configurable):
 *  - Search Analytics data is reported in Pacific Time and becomes final roughly 2-3 days after the
 *    day ends. We request `dataState: "final"` and end the current window `lagDays` (default 3) full
 *    days before "today" in UTC, which covers both the PT offset and the finalization delay.
 *  - The current window is the `windowDays` (default 28) days ending at that date; the previous
 *    window is the `windowDays` days immediately before it. All dates are YYYY-MM-DD, inclusive.
 *  - If Google has not finalized a day inside the window yet, the API simply omits it; the daily
 *    series exposes that as missing trailing days, which are excluded rather than shown as zero.
 */
import type { DateWindow } from "@shared/types";
import { addDays, utcDay } from "../../lib/time";

export const GSC_FINAL_LAG_DAYS = 3;
export const GSC_WINDOW_DAYS = 28;
export const GSC_DATA_STATE = "final" as const;

export interface WindowOptions {
  lagDays?: number;
  windowDays?: number;
}

export interface GscWindows {
  current: DateWindow;
  previous: DateWindow;
  lagDays: number;
  windowDays: number;
}

export function finalizedWindows(now: Date, opts: WindowOptions = {}): GscWindows {
  const lagDays = opts.lagDays ?? GSC_FINAL_LAG_DAYS;
  const windowDays = opts.windowDays ?? GSC_WINDOW_DAYS;
  if (!Number.isInteger(lagDays) || lagDays < 0) throw new Error("lagDays must be a non-negative integer");
  if (!Number.isInteger(windowDays) || windowDays < 1) throw new Error("windowDays must be a positive integer");
  const end = addDays(utcDay(now), -lagDays);
  const start = addDays(end, -(windowDays - 1));
  const prevEnd = addDays(start, -1);
  const prevStart = addDays(prevEnd, -(windowDays - 1));
  return { current: { start, end }, previous: { start: prevStart, end: prevEnd }, lagDays, windowDays };
}

/** The comparable window immediately before `w` (same length). */
export function precedingWindow(w: DateWindow): DateWindow {
  const len = daysInWindow(w);
  const end = addDays(w.start, -1);
  return { start: addDays(end, -(len - 1)), end };
}

/** The comparable window immediately after `w` (same length). */
export function followingWindow(w: DateWindow): DateWindow {
  const len = daysInWindow(w);
  const start = addDays(w.end, 1);
  return { start, end: addDays(start, len - 1) };
}

/** Inclusive day count. */
export function daysInWindow(w: DateWindow): number {
  const ms = Date.parse(`${w.end}T00:00:00Z`) - Date.parse(`${w.start}T00:00:00Z`);
  return Math.round(ms / 86400_000) + 1;
}

/** Every date in the window, ascending. */
export function datesInWindow(w: DateWindow): string[] {
  const out: string[] = [];
  for (let d = w.start; d <= w.end; d = addDays(d, 1)) out.push(d);
  return out;
}

/** Evidence/window label, e.g. '2026-08-31..2026-09-27'. */
export function windowLabel(w: DateWindow): string {
  return `${w.start}..${w.end}`;
}

export const isIsoDate = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s) && utcDay(new Date(`${s}T00:00:00Z`)) === s;
