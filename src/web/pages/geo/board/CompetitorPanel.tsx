/**
 * C · Competitor pages: why an engine cites them (design §5). Read only for URLs a member approved, one at a
 * time, after an explicit confirmation. Host, not an inferred brand. Verdicts are Adapt / Skip / Review:
 * adapt the structure, never copy their text. No "x/10" score.
 */
import { useState } from "react";
import type { CompetitorCheck, CompetitorPageAssessment, EngineLaneSummary } from "@shared/types";
import { formatDateTime } from "@web/lib/format";
import { Badge, Button, Spinner, TBody, TD, TH, THead, TR, Table, TierBadge } from "@web/components/ui";
import { ExternalUrl } from "@web/components/ExternalUrl";
import { sourceTypeLabel } from "../lib";
import { approvalErrorMessage, useApproveCompetitorPage } from "./data";
import {
  ASSESSMENT_STATE,
  FACTOR_STATUS,
  LABELS,
  VERDICT,
  approvalCandidates,
  checkResultText,
  checkStatus,
  engineName,
  methodLabel,
  noulLabel,
  radarGeometry,
  type ApprovalCandidate,
} from "./lib";

/** Decorative radar of check presence; the table below is the accessible representation. */
export function CheckRadar({ checks }: { checks: CompetitorCheck[] }) {
  const g = radarGeometry(checks);
  return (
    <svg viewBox="0 0 120 120" aria-hidden="true" focusable="false" className="h-28 w-28 shrink-0">
      {g.rings.map((pts, i) => (
        <polygon key={i} points={pts} fill="none" strokeWidth={0.75} className="stroke-zinc-300 dark:stroke-zinc-700" />
      ))}
      {g.axes.map((a) => (
        <line key={a.key} x1={60} y1={60} x2={a.end.x} y2={a.end.y} strokeWidth={0.5} className="stroke-zinc-300 dark:stroke-zinc-700" />
      ))}
      {g.polygon && <polygon points={g.polygon} strokeWidth={1.5} className="fill-sky-600/20 stroke-sky-700 dark:fill-sky-400/20 dark:stroke-sky-300" />}
      {g.axes.map((a) =>
        a.point ? <circle key={a.key} cx={a.point.x} cy={a.point.y} r={2} className="fill-sky-700 dark:fill-sky-300" /> : null,
      )}
      {g.axes.map((a) => (
        <text
          key={a.key}
          x={a.labelAt.x}
          y={a.labelAt.y}
          fontSize={7}
          textAnchor={a.labelAt.x < 55 ? "end" : a.labelAt.x > 65 ? "start" : "middle"}
          dominantBaseline="middle"
          className="fill-zinc-600 dark:fill-zinc-400"
        >
          {a.label}
        </text>
      ))}
    </svg>
  );
}

export function CheckTable({ checks }: { checks: CompetitorCheck[] }) {
  return (
    <Table caption="Checks on the cited page">
      <THead>
        <TR>
          <TH>Check</TH>
          <TH>Result</TH>
          <TH>Method</TH>
        </TR>
      </THead>
      <TBody>
        {checks.map((c) => {
          const st = FACTOR_STATUS[checkStatus(c)];
          const noul = noulLabel(c.noul);
          return (
            <TR key={c.key}>
              <TD className="text-xs font-medium">{c.label}</TD>
              <TD className="min-w-0 text-xs">
                <Badge tone={st.tone}>{st.label}</Badge> <span className="break-words">{checkResultText(c)}</span>
                {noul && <span className="block text-[11px] text-zinc-600 dark:text-zinc-400">{noul}</span>}
              </TD>
              <TD className="text-xs">
                <span className="block whitespace-nowrap">{methodLabel(c.method)}</span>
                {c.method === "jev" && c.noul !== null && <TierBadge tier={c.tier} />}
              </TD>
            </TR>
          );
        })}
      </TBody>
    </Table>
  );
}

export function AssessmentCard({ a, showRadar }: { a: CompetitorPageAssessment; showRadar: boolean }) {
  const st = ASSESSMENT_STATE[a.state];
  const v = a.verdict ? VERDICT[a.verdict] : null;
  return (
    <article className="min-w-0 space-y-2 rounded-lg border border-zinc-200 p-3 dark:border-zinc-800">
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="break-all text-sm font-semibold text-zinc-900 dark:text-zinc-100">{a.host}</span>
        <Badge>{sourceTypeLabel(a.sourceType)}</Badge>
        <Badge tone={st.tone}>
          {st.pending && <Spinner className="h-3 w-3" />}
          {st.label}
        </Badge>
        {v && (
          <Badge tone={v.tone} title={v.note}>
            {v.label}
          </Badge>
        )}
      </div>
      <ExternalUrl url={a.url} />
      <p className="text-[11px] text-zinc-600 dark:text-zinc-400">{a.fetchedAt ? `Read ${formatDateTime(a.fetchedAt)}` : `Approved ${formatDateTime(a.approvedAt)}`}</p>
      {a.stateDetail && <p className="break-words text-xs text-zinc-700 dark:text-zinc-300">{a.stateDetail}</p>}
      {v && <p className="text-xs text-zinc-700 dark:text-zinc-300">{v.note}</p>}
      {a.reasons.length > 0 && (
        <div>
          <p className="text-[11px] font-medium text-zinc-600 dark:text-zinc-400">What the cited page does (observable)</p>
          <ul className="list-disc space-y-0.5 pl-4 text-xs text-zinc-800 dark:text-zinc-200">
            {a.reasons.map((r, i) => (
              <li key={i} className="break-words">
                {r}
              </li>
            ))}
          </ul>
        </div>
      )}
      {a.checks.length > 0 && (
        <div className="flex min-w-0 flex-col gap-2">
          {showRadar && <CheckRadar checks={a.checks} />}
          <CheckTable checks={a.checks} />
        </div>
      )}
    </article>
  );
}

/** "Assess this page": two-step, explicit confirmation before the single fetch. */
export function ApproveCandidate({ projectId, c, onApproved }: { projectId: string; c: ApprovalCandidate; onApproved: (a: CompetitorPageAssessment) => void }) {
  const [confirming, setConfirming] = useState(false);
  const m = useApproveCompetitorPage(projectId);
  return (
    <li className="min-w-0 space-y-1 border-t border-zinc-100 py-2 first:border-t-0 dark:border-zinc-800">
      <div className="flex flex-wrap items-center gap-1.5 text-xs">
        <span className="break-all font-medium text-zinc-900 dark:text-zinc-100">{c.host}</span>
        <span className="text-zinc-600 dark:text-zinc-400">via {sourceTypeLabel(c.sourceType)}</span>
      </div>
      <ExternalUrl url={c.url} />
      <p className="line-clamp-2 break-words text-[11px] text-zinc-600 dark:text-zinc-400" title={c.promptText}>
        Cited for “{c.promptText}”
      </p>
      {!confirming ? (
        <Button size="sm" onClick={() => setConfirming(true)} disabled={m.loading}>
          Assess this page
        </Button>
      ) : (
        <div role="group" aria-label="Confirm reading this page" className="space-y-1.5 rounded-lg border border-zinc-300 p-2 dark:border-zinc-700">
          <p className="text-xs text-zinc-800 dark:text-zinc-200">{LABELS.confirmFetch}</p>
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              variant="primary"
              loading={m.loading}
              onClick={async () => {
                const a = await m.run({ url: c.url });
                if (a) {
                  setConfirming(false);
                  onApproved(a);
                }
              }}
            >
              Fetch once and assess
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setConfirming(false)} disabled={m.loading}>
              Cancel
            </Button>
          </div>
        </div>
      )}
      {m.error !== null && (
        <p role="alert" className="text-xs text-red-700 dark:text-red-400">
          {approvalErrorMessage(m.error)}
        </p>
      )}
    </li>
  );
}

export function CompetitorBody({
  projectId,
  lane,
  all,
  assessments,
  showRadar,
  onApproved,
}: {
  projectId: string;
  lane: EngineLaneSummary;
  /** Every assessment of the project (to hide already-assessed candidates). */
  all: CompetitorPageAssessment[];
  /** Assessments cited by this engine. */
  assessments: CompetitorPageAssessment[];
  showRadar: boolean;
  onApproved: (a: CompetitorPageAssessment) => void;
}) {
  const candidates = approvalCandidates(lane.feed, all);
  const name = engineName(lane.provider);
  return (
    <div className="min-w-0 space-y-3">
      <p className="text-[11px] text-zinc-600 dark:text-zinc-400">
        Read only for URLs you approved · {LABELS.jev} on Jev rows, Measured on the rest
      </p>
      {assessments.length === 0 ? (
        <p className="text-xs text-zinc-600 dark:text-zinc-400">No page cited by {name} has been read yet.</p>
      ) : (
        <div className="space-y-2">
          {assessments.map((a) => (
            <AssessmentCard key={a.id} a={a} showRadar={showRadar} />
          ))}
        </div>
      )}
      {candidates.length > 0 && (
        <div className="min-w-0">
          <p className="text-[11px] font-medium text-zinc-600 dark:text-zinc-400">Pages {name} cited instead of you</p>
          <ul className="min-w-0">
            {candidates.map((c) => (
              <ApproveCandidate key={c.url} projectId={projectId} c={c} onApproved={onApproved} />
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
