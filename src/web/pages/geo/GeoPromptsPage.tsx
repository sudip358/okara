/**
 * GEO prompt management. Route: /projects/:projectId/geo/prompts
 * Saving creates a new prompt-set version (a new cohort: trends restart for the changed set).
 */
import { useEffect, useMemo, useState } from "react";
import { useParams } from "react-router";
import type { GeoPromptSet, Project } from "@shared/types";
import { ApiError, api, errorMessage, isSetupRequired } from "@web/lib/api";
import { formatDateTime } from "@web/lib/format";
import { useApi } from "@web/lib/hooks";
import { useProject } from "@web/lib/project-context";
import {
  Badge,
  Button,
  Card,
  EmptyState,
  ErrorState,
  LoadingState,
  PageHeader,
  StateBanner,
  inputClass,
} from "@web/components/ui";
import { MAX_PROMPTS, detailMessages, newDraftKey, normalizeSuggestions, toDraft, type DraftPrompt, type Suggestion } from "./lib";

/** Client-side hint only; the server enforces the brand-blind rule. */
function brandTerms(project: Project): string[] {
  const terms = [project.brandName, ...project.brandAliases];
  for (const c of project.competitors) terms.push(c.name, ...c.aliases, ...c.domains);
  return Array.from(new Set(terms.map((t) => t.trim()).filter((t) => t.length >= 2)));
}

function namedTerms(text: string, terms: string[]): string[] {
  const lower = text.toLowerCase();
  return terms.filter((t) => {
    const esc = t.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`(^|[^\\p{L}\\p{N}])${esc}($|[^\\p{L}\\p{N}])`, "u").test(lower);
  });
}

function sameSet(a: DraftPrompt[], b: DraftPrompt[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((p, i) => {
    const q = b[i];
    return !!q && p.text === q.text && p.promptType === q.promptType && p.stage === q.stage && p.approved === q.approved;
  });
}

export function GeoPromptsPage() {
  const { projectId = "" } = useParams();
  const { project } = useProject();
  const base = `/projects/${encodeURIComponent(projectId)}`;
  const { data, error, loading, reload, setData } = useApi<GeoPromptSet | null>(projectId ? `${base}/geo/prompts` : null);

  const original = useMemo(() => (data?.prompts ?? []).slice().sort((a, b) => a.position - b.position).map(toDraft), [data]);
  const [drafts, setDrafts] = useState<DraftPrompt[]>([]);
  useEffect(() => setDrafts(original), [original]);

  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<{ message: string; details: string[] } | null>(null);
  const [saved, setSaved] = useState<string | null>(null);

  const [suggesting, setSuggesting] = useState(false);
  const [suggestError, setSuggestError] = useState<{ setup: boolean; message: string } | null>(null);
  const [suggestions, setSuggestions] = useState<Suggestion[] | null>(null);

  const terms = useMemo(() => brandTerms(project), [project]);
  const dirty = !sameSet(drafts, original);
  const atMax = drafts.length >= MAX_PROMPTS;

  const updateDraft = (key: string, patch: Partial<DraftPrompt>) => setDrafts((ds) => ds.map((d) => (d.key === key ? { ...d, ...patch } : d)));
  const remove = (key: string) => setDrafts((ds) => ds.filter((d) => d.key !== key));
  const move = (index: number, dir: -1 | 1) =>
    setDrafts((ds) => {
      const j = index + dir;
      if (j < 0 || j >= ds.length) return ds;
      const next = ds.slice();
      const a = next[index]!;
      next[index] = next[j]!;
      next[j] = a;
      return next;
    });
  const add = (init?: Partial<DraftPrompt>) =>
    setDrafts((ds) =>
      ds.length >= MAX_PROMPTS
        ? ds
        : [...ds, { key: newDraftKey(), id: null, text: "", promptType: "discovery", stage: "", approved: false, ...init }],
    );

  const save = async () => {
    setSaving(true);
    setSaveError(null);
    setSaved(null);
    try {
      const body = {
        prompts: drafts
          .filter((d) => d.text.trim() !== "")
          .map((d) => ({ text: d.text.trim(), promptType: d.promptType, stage: d.stage.trim() || null, approved: d.approved })),
      };
      const res = await api<GeoPromptSet>(`${base}/geo/prompts`, { method: "PUT", body });
      if (res && typeof res === "object" && Array.isArray(res.prompts)) {
        setData(res);
        setSaved(`Saved as version ${res.version}. Trends for this set start a new cohort.`);
      } else {
        reload();
        setSaved("Saved as a new version. Trends for this set start a new cohort.");
      }
    } catch (e) {
      const details = e instanceof ApiError ? detailMessages(e.body.details) : [];
      setSaveError({ message: errorMessage(e), details });
    } finally {
      setSaving(false);
    }
  };

  const suggest = async () => {
    setSuggesting(true);
    setSuggestError(null);
    try {
      const res = await api<unknown>(`${base}/geo/prompts/generate`, { method: "POST", body: {} });
      setSuggestions(normalizeSuggestions(res));
    } catch (e) {
      setSuggestError({
        setup: isSetupRequired(e),
        message: isSetupRequired(e)
          ? "Prompt suggestions need a writing provider. Add a writer API key on the integrations page; you can still write prompts yourself."
          : errorMessage(e),
      });
    } finally {
      setSuggesting(false);
    }
  };

  if (loading && !data) return <LoadingState label="Loading prompts…" />;
  if (error && !(error instanceof ApiError && error.status === 404)) return <ErrorState error={error} onRetry={reload} />;

  const discoveryCount = drafts.filter((d) => d.promptType === "discovery").length;
  const approvedCount = drafts.filter((d) => d.approved && d.text.trim()).length;

  return (
    <div className="min-w-0 space-y-4">
      <PageHeader
        title="GEO prompts"
        description="Buyer questions sent to each enabled AI API once per scheduled batch. Only approved prompts run."
        actions={
          <>
            {data ? <Badge tone="info">Version {data.version}</Badge> : <Badge>No saved version</Badge>}
            {data && <span className="text-xs text-zinc-600 dark:text-zinc-400">Saved {formatDateTime(data.createdAt)}</span>}
          </>
        }
      />

      <Card title="How prompts are measured">
        <ul className="list-inside list-disc space-y-1 text-sm text-zinc-700 dark:text-zinc-300">
          <li>
            <strong className="font-medium">Discovery prompts must be brand-blind:</strong> they must not name your brand, its aliases, or your competitors.
            The server rejects violations. Example: “What tools help a small ecommerce team find internal-link opportunities?”
          </li>
          <li>
            <strong className="font-medium">Reputation prompts</strong> may name your brand. They are labelled separately and never mixed into the visibility
            metric.
          </li>
          <li>Up to {MAX_PROMPTS} prompts. Saving creates a new version; trends are only compared within the same prompt set, so a changed set starts a new cohort.</li>
        </ul>
      </Card>

      <Card
        title={`Prompts (${drafts.length} of ${MAX_PROMPTS})`}
        description={`${discoveryCount} discovery · ${drafts.length - discoveryCount} reputation · ${approvedCount} approved`}
        actions={
          <>
            <Button size="sm" onClick={() => void suggest()} loading={suggesting}>
              Suggest prompts
            </Button>
            <Button size="sm" onClick={() => add()} disabled={atMax}>
              Add prompt
            </Button>
          </>
        }
      >
        {suggestError && (
          <StateBanner className="mb-3" state={suggestError.setup ? "setup_required" : "failed"} message={suggestError.message} />
        )}
        {suggestions && (
          <SuggestionList
            suggestions={suggestions}
            existing={drafts.map((d) => d.text.trim().toLowerCase())}
            atMax={atMax}
            onAdd={(s) => add({ text: s.text, stage: s.stage ?? "", promptType: s.promptType, approved: false })}
            onClose={() => setSuggestions(null)}
          />
        )}

        {drafts.length === 0 ? (
          <EmptyState title="No prompts yet." action={<Button onClick={() => add()}>Add your first prompt</Button>}>
            Start with about five discovery questions a real buyer might ask an AI assistant.
          </EmptyState>
        ) : (
          <ol className="space-y-3">
            {drafts.map((d, i) => {
              const named = d.promptType === "discovery" ? namedTerms(d.text, terms) : [];
              return (
                <li key={d.key} className="min-w-0 rounded-lg border border-zinc-200 p-3 dark:border-zinc-800">
                  <div className="flex flex-wrap items-start gap-3">
                    <span className="mt-2 w-6 shrink-0 text-right text-xs font-medium tabular-nums text-zinc-500 dark:text-zinc-400">{i + 1}.</span>
                    <div className="min-w-0 flex-1 space-y-2">
                      <label className="sr-only" htmlFor={`p-text-${d.key}`}>
                        Prompt {i + 1} text
                      </label>
                      <textarea
                        id={`p-text-${d.key}`}
                        value={d.text}
                        rows={2}
                        maxLength={500}
                        onChange={(e) => updateDraft(d.key, { text: e.target.value })}
                        className={`${inputClass} min-h-14`}
                        aria-invalid={named.length > 0 ? true : undefined}
                        aria-describedby={named.length > 0 ? `p-warn-${d.key}` : undefined}
                        placeholder="e.g. Which lighting stores offer solid brass fixtures with UL listing?"
                      />
                      {named.length > 0 && (
                        <p id={`p-warn-${d.key}`} className="text-xs text-amber-800 dark:text-amber-300">
                          This discovery prompt appears to name {named.join(", ")}. Make it brand-blind or change the type to reputation.
                        </p>
                      )}
                      <div className="flex flex-wrap items-end gap-3">
                        <div>
                          <label className="mb-1 block text-xs font-medium text-zinc-700 dark:text-zinc-300" htmlFor={`p-type-${d.key}`}>
                            Type
                          </label>
                          <select
                            id={`p-type-${d.key}`}
                            value={d.promptType}
                            onChange={(e) => updateDraft(d.key, { promptType: e.target.value as DraftPrompt["promptType"] })}
                            className={`${inputClass} py-1 text-xs`}
                          >
                            <option value="discovery">Discovery (brand-blind)</option>
                            <option value="reputation">Reputation (names brand)</option>
                          </select>
                        </div>
                        <div className="min-w-40 flex-1">
                          <label className="mb-1 block text-xs font-medium text-zinc-700 dark:text-zinc-300" htmlFor={`p-stage-${d.key}`}>
                            Stage
                          </label>
                          <input
                            id={`p-stage-${d.key}`}
                            value={d.stage}
                            maxLength={60}
                            onChange={(e) => updateDraft(d.key, { stage: e.target.value })}
                            className={`${inputClass} py-1 text-xs`}
                            placeholder="e.g. solution comparison"
                          />
                        </div>
                        <label className="flex items-center gap-2 pb-1 text-sm text-zinc-800 dark:text-zinc-200">
                          <input
                            type="checkbox"
                            checked={d.approved}
                            onChange={(e) => updateDraft(d.key, { approved: e.target.checked })}
                            className="h-4 w-4 rounded border-zinc-300 accent-zinc-900 focus-visible:outline-2 focus-visible:outline-sky-600 dark:accent-zinc-100"
                          />
                          Approved to run
                        </label>
                      </div>
                    </div>
                    <div className="flex shrink-0 gap-1">
                      <Button size="sm" variant="ghost" onClick={() => move(i, -1)} disabled={i === 0} aria-label={`Move prompt ${i + 1} up`}>
                        ↑
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => move(i, 1)}
                        disabled={i === drafts.length - 1}
                        aria-label={`Move prompt ${i + 1} down`}
                      >
                        ↓
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => remove(d.key)} aria-label={`Remove prompt ${i + 1}`}>
                        Remove
                      </Button>
                    </div>
                  </div>
                </li>
              );
            })}
          </ol>
        )}

        {saveError && (
          <div role="alert" className="mt-4 rounded-lg border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-900 dark:border-red-800 dark:bg-red-950 dark:text-red-200">
            <p className="font-semibold">Not saved: {saveError.message}</p>
            {saveError.details.length > 0 && (
              <ul className="mt-1 list-inside list-disc space-y-0.5 text-xs">
                {saveError.details.map((m, i) => (
                  <li key={i} className="break-words">
                    {m}
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
        {saved && <StateBanner className="mt-4" state="completed" title="Saved" message={saved} />}

        <div className="mt-4 flex flex-wrap items-center justify-between gap-3 border-t border-zinc-100 pt-3 dark:border-zinc-800">
          <p className="text-xs text-zinc-600 dark:text-zinc-400" aria-live="polite">
            {dirty
              ? `Unsaved changes. Saving creates version ${(data?.version ?? 0) + 1}; trends restart for the changed prompt set (cohort change).`
              : "No unsaved changes."}
          </p>
          <div className="flex gap-2">
            <Button onClick={() => setDrafts(original)} disabled={!dirty || saving}>
              Discard changes
            </Button>
            <Button variant="primary" onClick={() => void save()} loading={saving} disabled={!dirty}>
              Save new version
            </Button>
          </div>
        </div>
      </Card>
    </div>
  );
}

function SuggestionList({
  suggestions,
  existing,
  atMax,
  onAdd,
  onClose,
}: {
  suggestions: Suggestion[];
  existing: string[];
  atMax: boolean;
  onAdd: (s: Suggestion) => void;
  onClose: () => void;
}) {
  return (
    <div className="mb-4 rounded-lg border border-sky-200 bg-sky-50/60 p-3 dark:border-sky-900 dark:bg-sky-950/40">
      <div className="mb-2 flex flex-wrap items-start justify-between gap-2">
        <div>
          <h3 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">Suggested prompts (unapproved)</h3>
          <p className="text-xs text-zinc-600 dark:text-zinc-400">Drafted by the writing provider. Review each one; added prompts stay unapproved until you tick “Approved to run”.</p>
        </div>
        <Button size="sm" variant="ghost" onClick={onClose}>
          Close
        </Button>
      </div>
      {suggestions.length === 0 ? (
        <p className="text-sm text-zinc-600 dark:text-zinc-400">No suggestions returned.</p>
      ) : (
        <ul className="space-y-2">
          {suggestions.map((s, i) => {
            const added = existing.includes(s.text.trim().toLowerCase());
            return (
              <li key={`${i}-${s.text}`} className="flex min-w-0 flex-wrap items-start justify-between gap-2 rounded-md bg-white p-2 dark:bg-zinc-900">
                <div className="min-w-0 flex-1">
                  <p className="break-words text-sm text-zinc-900 dark:text-zinc-100">{s.text}</p>
                  <p className="text-xs text-zinc-600 dark:text-zinc-400">
                    {s.promptType === "discovery" ? "Discovery" : "Reputation"}
                    {s.stage ? ` · ${s.stage}` : ""}
                    {s.rationale ? ` · ${s.rationale}` : ""}
                  </p>
                </div>
                <Button size="sm" onClick={() => onAdd(s)} disabled={added || atMax}>
                  {added ? "Added" : "Add"}
                </Button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
