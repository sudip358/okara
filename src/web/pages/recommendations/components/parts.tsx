/** Small presentational parts for recommendation cards/detail. Plain text only; no HTML from data. */
import type { EvidenceSource, Recommendation, RecommendationStage } from "@shared/types";
import { STAGES, decisionFieldPairs, sourceLabel } from "../lib";

const SOURCE_TONE: Record<EvidenceSource, string> = {
  gsc: "bg-sky-50 text-sky-800 ring-sky-200 dark:bg-sky-950/60 dark:text-sky-200 dark:ring-sky-800",
  crawl: "bg-emerald-50 text-emerald-800 ring-emerald-200 dark:bg-emerald-950/60 dark:text-emerald-200 dark:ring-emerald-800",
  context_doc: "bg-violet-50 text-violet-800 ring-violet-200 dark:bg-violet-950/60 dark:text-violet-200 dark:ring-violet-800",
  geo_observation: "bg-amber-50 text-amber-800 ring-amber-200 dark:bg-amber-950/60 dark:text-amber-200 dark:ring-amber-800",
  manual_import: "bg-orange-50 text-orange-800 ring-orange-200 dark:bg-orange-950/60 dark:text-orange-200 dark:ring-orange-800",
  rule: "bg-zinc-100 text-zinc-700 ring-zinc-200 dark:bg-zinc-800 dark:text-zinc-200 dark:ring-zinc-700",
};

export function SourceChip({ source }: { source: EvidenceSource | string }) {
  const tone = (SOURCE_TONE as Record<string, string>)[source] ?? SOURCE_TONE.rule;
  return (
    <span className={`inline-flex shrink-0 items-center rounded px-1.5 py-0.5 text-[11px] font-medium ring-1 ring-inset ${tone}`}>
      {sourceLabel(source)}
    </span>
  );
}

export function ScopeBadge({ scope }: { scope: Recommendation["scope"] }) {
  const label = scope === "page" ? "Page" : scope === "template" ? "Template" : "Site";
  return (
    <span className="inline-flex items-center rounded-full bg-zinc-100 px-2 py-0.5 text-xs font-medium text-zinc-700 ring-1 ring-inset ring-zinc-200 dark:bg-zinc-800 dark:text-zinc-200 dark:ring-zinc-700">
      Scope: {label}
    </span>
  );
}

/** Target line: URL, template (with affected count + up to 3 example URLs), or site. */
export function TargetInfo({ rec, compact = false }: { rec: Recommendation; compact?: boolean }) {
  const t = rec.target;
  if (t.kind === "url" && t.url) {
    return (
      <p className="min-w-0 break-all text-sm text-zinc-600 dark:text-zinc-300">
        <span className="font-medium text-zinc-700 dark:text-zinc-200">URL: </span>
        {t.url}
      </p>
    );
  }
  if (t.kind === "template") {
    const examples = (t.exampleUrls ?? []).slice(0, 3);
    return (
      <div className="min-w-0 text-sm text-zinc-600 dark:text-zinc-300">
        <p>
          <span className="font-medium text-zinc-700 dark:text-zinc-200">Template: </span>
          {t.template ?? "Unnamed template"}
          {typeof t.affectedUrlCount === "number" ? (
            <span> · {t.affectedUrlCount} affected URL{t.affectedUrlCount === 1 ? "" : "s"} in crawl</span>
          ) : (
            <span> · affected URL count unavailable</span>
          )}
        </p>
        {examples.length > 0 && (
          <ul className={`mt-1 space-y-0.5 ${compact ? "text-xs" : "text-sm"}`} aria-label="Example URLs">
            {examples.map((u) => (
              <li key={u} className="break-all text-zinc-500 dark:text-zinc-400">
                e.g. {u}
              </li>
            ))}
          </ul>
        )}
      </div>
    );
  }
  return <p className="text-sm text-zinc-600 dark:text-zinc-300">Site-wide</p>;
}

/** Decision fields rendered with the provider's real field names, e.g. "confidence 0.83" or "noul 0.91". */
export function DecisionFields({ decision }: { decision: Recommendation["decision"] }) {
  if (decision.tier === "drop") {
    return <span className="text-xs text-zinc-500 dark:text-zinc-400">Judgment withheld (below threshold); deterministic signals only</span>;
  }
  const pairs = decisionFieldPairs(decision.fields);
  if (pairs.length === 0) {
    return <span className="text-xs text-zinc-500 dark:text-zinc-400">No decision value recorded</span>;
  }
  return (
    <span className="inline-flex flex-wrap items-center gap-1.5 text-xs text-zinc-700 dark:text-zinc-200">
      {pairs.map((p) => (
        <span key={p.name} className="rounded bg-zinc-100 px-1.5 py-0.5 font-mono dark:bg-zinc-800">
          {p.name} {p.value}
        </span>
      ))}
      {decision.provider && <span className="text-zinc-500 dark:text-zinc-400">via {decision.provider}</span>}
    </span>
  );
}

export function StageTracker({ stage, status }: { stage: RecommendationStage; status: Recommendation["status"] }) {
  const current = STAGES.findIndex((s) => s.key === stage);
  return (
    <div>
      <ol className="flex flex-wrap items-center gap-x-1 gap-y-1 text-[11px] sm:text-xs" aria-label="Pipeline stage">
        {STAGES.map((s, i) => {
          const done = i < current || (i === current && s.key === "marked_implemented");
          const active = i === current;
          const tone = active
            ? "bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900"
            : done
              ? "bg-sky-100 text-sky-900 dark:bg-sky-950 dark:text-sky-200"
              : "bg-zinc-100 text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400";
          return (
            <li key={s.key} className="flex items-center gap-1" aria-current={active ? "step" : undefined}>
              <span className={`rounded-full px-2 py-0.5 font-medium ${tone}`}>{s.label}</span>
              {i < STAGES.length - 1 && (
                <span aria-hidden="true" className="text-zinc-400 dark:text-zinc-600">
                  →
                </span>
              )}
            </li>
          );
        })}
      </ol>
      {status === "dismissed" && <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">Dismissed; stays dismissed on reruns.</p>}
    </div>
  );
}

export function VerifiedFlag({ verified }: { verified: boolean }) {
  if (verified) {
    return (
      <span className="inline-flex items-center rounded-full bg-emerald-50 px-2 py-0.5 text-xs font-medium text-emerald-800 ring-1 ring-inset ring-emerald-200 dark:bg-emerald-950/60 dark:text-emerald-200 dark:ring-emerald-800">
        Verified against evidence
      </span>
    );
  }
  return (
    <span className="inline-flex items-center rounded-full bg-amber-50 px-2 py-0.5 text-xs font-medium text-amber-900 ring-1 ring-inset ring-amber-300 dark:bg-amber-950/60 dark:text-amber-200 dark:ring-amber-700">
      Unverified – review required
    </span>
  );
}

export function PublishingFooter() {
  return <p className="text-xs text-zinc-500 dark:text-zinc-400">Publishing: manual (not connected)</p>;
}

const LEVEL_LABEL = { low: "Low", medium: "Medium", high: "High" } as const;
export function EffortUncertainty({ effort, uncertainty }: { effort: Recommendation["effort"]; uncertainty: Recommendation["uncertainty"] }) {
  return (
    <span className="text-xs text-zinc-600 dark:text-zinc-300">
      Effort: <strong className="font-medium">{LEVEL_LABEL[effort]}</strong> · Uncertainty: <strong className="font-medium">{LEVEL_LABEL[uncertainty]}</strong>
    </span>
  );
}
