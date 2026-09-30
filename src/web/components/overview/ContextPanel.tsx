/**
 * [A12] region 2: project summary, versioned context documents (unconfirmed-fact counts), competitors.
 * Inline edit saves a NEW version (PUT /projects/:pid/context/:kind). OWNED BY: web-shell.
 */
import { useId, useState } from "react";
import { Link } from "react-router";
import type { ContextDocument, ContextFact, ContextKind, Project } from "@shared/types";
import { api } from "@web/lib/api";
import { useApi, useMutation } from "@web/lib/hooks";
import { formatDateTime } from "@web/lib/format";
import { projectPath } from "@web/lib/project-context";
import { Badge, Button, ErrorState, LoadingState, TextArea, TextField, cx } from "../ui";

export const CONTEXT_KINDS: Array<{ kind: ContextKind; label: string }> = [
  { kind: "product", label: "Product information" },
  { kind: "positioning", label: "Positioning / ICP" },
  { kind: "competitors", label: "Competitors" },
  { kind: "voice", label: "Voice" },
  { kind: "pillars", label: "Content pillars" },
];

type EditableFact = Omit<ContextFact, "id"> & { id?: string };

export function ContextPanel({ project }: { project: Project }) {
  const docs = useApi<ContextDocument[]>(`/projects/${encodeURIComponent(project.id)}/context`);
  const [editing, setEditing] = useState<ContextKind | null>(null);

  return (
    <section aria-labelledby="context-heading" className="min-w-0 rounded-xl border border-zinc-200 bg-white shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
      <h2 id="context-heading" className="border-b border-zinc-100 px-4 py-3 text-sm font-semibold dark:border-zinc-800">
        Context
      </h2>
      <div className="space-y-4 p-4">
        <div className="text-sm">
          <p className="font-medium">{project.brandName}</p>
          <p className="text-xs text-zinc-600 dark:text-zinc-400">
            {project.siteType} · {project.locale} / {project.language}
            {project.brandAliases.length > 0 && ` · aliases: ${project.brandAliases.join(", ")}`}
          </p>
          {project.productDescription && <p className="mt-1 line-clamp-3 break-words text-zinc-700 dark:text-zinc-300">{project.productDescription}</p>}
        </div>

        <div>
          <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">Documents</h3>
          {docs.loading && !docs.data ? (
            <LoadingState label="Loading context…" className="py-2" />
          ) : docs.error ? (
            <ErrorState error={docs.error} onRetry={docs.reload} />
          ) : (
            <ul className="space-y-2">
              {CONTEXT_KINDS.map(({ kind, label }) => {
                const doc = docs.data?.find((d) => d.kind === kind) ?? null;
                return (
                  <li key={kind} className="rounded-lg border border-zinc-200 p-2.5 dark:border-zinc-800">
                    <div className="flex flex-wrap items-start justify-between gap-2">
                      <div className="min-w-0">
                        <p className="text-sm font-medium">{label}</p>
                        {doc ? (
                          <p className="text-xs text-zinc-600 dark:text-zinc-400">
                            v{doc.version} · saved {formatDateTime(doc.createdAt)} ·{" "}
                            {doc.usedByRecommendationCount > 0 ? (
                              <Link to={projectPath(project.id, "recommendations")}>
                                cited by {doc.usedByRecommendationCount} recommendation{doc.usedByRecommendationCount === 1 ? "" : "s"}
                              </Link>
                            ) : (
                              "not cited yet"
                            )}
                          </p>
                        ) : (
                          <p className="text-xs text-zinc-600 dark:text-zinc-400">Not written yet</p>
                        )}
                      </div>
                      <div className="flex items-center gap-1.5">
                        {doc && doc.unconfirmedCount > 0 && <Badge tone="warning">{doc.unconfirmedCount} unconfirmed</Badge>}
                        {doc && doc.unconfirmedCount === 0 && doc.facts.length > 0 && <Badge tone="success">All confirmed</Badge>}
                        <Button size="sm" variant="ghost" aria-expanded={editing === kind} onClick={() => setEditing(editing === kind ? null : kind)}>
                          {editing === kind ? "Close" : doc ? "Edit" : "Add"}
                        </Button>
                      </div>
                    </div>
                    {editing === kind && (
                      <ContextEditor
                        projectId={project.id}
                        kind={kind}
                        doc={doc}
                        onSaved={() => {
                          setEditing(null);
                          docs.reload();
                        }}
                      />
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        <div>
          <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
            Competitors ({project.competitors.length})
          </h3>
          {project.competitors.length === 0 ? (
            <p className="text-sm text-zinc-600 dark:text-zinc-400">
              None configured. <Link to={projectPath(project.id, "settings")}>Add competitors</Link>
            </p>
          ) : (
            <ul className="space-y-1 text-sm">
              {project.competitors.map((c) => (
                <li key={c.name} className="min-w-0 break-words">
                  <span className="font-medium">{c.name}</span>
                  {c.domains.length > 0 && <span className="text-zinc-600 dark:text-zinc-400"> · {c.domains.join(", ")}</span>}
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </section>
  );
}

function ContextEditor({ projectId, kind, doc, onSaved }: { projectId: string; kind: ContextKind; doc: ContextDocument | null; onSaved: () => void }) {
  const id = useId();
  const [content, setContent] = useState(doc?.content ?? "");
  const [facts, setFacts] = useState<EditableFact[]>(doc?.facts ?? []);
  const [newFact, setNewFact] = useState("");
  const save = useMutation(() =>
    api<ContextDocument>(`/projects/${encodeURIComponent(projectId)}/context/${kind}`, { method: "PUT", body: { content, facts } }),
  );

  return (
    <form
      className="mt-3 space-y-3 border-t border-zinc-100 pt-3 dark:border-zinc-800"
      onSubmit={async (e) => {
        e.preventDefault();
        if (await save.run()) onSaved();
      }}
    >
      <TextArea id={`${id}-content`} label="Content" rows={5} maxLength={8000} value={content} onChange={(e) => setContent(e.target.value)} />
      <fieldset>
        <legend className="mb-1 text-sm font-medium">Facts ({facts.filter((f) => !f.confirmed).length} unconfirmed)</legend>
        {facts.length === 0 ? (
          <p className="text-xs text-zinc-600 dark:text-zinc-400">No facts.</p>
        ) : (
          <ul className="space-y-1.5">
            {facts.map((f, i) => (
              <li key={f.id ?? `new-${i}`} className="flex items-start gap-2 text-sm">
                <input
                  id={`${id}-f${i}`}
                  type="checkbox"
                  className="mt-1 h-4 w-4 shrink-0 accent-zinc-900 dark:accent-zinc-100"
                  checked={f.confirmed}
                  onChange={(e) => setFacts((fs) => fs.map((x, j) => (j === i ? { ...x, confirmed: e.target.checked } : x)))}
                />
                <label htmlFor={`${id}-f${i}`} className={cx("min-w-0 flex-1 break-words", !f.confirmed && "text-amber-900 dark:text-amber-200")}>
                  {f.text}
                  <span className="ml-1 text-xs text-zinc-500 dark:text-zinc-400">({f.confirmed ? "confirmed" : "unconfirmed"} · {f.source})</span>
                </label>
                <Button size="sm" variant="ghost" aria-label={`Remove fact: ${f.text}`} onClick={() => setFacts((fs) => fs.filter((_, j) => j !== i))}>
                  ✕
                </Button>
              </li>
            ))}
          </ul>
        )}
        <div className="mt-2 flex items-end gap-2">
          <div className="min-w-0 flex-1">
            <TextField id={`${id}-new`} label="Add a confirmed fact" value={newFact} maxLength={500} onChange={(e) => setNewFact(e.target.value)} />
          </div>
          <Button
            size="md"
            disabled={!newFact.trim()}
            onClick={() => {
              setFacts((fs) => [...fs, { text: newFact.trim(), confirmed: true, source: "user" }]);
              setNewFact("");
            }}
          >
            Add
          </Button>
        </div>
      </fieldset>
      {save.error !== null && <ErrorState error={save.error} />}
      <div className="flex flex-wrap items-center justify-end gap-2">
        <span className="text-xs text-zinc-600 dark:text-zinc-400">Saving creates version {doc ? doc.version + 1 : 1}; earlier versions stay attached to past decisions.</span>
        <Button type="submit" variant="primary" size="sm" loading={save.loading}>
          Save new version
        </Button>
      </div>
    </form>
  );
}
