/** [A18] "Disagree" control: posts a labelled human answer for the evaluation set. */
import { useId, useState } from "react";
import type { DecisionRecord } from "@shared/types";
import { api, errorMessage } from "@web/lib/api";
import { Button, SelectField, TextArea, TextField } from "@web/components/ui";

function answerOptions(answer: unknown): string[] {
  if (!answer || typeof answer !== "object") return [];
  const a = answer as Record<string, unknown>;
  if (a.type === "noul") return ["yes", "no"];
  if (a.probabilities && typeof a.probabilities === "object") return Object.keys(a.probabilities as Record<string, unknown>);
  return [];
}

export function DisagreeControl({ decision }: { decision: DecisionRecord }) {
  const [open, setOpen] = useState(false);
  const [humanAnswer, setHumanAnswer] = useState("");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const formId = useId();
  const options = answerOptions(decision.answer);

  if (done) return <p className="whitespace-nowrap text-xs text-emerald-700 dark:text-emerald-400">Feedback recorded</p>;

  if (!open) {
    return (
      <Button size="sm" variant="ghost" onClick={() => setOpen(true)} aria-expanded={false} aria-controls={formId}>
        Disagree
      </Button>
    );
  }

  return (
    <form
      id={formId}
      className="w-56 space-y-2"
      onSubmit={(e) => {
        e.preventDefault();
        if (!humanAnswer.trim()) return;
        setBusy(true);
        setError(null);
        api<unknown>(`/decisions/${encodeURIComponent(decision.id)}/feedback`, {
          method: "POST",
          body: { humanAnswer: humanAnswer.trim(), reason: reason.trim() || undefined },
        })
          .then(() => setDone(true))
          .catch((err: unknown) => setError(errorMessage(err)))
          .finally(() => setBusy(false));
      }}
    >
      {options.length > 0 ? (
        <SelectField label="Your answer" value={humanAnswer} onChange={(e) => setHumanAnswer(e.target.value)} required>
          <option value="">Choose…</option>
          {options.map((o) => (
            <option key={o} value={o}>
              {o}
            </option>
          ))}
        </SelectField>
      ) : (
        <TextField label="Your answer" value={humanAnswer} onChange={(e) => setHumanAnswer(e.target.value)} required />
      )}
      <TextArea label="Reason (optional)" value={reason} onChange={(e) => setReason(e.target.value)} rows={2} />
      {error && (
        <p role="alert" className="text-xs text-red-700 dark:text-red-400">
          {error}
        </p>
      )}
      <div className="flex gap-2">
        <Button size="sm" type="submit" variant="primary" loading={busy} disabled={!humanAnswer.trim()}>
          Submit
        </Button>
        <Button size="sm" onClick={() => setOpen(false)}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
