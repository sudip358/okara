/**
 * [A23] Draft / page quality check. Route: /projects/:projectId/draft-check
 * The user names a target query and either pastes a draft or picks a crawled page; the server returns a
 * verdict (pass / needs review / fail), flagged excerpts (rule or Jev), and the on-page checklist evaluated
 * against the draft (25 checks; "What the check covers" lists which are measured and which are Jev yes/no
 * judgments). A quality gate before human review: not an AI detector and not a ranking prediction.
 * All server text (excerpts, labels, checklist text, URLs) renders as plain text.
 */
import { useEffect, useId, useMemo, useRef, useState, type FormEvent, type RefObject } from "react";
import { Link } from "react-router";
import type { DraftCheckRequest, DraftCheckResult, PageRow } from "@shared/types";
import { ApiError, api, errorMessage, isRateLimited, isSetupRequired } from "@web/lib/api";
import { useApi } from "@web/lib/hooks";
import { formatDateTime, formatNumber } from "@web/lib/format";
import { projectPath, useProject } from "@web/lib/project-context";
import { Badge, Button, Card, ErrorState, LoadingState, PageHeader, SelectField, StateBadge, StateBanner, TextArea, TextField, buttonClass, cx, inputClass } from "@web/components/ui";
import { ChecklistView, Disclaimer } from "@web/pages/checklists/components/ChecklistView";
import {
  DRAFT_CHECKS,
  DRAFT_CHECKS_SUMMARY,
  DRAFT_PAGE_TYPES,
  MAX_FACT_KEY_CHARS,
  MAX_FACT_VALUE_CHARS,
  MAX_PRODUCT_FACTS,
  pageTypeLabel,
  EMPTY_FORM,
  FLAG_METHOD_HINT,
  FLAG_METHOD_LABEL,
  GATE_LABEL,
  MAX_DRAFT_CHARS,
  MAX_META_CHARS,
  MAX_QUERY_CHARS,
  MAX_TITLE_CHARS,
  VERDICT_META,
  buildDraftCheckRequest,
  extraLabels,
  firstInvalidField,
  groupFlags,
  noulText,
  pageOptionLabel,
  parseValidationDetails,
  readOnlyChecklist,
  sortPages,
  verdictText,
  type DraftField,
  type DraftForm,
  type DraftMode,
  type FactRow,
  type FormErrors,
} from "./lib";

interface Checked {
  result: DraftCheckResult;
  request: DraftCheckRequest;
  page: PageRow | null;
}

const noop = () => {};
const noPutPath = () => "";

export function DraftCheckPage() {
  const { projectId } = useProject();
  const pid = encodeURIComponent(projectId);
  const base = useId();
  const ids: Record<DraftField | "mode", string> = {
    targetQuery: `${base}-query`,
    draftText: `${base}-draft`,
    pageId: `${base}-page`,
    title: `${base}-title`,
    metaDescription: `${base}-meta`,
    pageType: `${base}-page-type`,
    productFacts: `${base}-facts`,
    mode: `${base}-mode`,
  };

  const [form, setForm] = useState<DraftForm>(EMPTY_FORM);
  const [errors, setErrors] = useState<FormErrors>({});
  const [running, setRunning] = useState(false);
  const [runError, setRunError] = useState<unknown>(null);
  const [generalErrors, setGeneralErrors] = useState<string[]>([]);
  const [checked, setChecked] = useState<Checked | null>(null);
  const [wantPages, setWantPages] = useState(false);
  const resultHeading = useRef<HTMLHeadingElement>(null);

  const pages = useApi<PageRow[]>(wantPages ? `/projects/${pid}/pages` : null, [pid]);
  const pageList = useMemo(() => sortPages(pages.data ?? []), [pages.data]);
  const selectedPage = pageList.find((p) => p.id === form.pageId) ?? null;

  useEffect(() => {
    if (checked) resultHeading.current?.focus();
  }, [checked]);

  function set<K extends keyof DraftForm>(key: K, value: DraftForm[K]) {
    setForm((f) => ({ ...f, [key]: value }));
    if (key !== "mode" && errors[key as DraftField]) setErrors((e) => ({ ...e, [key]: undefined }));
  }

  function setMode(mode: DraftMode) {
    set("mode", mode);
    if (mode === "page") setWantPages(true);
  }

  function focusField(field: DraftField) {
    const el = document.getElementById(ids[field]);
    if (el instanceof HTMLElement) el.focus();
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (running) return;
    const built = buildDraftCheckRequest(form);
    if (!built.ok) {
      setErrors(built.errors);
      const first = firstInvalidField(built.errors);
      if (first) focusField(first);
      return;
    }
    setErrors({});
    setGeneralErrors([]);
    setRunError(null);
    setRunning(true);
    try {
      const result = await api<DraftCheckResult>(`/projects/${pid}/seo/draft-check`, { method: "POST", body: built.body });
      setChecked({ result, request: built.body, page: form.mode === "page" ? selectedPage : null });
    } catch (err) {
      setRunError(err);
      if (err instanceof ApiError && err.status === 400) {
        const parsed = parseValidationDetails(err.body.details);
        setErrors(parsed.fields);
        setGeneralErrors(parsed.general);
        const first = firstInvalidField(parsed.fields);
        if (first) focusField(first);
      }
    } finally {
      setRunning(false);
    }
  }

  const draftLen = form.draftText.length;
  const queryLen = form.targetQuery.trim().length;

  return (
    <div className="min-w-0 space-y-4">
      <PageHeader
        title="Draft check"
        description="Check a draft or a crawled page against a target query before it goes to an editor. Flags unsupported claims, testimonials that need a source, guarantee language and filler, and runs the on-page checklist against the text."
      />

      <div role="note" aria-label="What this check is" className="rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-950 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-100">
        <p className="font-semibold">{GATE_LABEL}</p>
        <p className="mt-1 text-xs">Flags point at exact excerpts for a person to judge. A pass does not mean the page will rank or be cited.</p>
      </div>

      <details className="rounded-lg border border-zinc-200 bg-white px-3 py-2 text-sm text-zinc-800 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-200">
        <summary className="cursor-pointer font-medium">What the check covers</summary>
        <p className="mt-2 text-xs text-zinc-600 dark:text-zinc-400">{DRAFT_CHECKS_SUMMARY}</p>
        <ul className="mt-2 grid gap-1 sm:grid-cols-2">
          {DRAFT_CHECKS.map((c) => (
            <li key={c.id} className="flex min-w-0 flex-wrap items-baseline gap-x-2 text-xs">
              <span className="font-medium text-zinc-900 dark:text-zinc-100">{c.label}</span>
              <span className="text-zinc-600 dark:text-zinc-400">
                {c.method}
                {c.note ? ` · ${c.note}` : ""}
              </span>
            </li>
          ))}
        </ul>
      </details>

      <Card title="What to check">
        <form onSubmit={onSubmit} className="space-y-4" noValidate aria-describedby={`${base}-form-note`}>
          <TextField
            id={ids.targetQuery}
            label="Target query"
            required
            value={form.targetQuery}
            onChange={(e) => set("targetQuery", e.target.value)}
            autoComplete="off"
            placeholder="e.g. brass floor lamp for reading"
            hint={`The search query this page should answer. ${formatNumber(queryLen)} of ${MAX_QUERY_CHARS} characters.`}
            error={errors.targetQuery}
          />

          <fieldset className="min-w-0">
            <legend className="mb-1 text-sm font-medium text-zinc-800 dark:text-zinc-200">Source</legend>
            <div className="grid grid-cols-1 gap-2 sm:inline-grid sm:grid-cols-2">
              <ModeOption name={ids.mode} value="paste" current={form.mode} onChange={setMode} label="Paste a draft" hint="Text you have not published yet" />
              <ModeOption name={ids.mode} value="page" current={form.mode} onChange={setMode} label="Check a crawled page" hint="A page from your latest crawl" />
            </div>
          </fieldset>

          {form.mode === "paste" ? (
            <div className="space-y-4">
              <TextArea
                id={ids.draftText}
                label="Draft text"
                required
                rows={14}
                value={form.draftText}
                onChange={(e) => set("draftText", e.target.value)}
                placeholder="Paste the body copy here. Formatting is ignored; only the text is checked."
                hint={
                  <span className={cx(draftLen > MAX_DRAFT_CHARS * 0.95 && "font-medium text-amber-800 dark:text-amber-300")}>
                    {formatNumber(draftLen)} of {formatNumber(MAX_DRAFT_CHARS)} characters
                  </span>
                }
                error={errors.draftText}
              />
              <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                <TextField
                  id={ids.title}
                  label="Title (optional)"
                  value={form.title}
                  onChange={(e) => set("title", e.target.value)}
                  autoComplete="off"
                  hint={`The planned title tag. ${formatNumber(form.title.trim().length)} of ${MAX_TITLE_CHARS} characters.`}
                  error={errors.title}
                />
                <TextArea
                  id={ids.metaDescription}
                  label="Meta description (optional)"
                  rows={2}
                  value={form.metaDescription}
                  onChange={(e) => set("metaDescription", e.target.value)}
                  hint={`${formatNumber(form.metaDescription.trim().length)} of ${formatNumber(MAX_META_CHARS)} characters.`}
                  error={errors.metaDescription}
                  className="min-h-10"
                />
              </div>
              <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                <SelectField
                  id={ids.pageType}
                  label="Page type (optional)"
                  value={form.pageType ?? ""}
                  onChange={(e) => set("pageType", e.target.value as DraftForm["pageType"])}
                  hint="What the draft will be published as. Without a choice it is checked as an article."
                  error={errors.pageType}
                >
                  <option value="">Article (default)</option>
                  {DRAFT_PAGE_TYPES.filter((t) => t !== "article").map((t) => (
                    <option key={t} value={t}>
                      {pageTypeLabel(t)}
                    </option>
                  ))}
                </SelectField>
              </div>
              <ProductFactsEditor id={ids.productFacts} rows={form.productFacts ?? []} onChange={(rows) => set("productFacts", rows)} error={errors.productFacts} />
            </div>
          ) : (
            <PagePicker
              id={ids.pageId}
              projectId={projectId}
              pages={pageList}
              loading={pages.loading && !pages.data}
              error={pages.error}
              onRetry={pages.reload}
              value={form.pageId}
              selected={selectedPage}
              onChange={(v) => set("pageId", v)}
              fieldError={errors.pageId}
            />
          )}

          <div className="flex flex-wrap items-center gap-2">
            <Button type="submit" variant="primary" loading={running}>
              {running ? "Checking…" : "Run check"}
            </Button>
            <span id={`${base}-form-note`} className="text-xs text-zinc-600 dark:text-zinc-400">
              Rate-limited; Jev calls count against this project's daily budget.
            </span>
          </div>

          {runError != null && <RunErrorBanner error={runError} general={generalErrors} projectId={projectId} mode={form.mode} />}
        </form>
      </Card>

      <div aria-live="polite" className="sr-only">
        {running ? "Checking…" : checked ? `Check complete. ${verdictText(checked.result.verdict)}` : ""}
      </div>

      {checked && <DraftResult checked={checked} projectId={projectId} headingRef={resultHeading} />}
    </div>
  );
}

// ------------------------------------------------------------------ form parts
function ProductFactsEditor({ id, rows, onChange, error }: { id: string; rows: FactRow[]; onChange: (rows: FactRow[]) => void; error?: string }) {
  const update = (i: number, patch: Partial<FactRow>) => onChange(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;
  const describedBy = error ? `${errorId} ${hintId}` : hintId;
  return (
    <fieldset className="min-w-0 space-y-2" aria-describedby={describedBy}>
      <legend className="text-sm font-medium text-zinc-800 dark:text-zinc-200">Product facts (optional)</legend>
      <p id={hintId} className="text-xs text-zinc-600 dark:text-zinc-400">
        Fields the text must agree with, such as Material: Solid brass. Up to {MAX_PRODUCT_FACTS} fields; names up to {MAX_FACT_KEY_CHARS} characters, values up to {MAX_FACT_VALUE_CHARS}. Jev
        compares the text against them when TypeSafe is configured.
      </p>
      {rows.map((r, i) => (
        <div key={i} className="flex min-w-0 flex-wrap items-center gap-2">
          <input
            id={i === 0 ? id : undefined}
            aria-label={`Product field ${i + 1} name`}
            className={cx(inputClass, "min-w-0 flex-1 basis-32")}
            value={r.key}
            maxLength={MAX_FACT_KEY_CHARS + 20}
            onChange={(e) => update(i, { key: e.target.value })}
            placeholder="Field name"
            autoComplete="off"
            aria-invalid={error ? true : undefined}
          />
          <input
            aria-label={`Product field ${i + 1} value`}
            className={cx(inputClass, "min-w-0 flex-[2] basis-48")}
            value={r.value}
            maxLength={MAX_FACT_VALUE_CHARS + 20}
            onChange={(e) => update(i, { value: e.target.value })}
            placeholder="Value"
            autoComplete="off"
            aria-invalid={error ? true : undefined}
          />
          <Button size="sm" variant="ghost" onClick={() => onChange(rows.filter((_, j) => j !== i))} aria-label={`Remove product field ${i + 1}`}>
            Remove
          </Button>
        </div>
      ))}
      {error && (
        <p id={errorId} role="alert" className="text-xs font-medium text-red-700 dark:text-red-400">
          {error}
        </p>
      )}
      <Button id={rows.length === 0 ? id : undefined} size="sm" disabled={rows.length >= MAX_PRODUCT_FACTS} onClick={() => onChange([...rows, { key: "", value: "" }])}>
        Add product field
      </Button>
      {rows.length >= MAX_PRODUCT_FACTS && <p className="text-xs text-zinc-600 dark:text-zinc-400">The limit is {MAX_PRODUCT_FACTS} product fields.</p>}
    </fieldset>
  );
}

function ModeOption({
  name,
  value,
  current,
  onChange,
  label,
  hint,
}: {
  name: string;
  value: DraftMode;
  current: DraftMode;
  onChange: (m: DraftMode) => void;
  label: string;
  hint: string;
}) {
  const id = `${name}-${value}`;
  return (
    <label
      htmlFor={id}
      className={cx(
        "flex min-w-0 cursor-pointer items-start gap-2 rounded-lg border px-3 py-2 text-sm transition-colors",
        "border-zinc-300 bg-white text-zinc-800 hover:bg-zinc-50 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100 dark:hover:bg-zinc-800",
        "has-checked:border-zinc-900 has-checked:bg-zinc-900 has-checked:text-white dark:has-checked:border-zinc-100 dark:has-checked:bg-zinc-100 dark:has-checked:text-zinc-900",
        "has-focus-visible:outline-2 has-focus-visible:outline-offset-2 has-focus-visible:outline-sky-600 dark:has-focus-visible:outline-sky-400",
      )}
    >
      <input id={id} type="radio" name={name} value={value} checked={current === value} onChange={() => onChange(value)} className="mt-0.5 shrink-0 accent-sky-600" />
      <span className="min-w-0">
        <span className="block font-medium">{label}</span>
        <span className="block text-xs opacity-80">{hint}</span>
      </span>
    </label>
  );
}

function PagePicker({
  id,
  projectId,
  pages,
  loading,
  error,
  onRetry,
  value,
  selected,
  onChange,
  fieldError,
}: {
  id: string;
  projectId: string;
  pages: PageRow[];
  loading: boolean;
  error: unknown;
  onRetry: () => void;
  value: string;
  selected: PageRow | null;
  onChange: (v: string) => void;
  fieldError?: string;
}) {
  if (loading) return <LoadingState label="Loading crawled pages…" className="py-2" />;
  if (error != null && pages.length === 0) return <ErrorState error={error} title="Could not load crawled pages" onRetry={onRetry} />;
  if (pages.length === 0) {
    return (
      <StateBanner
        state="no_data"
        title="No crawled pages yet"
        message="Run a crawl from the SEO audit first, or paste the draft instead."
        action={
          <Link to={projectPath(projectId, "seo")} className={buttonClass("secondary", "sm")}>
            Go to SEO audit
          </Link>
        }
      />
    );
  }
  const hint = selected
    ? `${selected.title ? `“${selected.title}”. ` : ""}Last crawled ${selected.lastCrawledAt ? formatDateTime(selected.lastCrawledAt) : "never"}${selected.wordCount !== null ? ` · ${formatNumber(selected.wordCount)} words` : ""}.`
    : `${formatNumber(pages.length)} crawled pages. The page is checked as stored from the crawl.`;
  return (
    <SelectField id={id} label="Crawled page" required value={value} onChange={(e) => onChange(e.target.value)} hint={hint} error={fieldError}>
      <option value="">Choose a page…</option>
      {pages.map((p) => (
        <option key={p.id} value={p.id}>
          {pageOptionLabel(p)}
        </option>
      ))}
    </SelectField>
  );
}

function RunErrorBanner({ error, general, projectId, mode }: { error: unknown; general: string[]; projectId: string; mode: DraftMode }) {
  if (isSetupRequired(error)) {
    return (
      <StateBanner
        state="setup_required"
        message={errorMessage(error)}
        action={
          <Link to={projectPath(projectId, mode === "page" ? "seo" : "integrations")} className={buttonClass("secondary", "sm")}>
            {mode === "page" ? "Go to SEO audit" : "Open Integrations"}
          </Link>
        }
      />
    );
  }
  if (isRateLimited(error)) {
    return <StateBanner state="rate_limited" message={`${errorMessage(error)} Wait a moment, then run the check again.`} />;
  }
  if (error instanceof ApiError && error.status === 400) {
    return (
      <div role="alert" className="rounded-lg border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-900 dark:border-red-800 dark:bg-red-950 dark:text-red-200">
        <p className="font-semibold">The server could not accept this request</p>
        <p className="mt-0.5 break-words">{errorMessage(error)}</p>
        {general.length > 0 && (
          <ul className="mt-1 list-disc space-y-0.5 pl-5">
            {general.map((m, i) => (
              <li key={i} className="break-words">
                {m}
              </li>
            ))}
          </ul>
        )}
      </div>
    );
  }
  return <ErrorState error={error} title="The check could not run" />;
}

// ------------------------------------------------------------------ result
const verdictPanel: Record<"success" | "warning" | "danger", string> = {
  success: "border-emerald-300 bg-emerald-50 text-emerald-950 dark:border-emerald-800 dark:bg-emerald-950 dark:text-emerald-100",
  warning: "border-amber-300 bg-amber-50 text-amber-950 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-100",
  danger: "border-red-300 bg-red-50 text-red-950 dark:border-red-800 dark:bg-red-950 dark:text-red-100",
};

function DraftResult({ checked, projectId, headingRef }: { checked: Checked; projectId: string; headingRef: RefObject<HTMLHeadingElement | null> }) {
  const { result, request, page } = checked;
  const headingId = useId();
  const verdict = VERDICT_META[result.verdict] ?? { label: String(result.verdict), tone: "warning" as const, symbol: "?", explanation: "" };
  const groups = useMemo(() => groupFlags(result.flags), [result.flags]);
  const labels = useMemo(() => extraLabels(result.labels), [result.labels]);
  const checklist = useMemo(() => readOnlyChecklist(result.checklist), [result.checklist]);

  return (
    <section aria-labelledby={headingId} className="min-w-0 space-y-4">
      <div className="min-w-0">
        <h2 id={headingId} ref={headingRef} tabIndex={-1} className="rounded text-lg font-semibold text-zinc-900 focus-visible:outline-2 focus-visible:outline-sky-600 dark:text-zinc-50">
          Result
        </h2>
        <p className="mt-0.5 break-words text-sm text-zinc-600 dark:text-zinc-400">
          For “{request.targetQuery}” ·{" "}
          {request.pageId ? (
            <>
              crawled page <span className="break-all">{page?.url ?? request.pageId}</span>
            </>
          ) : (
            `pasted draft (${formatNumber(request.draftText?.length ?? 0)} characters)`
          )}
        </p>
      </div>

      <div className={cx("rounded-xl border px-4 py-3", verdictPanel[verdict.tone])}>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <p className="flex items-center gap-2 text-xl font-semibold">
            <span aria-hidden="true" className="inline-flex h-7 w-7 items-center justify-center rounded-full border-2 border-current text-base leading-none">
              {verdict.symbol}
            </span>
            <span>
              <span className="sr-only">Verdict: </span>
              {verdict.label}
            </span>
          </p>
          <div className="flex flex-wrap items-center gap-1.5">
            {result.jevUsed ? (
              <Badge tone="info" title="Some flags or checklist items were judged by Jev (a model). Check them yourself.">
                Jev used
              </Badge>
            ) : (
              <Badge tone="neutral" title="Only fixed rules ran; no model call was made.">
                Jev not used · rules only
              </Badge>
            )}
            {result.state !== "ready" && <StateBadge state={result.state} />}
          </div>
        </div>
        {verdict.explanation && <p className="mt-1 text-sm">{verdict.explanation}</p>}
      </div>

      {result.state === "demo" && <StateBanner state="demo" message="Demo project: a simulated result, not a check of real content." />}
      {result.state === "setup_required" && (
        <StateBanner
          state="setup_required"
          message="Some checks need setup and did not run. See the notes below."
          action={
            <Link to={projectPath(projectId, "integrations")} className={buttonClass("secondary", "sm")}>
              Open Integrations
            </Link>
          }
        />
      )}
      {result.state === "error" && <StateBanner state="error" message="Part of the check failed, so this result may be incomplete." />}

      {labels.length > 0 && (
        <div role="note" aria-label="About this result" className="rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-950 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-100">
          <ul className="space-y-1">
            {labels.map((l, i) => (
              <li key={i} className="break-words font-medium">
                {l}
              </li>
            ))}
          </ul>
        </div>
      )}

      <Card
        title="Flagged excerpts"
        description="Exact text from the draft. Each flag says whether a rule or Jev raised it."
        actions={<Badge tone={result.flags.length > 0 ? "warning" : "neutral"}>{formatNumber(result.flags.length)} flagged</Badge>}
      >
        {groups.length === 0 ? (
          <p className="text-sm text-zinc-700 dark:text-zinc-300">No excerpts were flagged by the checks that ran. A person should still read the draft.</p>
        ) : (
          <div className="space-y-5">
            {groups.map((g) => (
              <FlagGroupView key={g.kind} group={g} />
            ))}
          </div>
        )}
      </Card>

      <section aria-labelledby={`${headingId}-checklist`} className="min-w-0 space-y-3">
        <div>
          <h2 id={`${headingId}-checklist`} className="text-base font-semibold text-zinc-900 dark:text-zinc-50">
            On-page checklist for this {request.pageId ? "page" : "draft"}
          </h2>
          <p className="mt-0.5 text-xs text-zinc-600 dark:text-zinc-400">
            Evaluated against the text above. Read-only here; manual items are confirmed on a page's own checklist.
            {request.pageId && (
              <>
                {" "}
                <Link to={projectPath(projectId, `pages/${encodeURIComponent(request.pageId)}/checklist`)} className="text-sky-800 underline dark:text-sky-300">
                  Open this page's checklist
                </Link>
                .
              </>
            )}
          </p>
        </div>
        {checklist.disclaimer && <Disclaimer text={checklist.disclaimer} />}
        {checklist.items.length === 0 ? (
          <p className="text-sm text-zinc-700 dark:text-zinc-300">No checklist items were returned for this check.</p>
        ) : (
          <ChecklistView checklist={checklist} projectId={projectId} putPath={noPutPath} onItemSaved={noop} />
        )}
      </section>
    </section>
  );
}

function FlagGroupView({ group }: { group: ReturnType<typeof groupFlags>[number] }) {
  const headingId = useId();
  return (
    <section aria-labelledby={headingId} className="min-w-0">
      <h3 id={headingId} className="flex flex-wrap items-center gap-2 text-sm font-semibold text-zinc-900 dark:text-zinc-100">
        {group.label}
        <Badge tone="neutral">{formatNumber(group.flags.length)}</Badge>
      </h3>
      {group.description && <p className="mt-0.5 text-xs text-zinc-600 dark:text-zinc-400">{group.description}</p>}
      <ul className="mt-2 space-y-2">
        {group.flags.map((f, i) => {
          const noul = noulText(f.noul);
          return (
            <li key={i} className="min-w-0 rounded-lg border border-zinc-200 p-3 dark:border-zinc-800">
              <blockquote className="whitespace-pre-wrap break-words border-l-2 border-amber-400 pl-3 text-sm text-zinc-900 dark:border-amber-600 dark:text-zinc-100">
                {f.text}
              </blockquote>
              <div className="mt-2 flex flex-wrap items-center gap-1.5 text-xs text-zinc-600 dark:text-zinc-400">
                <Badge tone={f.method === "jev" ? "info" : "neutral"} title={FLAG_METHOD_HINT[f.method]}>
                  <span className="sr-only">Method: </span>
                  {FLAG_METHOD_LABEL[f.method] ?? f.method}
                </Badge>
                {noul !== null && (
                  <span className="rounded-full bg-zinc-100 px-2 py-0.5 font-mono tabular-nums text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300">noul {noul}</span>
                )}
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
