/** Manual raw-answer import: a separate measurement type that never masquerades as an API measurement. */
import { useState } from "react";
import { api, errorMessage } from "@web/lib/api";
import { Badge, Button, Card, StateBanner, TextArea, TextField } from "@web/components/ui";

export function ManualImportForm({ projectId, onImported }: { projectId: string; onImported: () => void }) {
  const [promptText, setPromptText] = useState("");
  const [surface, setSurface] = useState("");
  const [answer, setAnswer] = useState("");
  const [citations, setCitations] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);

  const citationList = citations
    .split(/\s*\n\s*/)
    .map((c) => c.trim())
    .filter(Boolean);
  const badUrl = citationList.find((c) => {
    try {
      const u = new URL(c);
      return u.protocol !== "https:" && u.protocol !== "http:";
    } catch {
      return true;
    }
  });

  return (
    <Card
      title={
        <span className="inline-flex flex-wrap items-center gap-2">
          Manual answer import <Badge tone="warning">Separate measurement type</Badge>
        </span>
      }
      description="Paste an answer you saw in a consumer app (for example the ChatGPT app). It is stored with its surface as provenance, labelled as a manual import everywhere, and never mixed into API-sampled rates."
    >
      <form
        className="grid gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          if (badUrl) return;
          setBusy(true);
          setResult(null);
          api<unknown>(`/projects/${encodeURIComponent(projectId)}/geo/import`, {
            method: "POST",
            body: { promptText: promptText.trim(), surface: surface.trim(), answer, citations: citationList },
          })
            .then(() => {
              setResult({ ok: true, text: `Imported as a manual observation from “${surface.trim()}”.` });
              setPromptText("");
              setAnswer("");
              setCitations("");
              onImported();
            })
            .catch((err: unknown) => setResult({ ok: false, text: errorMessage(err) }))
            .finally(() => setBusy(false));
        }}
      >
        <div className="grid gap-3 sm:grid-cols-2">
          <TextField label="Prompt text" required value={promptText} onChange={(e) => setPromptText(e.target.value)} maxLength={500} />
          <TextField
            label="Surface"
            required
            value={surface}
            onChange={(e) => setSurface(e.target.value)}
            placeholder="ChatGPT app (manual)"
            hint="Where you saw the answer, e.g. “ChatGPT app (manual)”."
            maxLength={100}
          />
        </div>
        <TextArea label="Answer text" required value={answer} onChange={(e) => setAnswer(e.target.value)} rows={6} hint="Pasted as plain text; any markup is kept as literal text." />
        <TextArea
          label="Citation URLs (one per line)"
          value={citations}
          onChange={(e) => setCitations(e.target.value)}
          rows={3}
          error={badUrl ? `Not a valid http(s) URL: ${badUrl}` : null}
        />
        <div>
          <Button type="submit" variant="primary" loading={busy} disabled={!promptText.trim() || !surface.trim() || !answer.trim() || !!badUrl}>
            Import answer
          </Button>
        </div>
      </form>
      {result && <StateBanner className="mt-3" state={result.ok ? "completed" : "failed"} title={result.ok ? "Imported" : "Import failed"} message={result.text} />}
    </Card>
  );
}
