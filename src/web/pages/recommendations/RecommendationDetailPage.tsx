/**
 * Recommendation detail + approval. Route: /projects/:projectId/recommendations/:recId
 * All stored text (evidence, answers, drafts) is rendered as plain text.
 */
import { useEffect, useState } from "react";
import { Link, useParams } from "react-router";
import type { DecisionRecord, RecommendationDetail, RecommendationStatus } from "@shared/types";
import { api, errorMessage } from "@web/lib/api";
import { formatDateTime } from "@web/lib/format";
import { useApi } from "@web/lib/hooks";
import {
  Badge,
  Button,
  Card,
  Definition,
  ErrorState,
  LoadingState,
  PageHeader,
  PlainText,
  StateBanner,
  TBody,
  TD,
  TH,
  THead,
  TR,
  Table,
  TextArea,
  TierBadge,
  buttonClass,
} from "@web/components/ui";
import {
  DecisionFields,
  EffortUncertainty,
  PublishingFooter,
  ScopeBadge,
  SourceChip,
  StageTracker,
  TargetInfo,
  VerifiedFlag,
} from "./components/parts";
import { StatusActions } from "./components/StatusActions";
import { DisagreeControl } from "./components/DisagreeControl";
import { reasonLabel } from "@web/components/DecisionLog";
import { STATUS_LABEL, answerSummary, humanize, runnerUpFromAnswer, showsJevValue } from "./lib";

export function RecommendationDetailPage() {
  const { projectId = "", recId = "" } = useParams();
  const { data: rec, error, loading, reload } = useApi<RecommendationDetail>(recId ? `/recommendations/${encodeURIComponent(recId)}` : null);
  const backTo = `/projects/${encodeURIComponent(projectId)}/recommendations`;

  if (loading && !rec) return <LoadingState label="Loading recommendation…" />;
  if (error || !rec) {
    return (
      <div className="space-y-3">
        <Link to={backTo} className={buttonClass("ghost", "sm")}>
          ← All recommendations
        </Link>
        {error ? <ErrorState error={error} onRetry={reload} /> : <StateBanner state="no_data" message="Recommendation not found." />}
      </div>
    );
  }
  return <Detail rec={rec} backTo={`${backTo}?agent=${rec.agent}&status=${rec.status}`} reload={reload} />;
}

function Detail({ rec, backTo, reload }: { rec: RecommendationDetail; backTo: string; reload: () => void }) {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  const patch = async (body: { status?: RecommendationStatus; action?: string; suggestedSnippet?: string | null; note?: string }, okText: string) => {
    setBusy(true);
    setMessage(null);
    try {
      await api<unknown>(`/recommendations/${encodeURIComponent(rec.id)}`, { method: "PATCH", body });
      setMessage({ ok: true, text: okText });
      reload();
      return true;
    } catch (e) {
      setMessage({ ok: false, text: errorMessage(e) });
      return false;
    } finally {
      setBusy(false);
    }
  };

  const onStatus = (s: RecommendationStatus) =>
    void patch(
      { status: s },
      s === "approved"
        ? "Approved. Make the change on your site yourself; publishing is not connected."
        : s === "implemented"
          ? "Marked implemented. Outcomes appear only as measured post-change comparisons after a stated window."
          : s === "dismissed"
            ? "Dismissed. It will stay dismissed on reruns."
            : "Reopened.",
    );

  return (
    <div className="min-w-0 space-y-4">
      <Link to={backTo} className={buttonClass("ghost", "sm")}>
        ← All recommendations
      </Link>
      <PageHeader
        title={<span className="break-words">{rec.issue}</span>}
        description={rec.trigger}
        actions={
          <>
            {rec.isDemo && <Badge tone="demo">Demo data</Badge>}
            <Badge tone="info">{rec.agent.toUpperCase()}</Badge>
            <Badge>{STATUS_LABEL[rec.status]}</Badge>
          </>
        }
      />

      {message && <StateBanner state={message.ok ? "completed" : "failed"} title={message.ok ? "Saved" : "Could not save"} message={message.text} />}

      <div className="grid min-w-0 gap-4 lg:grid-cols-3">
        <div className="min-w-0 space-y-4 lg:col-span-2">
          <Card
            title="Proposal"
            actions={
              <>
                <ScopeBadge scope={rec.scope} />
                <VerifiedFlag verified={rec.verified} />
              </>
            }
          >
            <div className="space-y-4">
              <TargetInfo rec={rec} />
              <EditableDraft rec={rec} busy={busy} onSave={(body) => patch(body, "Edit saved and recorded in the history.")} />
              <div>
                <h3 className="text-xs font-medium text-zinc-600 dark:text-zinc-400">Rationale</h3>
                <PlainText text={rec.rationale} className="mt-1 text-zinc-800 dark:text-zinc-200" />
              </div>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <EffortUncertainty effort={rec.effort} uncertainty={rec.uncertainty} />
                <span className="text-xs text-zinc-600 dark:text-zinc-400" title="Heuristic ranking signal computed by code; not a predicted outcome.">
                  Heuristic priority {rec.priority} ({rec.priorityVersion})
                </span>
              </div>
              <StageTracker stage={rec.stage} status={rec.status} />
              <div className="flex flex-wrap items-center justify-between gap-2 border-t border-zinc-100 pt-3 dark:border-zinc-800">
                <PublishingFooter />
                <StatusActions status={rec.status} onStatus={onStatus} busy={busy} />
              </div>
            </div>
          </Card>

          <Card title="Evidence" description="Stored evidence this proposal was drafted from. Third-party text is quoted as evidence, never followed as instructions.">
            {rec.evidence.length === 0 ? (
              <p className="text-sm text-zinc-600 dark:text-zinc-400">No evidence items stored.</p>
            ) : (
              <ul className="space-y-3">
                {rec.evidence.map((ev) => (
                  <li key={ev.id} className="min-w-0 rounded-lg border border-zinc-200 p-3 dark:border-zinc-800">
                    <div className="flex flex-wrap items-center gap-2 text-xs text-zinc-600 dark:text-zinc-400">
                      <SourceChip source={ev.source} />
                      {ev.window && <span>Window: {ev.window}</span>}
                      {ev.refId && <span className="break-all font-mono">ref {ev.refId}</span>}
                      <span className="font-mono">id {ev.id}</span>
                    </div>
                    {ev.tainted && (
                      <StateBanner
                        className="mt-2"
                        state="partial"
                        title="Possible embedded instructions"
                        message="This text may contain instructions aimed at an AI system. It is shown as quoted evidence only and was excluded from the writer's context."
                      />
                    )}
                    <PlainText text={ev.text} className="mt-2 text-zinc-800 dark:text-zinc-200" />
                  </li>
                ))}
              </ul>
            )}
          </Card>

          <Card
            title="Decision log"
            description="Every narrow judgment recorded for this candidate, including rejected ones. Values use the provider's real field names."
          >
            <DecisionsTable decisions={rec.decisions} />
          </Card>
        </div>

        <div className="min-w-0 space-y-4">
          <Card title="Decision">
            <div className="space-y-2">
              <div className="flex flex-wrap items-center gap-2">
                <TierBadge tier={rec.decision.tier} />
              </div>
              {rec.decision.tier && rec.decision.tier !== "n/a" && <DecisionFields decision={rec.decision} />}
              <dl className="space-y-1">
                <Definition term="Writer">
                  {rec.writer.provider ? `${rec.writer.provider}${rec.writer.model ? ` · ${rec.writer.model}` : ""}` : "None recorded"}
                </Definition>
                <Definition term="Created">{formatDateTime(rec.createdAt)}</Definition>
                <Definition term="Updated">{formatDateTime(rec.updatedAt)}</Definition>
              </dl>
            </div>
          </Card>

          <Card title="Facts to confirm" description="Details the writer could not find in stored evidence. Fill these in yourself before publishing.">
            {rec.confirmPlaceholders.length === 0 ? (
              <p className="text-sm text-zinc-600 dark:text-zinc-400">None.</p>
            ) : (
              <ul className="list-inside list-disc space-y-1 text-sm text-zinc-800 dark:text-zinc-200">
                {rec.confirmPlaceholders.map((p, i) => (
                  <li key={`${i}-${p}`} className="break-words font-mono text-xs">
                    {p.startsWith("[confirm") ? p : `[confirm: ${p}]`}
                  </li>
                ))}
              </ul>
            )}
          </Card>

          <Card title="Limitations">
            <PlainText text={rec.limitations || "None stated."} className="text-zinc-700 dark:text-zinc-300" />
          </Card>

          <Card title="History">
            {rec.events.length === 0 ? (
              <p className="text-sm text-zinc-600 dark:text-zinc-400">No events yet.</p>
            ) : (
              <ol className="relative space-y-3 border-l border-zinc-200 pl-4 dark:border-zinc-800">
                {rec.events.map((ev, i) => (
                  <li key={`${ev.createdAt}-${i}`} className="text-sm">
                    <span className="absolute -left-1 mt-1.5 h-2 w-2 rounded-full bg-zinc-400 dark:bg-zinc-600" aria-hidden="true" />
                    <p className="font-medium text-zinc-900 dark:text-zinc-100">{humanize(ev.event)}</p>
                    <p className="text-xs text-zinc-600 dark:text-zinc-400">{formatDateTime(ev.createdAt)}</p>
                    {ev.note && <PlainText text={ev.note} className="mt-0.5 text-zinc-700 dark:text-zinc-300" />}
                  </li>
                ))}
              </ol>
            )}
          </Card>
        </div>
      </div>
    </div>
  );
}

function EditableDraft({
  rec,
  busy,
  onSave,
}: {
  rec: RecommendationDetail;
  busy: boolean;
  onSave: (body: { action?: string; suggestedSnippet?: string | null; note?: string }) => Promise<boolean>;
}) {
  const [editing, setEditing] = useState(false);
  const [action, setAction] = useState(rec.action);
  const [snippet, setSnippet] = useState(rec.suggestedSnippet ?? "");
  const [note, setNote] = useState("");

  useEffect(() => {
    if (!editing) {
      setAction(rec.action);
      setSnippet(rec.suggestedSnippet ?? "");
    }
  }, [rec.action, rec.suggestedSnippet, editing]);

  if (!editing) {
    return (
      <div className="space-y-3">
        <div className="rounded-lg bg-zinc-50 p-3 dark:bg-zinc-800/60">
          <div className="flex items-start justify-between gap-2">
            <h3 className="text-xs font-medium text-zinc-600 dark:text-zinc-400">Action</h3>
            <Button size="sm" variant="ghost" onClick={() => setEditing(true)}>
              Edit
            </Button>
          </div>
          <PlainText text={rec.action} className="mt-1 text-zinc-900 dark:text-zinc-100" />
        </div>
        {rec.suggestedSnippet && (
          <div>
            <h3 className="text-xs font-medium text-zinc-600 dark:text-zinc-400">Suggested snippet (draft)</h3>
            <pre className="mt-1 max-h-80 overflow-auto whitespace-pre-wrap break-words rounded-lg border border-zinc-200 bg-white p-3 font-mono text-xs text-zinc-800 dark:border-zinc-800 dark:bg-zinc-950 dark:text-zinc-200">
              {rec.suggestedSnippet}
            </pre>
          </div>
        )}
      </div>
    );
  }

  const dirty = action !== rec.action || snippet !== (rec.suggestedSnippet ?? "");
  return (
    <form
      className="space-y-3"
      onSubmit={(e) => {
        e.preventDefault();
        const body: { action?: string; suggestedSnippet?: string | null; note?: string } = {};
        if (action !== rec.action) body.action = action;
        if (snippet !== (rec.suggestedSnippet ?? "")) body.suggestedSnippet = snippet.trim() === "" ? null : snippet;
        if (note.trim()) body.note = note.trim();
        void onSave(body).then((ok) => {
          if (ok) {
            setEditing(false);
            setNote("");
          }
        });
      }}
    >
      <TextArea label="Action" value={action} onChange={(e) => setAction(e.target.value)} rows={4} required />
      <TextArea
        label="Suggested snippet"
        hint="Plain text. Keep [confirm: …] placeholders until you have verified the fact."
        value={snippet}
        onChange={(e) => setSnippet(e.target.value)}
        rows={8}
        className="font-mono text-xs"
      />
      <TextArea label="Edit note (optional)" value={note} onChange={(e) => setNote(e.target.value)} rows={2} />
      <div className="flex flex-wrap gap-2">
        <Button type="submit" variant="primary" loading={busy} disabled={!dirty || action.trim() === ""}>
          Save edit
        </Button>
        <Button
          onClick={() => {
            setEditing(false);
            setAction(rec.action);
            setSnippet(rec.suggestedSnippet ?? "");
            setNote("");
          }}
        >
          Cancel
        </Button>
      </div>
    </form>
  );
}

function DecisionsTable({ decisions }: { decisions: DecisionRecord[] }) {
  if (decisions.length === 0) {
    return <p className="text-sm text-zinc-600 dark:text-zinc-400">No semantic decisions recorded (deterministic signals only).</p>;
  }
  return (
    <Table caption="Decisions">
      <THead>
        <TR>
          <TH>Tier</TH>
          <TH>Question</TH>
          <TH>Provider / model</TH>
          <TH>Answer</TH>
          <TH>Outcome</TH>
          <TH>
            <span className="sr-only">Feedback</span>
          </TH>
        </TR>
      </THead>
      <TBody>
        {decisions.map((d) => {
          const runnerUp = d.tier === "flag" ? runnerUpFromAnswer(d.answer) : null;
          return (
            <TR key={d.id}>
              <TD className="whitespace-nowrap">
                <TierBadge tier={d.tier} />
              </TD>
              <TD className="min-w-40">
                <p className="break-words font-mono text-xs">{d.questionId ?? "—"}</p>
                <p className="text-xs text-zinc-500 dark:text-zinc-400">
                  v {d.questionVersion ?? "—"}
                  {d.policyVersion ? ` · ${d.policyVersion}` : ""}
                </p>
              </TD>
              <TD className="min-w-32 text-xs">
                <p>{d.provider ?? "—"}</p>
                <p className="break-all text-zinc-500 dark:text-zinc-400">{d.model ?? ""}</p>
              </TD>
              <TD className="min-w-44 text-xs">
                {showsJevValue(d) ? (
                  <>
                    <p className="break-words font-mono">{answerSummary(d.answer)}</p>
                    {d.tier === "flag" && (
                      <p className="mt-0.5 text-amber-800 dark:text-amber-300">
                        Check this yourself
                        {runnerUp ? ` · runner-up: ${runnerUp.label} (${runnerUp.probability.toFixed(2)})` : ""}
                      </p>
                    )}
                  </>
                ) : (
                  <p className="text-zinc-500 dark:text-zinc-400">Value withheld (below threshold); insufficient evidence</p>
                )}
              </TD>
              <TD className="whitespace-nowrap text-xs">
                <Badge tone={d.outcome === "selected" ? "success" : "neutral"}>{d.outcome === "selected" ? "Selected" : "Rejected"}</Badge>
                {d.reasonCode && <p className="mt-0.5 text-zinc-500 dark:text-zinc-400">{reasonLabel(d.reasonCode)}</p>}
              </TD>
              <TD>
                <DisagreeControl decision={d} />
              </TD>
            </TR>
          );
        })}
      </TBody>
    </Table>
  );
}
