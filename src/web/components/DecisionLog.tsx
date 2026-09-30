/**
 * [A3] Decision log: every candidate considered per run, including rejected ones with reason codes.
 * [A13] Tier "drop" withholds the Jev value. [A18] "Disagree" posts to /decisions/:id/feedback.
 * OWNED BY: web-shell.
 */
import { useId, useState } from "react";
import type { DecisionRecord } from "@shared/types";
import { api, errorMessage } from "@web/lib/api";
import { useMutation } from "@web/lib/hooks";
import { formatDateTime, humanize } from "@web/lib/format";
import { Badge, Button, EmptyState, TBody, TD, TH, THead, TR, Table, TextArea, TextField, TierBadge } from "./ui";

const REASON_TEXT: Record<string, string> = {
  low_fit: "Low fit",
  duplicate: "Duplicate of an existing recommendation",
  insufficient_evidence: "Insufficient evidence",
  budget: "Budget limit reached",
  dismissed_recently: "Dismissed recently",
  out_of_scope: "Out of scope",
};

export function reasonLabel(code: string | null): string {
  if (!code) return "—";
  return REASON_TEXT[code] ?? humanize(code);
}

function answerText(d: DecisionRecord): string {
  if (d.tier === "drop") return "Withheld (below Drop threshold)";
  if (d.answer === null || d.answer === undefined) return "—";
  if (typeof d.answer === "string" || typeof d.answer === "number" || typeof d.answer === "boolean") return String(d.answer);
  try {
    const s = JSON.stringify(d.answer);
    return s.length > 240 ? `${s.slice(0, 240)}…` : s;
  } catch {
    return "—";
  }
}

export function DecisionLog({ decisions, emptyMessage }: { decisions: DecisionRecord[]; emptyMessage?: string }) {
  const [filter, setFilter] = useState<"all" | "selected" | "rejected">("all");
  if (decisions.length === 0) {
    return <EmptyState title={emptyMessage ?? "No candidate decisions recorded for this run."} />;
  }
  const shown = decisions.filter((d) => filter === "all" || d.outcome === filter);
  const rejected = decisions.filter((d) => d.outcome === "rejected").length;
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2 text-sm" role="group" aria-label="Filter decisions">
        {(["all", "selected", "rejected"] as const).map((f) => (
          <Button key={f} size="sm" variant={filter === f ? "primary" : "secondary"} aria-pressed={filter === f} onClick={() => setFilter(f)}>
            {f === "all" ? `All (${decisions.length})` : f === "selected" ? `Selected (${decisions.length - rejected})` : `Rejected (${rejected})`}
          </Button>
        ))}
      </div>
      <Table caption="Decision log">
        <THead>
          <TR>
            <TH>Candidate</TH>
            <TH>Question</TH>
            <TH>Answer</TH>
            <TH>Tier</TH>
            <TH>Outcome</TH>
            <TH>Provider</TH>
            <TH>
              <span className="sr-only">Feedback</span>
            </TH>
          </TR>
        </THead>
        <TBody>
          {shown.map((d) => (
            <DecisionRow key={d.id} d={d} />
          ))}
        </TBody>
      </Table>
      <p className="text-xs text-zinc-600 dark:text-zinc-400">
        Results of a change are only shown after they are measured from a real source over a stated window; none are shown here.
      </p>
    </div>
  );
}

function DecisionRow({ d }: { d: DecisionRecord }) {
  const [open, setOpen] = useState(false);
  const isJev = d.questionId !== null;
  return (
    <>
      <TR>
        <TD className="max-w-56 break-words font-mono text-xs">
          <Badge tone="neutral" className="mr-1">{d.agent.toUpperCase()}</Badge>
          {d.candidateKey}
        </TD>
        <TD className="text-xs">
          {d.questionId ?? "Deterministic"}
          {d.questionVersion && <div className="text-zinc-500 dark:text-zinc-400">v {d.questionVersion.slice(0, 10)}</div>}
          {d.policyVersion && <div className="text-zinc-500 dark:text-zinc-400">policy {d.policyVersion}</div>}
        </TD>
        <TD className="max-w-64 break-words font-mono text-xs">{answerText(d)}</TD>
        <TD>{isJev ? <TierBadge tier={d.tier} /> : <span className="text-xs text-zinc-500">—</span>}</TD>
        <TD className="text-xs">
          {d.outcome === "selected" ? <Badge tone="success">Selected</Badge> : <Badge tone="neutral">Rejected</Badge>}
          {d.outcome === "rejected" && (
            <div className="mt-1 text-zinc-700 dark:text-zinc-300">
              {reasonLabel(d.reasonCode)}
              {d.reasonCode && <span className="ml-1 font-mono text-zinc-500">({d.reasonCode})</span>}
            </div>
          )}
        </TD>
        <TD className="text-xs">
          {d.provider ?? "—"}
          {d.model && <div className="font-mono text-zinc-500 dark:text-zinc-400">{d.model}</div>}
          <div className="text-zinc-500 dark:text-zinc-400">{formatDateTime(d.createdAt)}</div>
        </TD>
        <TD>
          {isJev && (
            <Button size="sm" variant="ghost" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
              Disagree
            </Button>
          )}
        </TD>
      </TR>
      {open && (
        <TR>
          <TD colSpan={7} className="bg-zinc-50 dark:bg-zinc-950">
            <DisagreeForm decisionId={d.id} onDone={() => setOpen(false)} />
          </TD>
        </TR>
      )}
    </>
  );
}

/** [A18] Feedback form. Creates a labelled row for the evaluation set. */
export function DisagreeForm({ decisionId, onDone }: { decisionId: string; onDone?: () => void }) {
  const id = useId();
  const [humanAnswer, setHumanAnswer] = useState("");
  const [reason, setReason] = useState("");
  const submit = useMutation((body: { humanAnswer: string; reason?: string }) =>
    api<unknown>(`/decisions/${encodeURIComponent(decisionId)}/feedback`, { method: "POST", body }),
  );
  if (submit.data !== null) {
    return (
      <p role="status" className="text-sm text-emerald-800 dark:text-emerald-300">
        Feedback recorded as a labelled example. It does not change this run's outcome.
      </p>
    );
  }
  return (
    <form
      className="grid gap-3 sm:grid-cols-2"
      onSubmit={(e) => {
        e.preventDefault();
        if (!humanAnswer.trim()) return;
        void submit.run({ humanAnswer: humanAnswer.trim(), reason: reason.trim() || undefined });
      }}
    >
      <TextField
        id={`${id}-answer`}
        label="Your answer"
        hint="What the correct judgment would have been (e.g. an option id or level)."
        value={humanAnswer}
        onChange={(e) => setHumanAnswer(e.target.value)}
        required
        maxLength={200}
      />
      <TextArea id={`${id}-reason`} label="Reason (optional)" value={reason} onChange={(e) => setReason(e.target.value)} maxLength={1000} rows={2} />
      <div className="flex flex-wrap items-center gap-2 sm:col-span-2">
        <Button type="submit" variant="primary" size="sm" loading={submit.loading} disabled={!humanAnswer.trim()}>
          Submit disagreement
        </Button>
        {onDone && (
          <Button size="sm" variant="ghost" onClick={onDone}>
            Cancel
          </Button>
        )}
        {submit.error !== null && (
          <span role="alert" className="text-xs text-red-700 dark:text-red-400">
            {errorMessage(submit.error)}
          </span>
        )}
      </div>
    </form>
  );
}
