/** [A2] recommendation card anatomy. All text rendered as plain text. */
import { Link } from "react-router";
import type { Recommendation, RecommendationStatus } from "@shared/types";
import { formatDate } from "@web/lib/format";
import { Badge, TierBadge } from "@web/components/ui";
import {
  DecisionFields,
  EffortUncertainty,
  PublishingFooter,
  ScopeBadge,
  SourceChip,
  StageTracker,
  TargetInfo,
  VerifiedFlag,
} from "./parts";
import { StatusActions } from "./StatusActions";

export function RecommendationCard({
  rec,
  projectId,
  onStatus,
  busy,
}: {
  rec: Recommendation;
  projectId: string;
  onStatus: (status: RecommendationStatus) => void;
  busy: boolean;
}) {
  const bullets = rec.evidenceBullets.slice(0, 4);
  const headingId = `rec-${rec.id}-title`;
  return (
    <article
      aria-labelledby={headingId}
      className="flex min-w-0 flex-col gap-3 rounded-xl border border-zinc-200 bg-white p-4 shadow-sm dark:border-zinc-800 dark:bg-zinc-900"
    >
      <header className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <p className="text-xs font-medium uppercase tracking-wide text-zinc-500 dark:text-zinc-400">{rec.trigger}</p>
          <h3 id={headingId} className="mt-0.5 break-words text-base font-semibold text-zinc-900 dark:text-zinc-50">
            <Link
              to={`/projects/${projectId}/recommendations/${rec.id}`}
              className="rounded hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-600 dark:focus-visible:outline-sky-400"
            >
              {rec.issue}
            </Link>
          </h3>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          {rec.isDemo && <Badge tone="demo">Demo data</Badge>}
          <ScopeBadge scope={rec.scope} />
          <VerifiedFlag verified={rec.verified} />
        </div>
      </header>

      <TargetInfo rec={rec} compact />

      {bullets.length > 0 ? (
        <ul className="space-y-1.5" aria-label="Evidence">
          {bullets.map((b) => (
            <li key={b.evidenceId} className="flex min-w-0 items-start gap-2 text-sm text-zinc-700 dark:text-zinc-200">
              <SourceChip source={b.source} />
              <span className="min-w-0 break-words">{b.text}</span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-sm text-zinc-500 dark:text-zinc-400">No evidence bullets attached.</p>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs font-medium text-zinc-500 dark:text-zinc-400">Decision</span>
        {rec.decision.tier ? <TierBadge tier={rec.decision.tier} /> : <span className="text-xs text-zinc-500 dark:text-zinc-400">No semantic judgment</span>}
        {rec.decision.tier && <DecisionFields decision={rec.decision} />}
      </div>

      <div className="rounded-md bg-zinc-50 p-3 dark:bg-zinc-800/60">
        <p className="text-xs font-medium text-zinc-500 dark:text-zinc-400">Action</p>
        <p className="mt-0.5 whitespace-pre-wrap break-words text-sm text-zinc-900 dark:text-zinc-100">{rec.action}</p>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2">
        <EffortUncertainty effort={rec.effort} uncertainty={rec.uncertainty} />
        <span className="text-xs text-zinc-500 dark:text-zinc-400">Created {formatDate(rec.createdAt)}</span>
      </div>

      <StageTracker stage={rec.stage} status={rec.status} />

      <footer className="flex flex-wrap items-center justify-between gap-2 border-t border-zinc-100 pt-3 dark:border-zinc-800">
        <PublishingFooter />
        <StatusActions status={rec.status} onStatus={onStatus} busy={busy} />
      </footer>
    </article>
  );
}
