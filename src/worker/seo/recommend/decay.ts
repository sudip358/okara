/**
 * [A25] Content decay: year-over-year seasonality check and likely-cause classification for declining
 * pages. Deterministic and versioned (DECAY_CAUSE_VERSION); pure.
 *
 * Year over year (only when the sync fetched last year's page slice, i.e. the property had data on >= 90%
 * of the same 28 days one year earlier; see gsc/slices.ts):
 *   seasonal       last year's clicks >= minPrevClicks and this window's clicks are not down by at least
 *                  minDrop against the same window last year -> the dip vs the previous window matches
 *                  last year's pattern, so the page is NOT flagged as declining (suppressed);
 *   down_yoy       this window is also down by >= minDrop against the same window last year;
 *   no_comparison  no YoY data for the page, or last year's clicks were below minPrevClicks.
 *
 * Likely causes (current vs previous 28-day window; more than one can apply):
 *   demand_or_season  impressions down by >= IMPRESSIONS_DOWN (20%) while position is stable (within
 *                     +/- POSITION_STABLE = 1.0): fewer searches, not a ranking change;
 *   ranking_loss      average position worse by more than POSITION_STABLE;
 *   ctr_drop          CTR down by >= CTR_DOWN (20%, relative) with stable position and impressions
 *                     changing by less than IMPRESSIONS_DOWN: a title or search-result change;
 *   content_changed   the page's content hash differs between its last two crawl snapshots.
 * Positions are page-level Search Console averages (a labelled approximation for query+page fallbacks).
 * Causes are hypotheses from the project's own data, never proof.
 */
export const DECAY_CAUSE_VERSION = "decay-causes-2026-09-30.1";
export const IMPRESSIONS_DOWN = 0.2;
export const POSITION_STABLE = 1.0;
export const CTR_DOWN = 0.2;

export type DecayCause = "demand_or_season" | "ranking_loss" | "ctr_drop" | "content_changed";

export const DECAY_CAUSE_LABEL: Record<DecayCause, string> = {
  demand_or_season: "demand or seasonality (impressions down, position stable)",
  ranking_loss: "ranking loss (average position worse)",
  ctr_drop: "click-through drop with stable position and impressions (title or search-result change)",
  content_changed: "content changed between the last two crawls",
};

export interface WindowMetric {
  clicks: number;
  impressions: number;
  position: number | null;
}

export interface DecayClassification {
  causes: DecayCause[];
  /** One sentence per cause, quoting the numbers it used (they are also in the evidence data). */
  details: string[];
  version: string;
}

const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
const pos = (x: number) => x.toFixed(1);

export function classifyDecay(prev: WindowMetric, cur: WindowMetric, content: { changed: boolean | null }): DecayClassification {
  const causes: DecayCause[] = [];
  const details: string[] = [];
  const posKnown = prev.position !== null && cur.position !== null && prev.position > 0 && cur.position > 0;
  const posDelta = posKnown ? cur.position! - prev.position! : null;
  const stable = posDelta !== null && Math.abs(posDelta) <= POSITION_STABLE;
  const imprChange = prev.impressions > 0 ? (cur.impressions - prev.impressions) / prev.impressions : null;
  const ctrPrev = prev.impressions > 0 ? prev.clicks / prev.impressions : null;
  const ctrCur = cur.impressions > 0 ? cur.clicks / cur.impressions : null;
  const ctrChange = ctrPrev !== null && ctrPrev > 0 && ctrCur !== null ? (ctrCur - ctrPrev) / ctrPrev : null;

  if (imprChange !== null && imprChange <= -IMPRESSIONS_DOWN && stable) {
    causes.push("demand_or_season");
    details.push(`impressions ${prev.impressions} -> ${cur.impressions} with average position ${pos(prev.position!)} -> ${pos(cur.position!)}`);
  }
  if (posDelta !== null && posDelta > POSITION_STABLE) {
    causes.push("ranking_loss");
    details.push(`average position ${pos(prev.position!)} -> ${pos(cur.position!)}`);
  }
  if (ctrChange !== null && ctrChange <= -CTR_DOWN && stable && imprChange !== null && Math.abs(imprChange) < IMPRESSIONS_DOWN) {
    causes.push("ctr_drop");
    details.push(`CTR ${pct(ctrPrev!)} -> ${pct(ctrCur!)} with impressions ${prev.impressions} -> ${cur.impressions}`);
  }
  if (content.changed === true) {
    causes.push("content_changed");
    details.push("content hash changed between the last two crawls");
  }
  return { causes, details, version: DECAY_CAUSE_VERSION };
}

export type YoyVerdict = "seasonal" | "down_yoy" | "no_comparison";

export function yoyVerdict(currentClicks: number, lastYear: WindowMetric | null, cfg: { minPrevClicks: number; minDrop: number }): YoyVerdict {
  if (!lastYear || lastYear.clicks < cfg.minPrevClicks) return "no_comparison";
  return currentClicks >= (1 - cfg.minDrop) * lastYear.clicks ? "seasonal" : "down_yoy";
}
