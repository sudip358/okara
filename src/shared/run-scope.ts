/**
 * Partial ("section") agent runs: shared contract and pure helpers used by the Worker (validation, step
 * selection) and the web app (Live panel buttons, Runs list labels). No I/O here.
 *
 * A manual run may target a subset of its agent's work steps (POST /projects/:pid/runs {agent, steps?,
 * engines?}). validate and summary always run. A step that needs earlier data uses the latest stored data
 * instead of re-running its predecessors (seo recommend reads the latest crawl + Search Console sync; geo
 * proposals read the latest stored answers). The scope is stored on agent_runs.scope_json (NULL = all steps).
 */
import type { AgentKind } from "./types";

/**
 * Manual runs per project per UTC day (POST /projects/:pid/runs, Ask Okara's run_agent_now). A partial run
 * counts as one manual run in the same cap; scheduled runs are not counted.
 */
export const MANUAL_RUNS_PER_DAY = 3;

/** Work steps per agent, in run order (short ids; the stored step names are "<agent>.<id>"). */
export const SECTION_STEPS = {
  seo: ["crawl", "gsc_sync", "recommend"],
  geo: ["batch", "proposals"],
} as const satisfies Record<AgentKind, readonly string[]>;

export type SeoSectionStep = (typeof SECTION_STEPS.seo)[number];
export type GeoSectionStep = (typeof SECTION_STEPS.geo)[number];
export type SectionStep = SeoSectionStep | GeoSectionStep;

/** The stored scope of a partial run (agent_runs.scope_json). Steps are short ids in run order. */
export interface RunScope {
  steps: SectionStep[];
  /** GEO batch only: the engine lanes asked ("gemini", "custom_geo:<id>", ...); null = every configured engine. */
  engines: string[] | null;
}

export const STEP_LABEL: Record<SectionStep, string> = {
  crawl: "crawl",
  gsc_sync: "Search Console sync",
  recommend: "judge + draft",
  batch: "ask AI engines",
  proposals: "proposals",
};

/** Accepts "crawl" or "seo.crawl"; returns the short id, or null when it is not a work step of the agent. */
export function normalizeStep(agent: AgentKind, raw: string): SectionStep | null {
  const s = raw.trim();
  const short = s.startsWith(`${agent}.`) ? s.slice(agent.length + 1) : s;
  return (SECTION_STEPS[agent] as readonly string[]).includes(short) ? (short as SectionStep) : null;
}

/** "Partial run: crawl only", "Partial run: crawl + Search Console sync", "Partial run: ask AI engines (Gemini) only". */
export function scopeLabel(scope: RunScope | null | undefined, engineName: (id: string) => string = (id) => id): string | null {
  if (!scope || scope.steps.length === 0) return null;
  const parts = scope.steps.map((s) => (s === "batch" && scope.engines?.length ? `${STEP_LABEL[s]} (${scope.engines.map(engineName).join(", ")})` : STEP_LABEL[s]));
  return `Partial run: ${parts.join(" + ")}${parts.length === 1 ? " only" : ""}`;
}

/** Parse a stored scope_json value (lenient: anything malformed reads as a full run). */
export function parseScope(raw: unknown): RunScope | null {
  let v: unknown = raw;
  if (typeof raw === "string") {
    try {
      v = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  if (!v || typeof v !== "object") return null;
  const o = v as { steps?: unknown; engines?: unknown };
  if (!Array.isArray(o.steps)) return null;
  const all = [...SECTION_STEPS.seo, ...SECTION_STEPS.geo] as readonly string[];
  const steps = o.steps.filter((s): s is SectionStep => typeof s === "string" && all.includes(s));
  if (steps.length === 0) return null;
  const engines = Array.isArray(o.engines) ? o.engines.filter((e): e is string => typeof e === "string") : null;
  return { steps, engines: engines && engines.length > 0 ? engines : null };
}
