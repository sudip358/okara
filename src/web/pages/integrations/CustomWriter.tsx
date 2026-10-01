/**
 * Writer card on the Integrations page: choose the operator-configured default writer or a custom
 * OpenAI-compatible provider (base URL + API key, "Fetch models", searchable model list with a manual id
 * fallback, Save). Keys are write-only (only the last 4 characters come back). Model ids and provider
 * names are untrusted text and are only ever rendered as plain text. OWNED BY: web-shell.
 */
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import type { CustomProviderModelList, CustomProviderStatus, CustomProvidersResponse, IntegrationsStatus, WriterSource } from "@shared/types";
import { api, errorMessage } from "@web/lib/api";
import { useApi, useMutation, type ApiState } from "@web/lib/hooks";
import { formatDateTime } from "@web/lib/format";
import { Button, ErrorState, LoadingState, SelectField, StateBadge, TextField, cx } from "@web/components/ui";
import { activeCustomWriter, baseUrlInputError, defaultWriterName, fieldErrorFor, filterModels, isFieldError, testOutcomeText } from "./custom-writer-lib";

type ProviderStatus = IntegrationsStatus["providers"][number];
type TestResult = { ok: boolean | null; detail: string };

const errorText = "text-red-700 dark:text-red-400";
const mutedText = "text-xs text-zinc-600 dark:text-zinc-400";

const customState = (p: CustomProviderStatus) => (p.lastTestOk === false ? "error" : "ready");

const providersPath = (workspaceId: string) => `/workspaces/${encodeURIComponent(workspaceId)}/custom-providers`;

/** The whole writer row: provider type choice, then the default key panel or the custom provider panel. */
export function WriterProviderRow({
  workspaceId,
  writer,
  defaultPanel,
  onChange,
}: {
  workspaceId: string;
  /** Status of the operator-configured default writer (GET /credentials, provider "writer"). */
  writer: ProviderStatus;
  /** The existing key row for the default writer. */
  defaultPanel: ReactNode;
  onChange: () => void;
}) {
  const id = useId();
  const list = useApi<CustomProvidersResponse>(providersPath(workspaceId));
  const active = activeCustomWriter(list.data);
  const [choice, setChoice] = useState<"default" | "custom" | null>(null);
  const shown = choice ?? (active ? "custom" : "default");
  const defaultName = defaultWriterName(writer.label);
  const useDefault = useMutation(() =>
    api<CustomProvidersResponse>(`/workspaces/${encodeURIComponent(workspaceId)}/writer-source`, { method: "PUT", body: { source: "default" satisfies WriterSource } }),
  );
  const apply = (next: CustomProvidersResponse) => {
    list.setData(next);
    onChange();
  };

  return (
    <section aria-labelledby={`${id}-title`} className="rounded-lg border border-zinc-200 p-3 dark:border-zinc-800">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <h3 id={`${id}-title`} className="text-sm font-semibold">
            Writer
          </h3>
          <p className={mutedText}>
            Active writer:{" "}
            {list.loading && !list.data ? (
              "loading…"
            ) : active ? (
              <>
                Custom (OpenAI-compatible) · <span className="break-all font-mono">{active.host}</span> · model{" "}
                <span className="break-all font-mono">{active.model}</span>
              </>
            ) : (
              <>
                {defaultName}
                {writer.model && (
                  <>
                    {" "}
                    · model <span className="break-all font-mono">{writer.model}</span>
                  </>
                )}
              </>
            )}
          </p>
        </div>
        <StateBadge state={active ? customState(active) : writer.state} />
      </div>

      <fieldset className="mt-3">
        <legend className="text-sm font-medium text-zinc-800 dark:text-zinc-200">Provider type</legend>
        <div className="mt-1 flex flex-wrap gap-x-5 gap-y-2">
          <label className="flex min-h-8 items-center gap-2 text-sm">
            <input type="radio" name={`${id}-type`} value="default" checked={shown === "default"} onChange={() => setChoice("default")} />
            {defaultName}
          </label>
          <label className="flex min-h-8 items-center gap-2 text-sm">
            <input type="radio" name={`${id}-type`} value="custom" checked={shown === "custom"} onChange={() => setChoice("custom")} />
            Custom (OpenAI-compatible)
          </label>
        </div>
      </fieldset>

      <div className="mt-3">
        {shown === "default" ? (
          <div className="space-y-3">
            {active && (
              <div role="status" className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-sky-300 bg-sky-50 px-3 py-2 text-sm text-sky-900 dark:border-sky-800 dark:bg-sky-950 dark:text-sky-200">
                <span className="min-w-0">
                  The custom provider <span className="break-all font-mono">{active.host}</span> is the active writer. The default writer below is not used until you switch back.
                </span>
                {list.data?.canManage && (
                  <Button
                    size="sm"
                    loading={useDefault.loading}
                    onClick={async () => {
                      const next = await useDefault.run();
                      if (next) {
                        apply(next);
                        setChoice(null);
                      }
                    }}
                  >
                    Use {defaultName} instead
                  </Button>
                )}
              </div>
            )}
            {useDefault.error !== null && <p className={cx("text-xs", errorText)}>{errorMessage(useDefault.error)}</p>}
            {defaultPanel}
          </div>
        ) : (
          <CustomWriterPanel
            workspaceId={workspaceId}
            state={list}
            apply={(next) => {
              apply(next);
              setChoice(null);
            }}
          />
        )}
      </div>
    </section>
  );
}

function CustomHelp({ dataSent }: { dataSent: string }) {
  return (
    <div className="space-y-1 rounded bg-zinc-50 px-2 py-1.5 text-xs text-zinc-700 dark:bg-zinc-950 dark:text-zinc-300">
      <p>
        Use any OpenAI-compatible API (for example OpenRouter, Groq, Together, DeepSeek, Mistral, or your own gateway): enter its base URL and API key,
        fetch its models, pick one, and save. Saving makes it this workspace's writer.
      </p>
      <p>
        <span className="font-medium">Data sent:</span> {dataSent}
      </p>
      <p>
        The key is stored encrypted on the server and never shown again (only its last 4 characters). The model list is fetched by the server; requests go
        only to the base URL's host over https and never follow redirects.
      </p>
      <p>The model must support JSON-schema structured output (response_format json_schema). Costs of custom provider calls are recorded as unknown.</p>
    </div>
  );
}

function CustomWriterPanel({ workspaceId, state, apply }: { workspaceId: string; state: ApiState<CustomProvidersResponse>; apply: (next: CustomProvidersResponse) => void }) {
  /** null: no form; "new": add form; otherwise the id of the provider being edited. */
  const [editing, setEditing] = useState<string | null>(null);
  const data = state.data;
  if (state.loading && !data) return <LoadingState />;
  if (!data) return <ErrorState error={state.error} onRetry={state.reload} />;
  const active = activeCustomWriter(data);
  const others = data.providers.filter((p) => !p.isWriter);
  const formOpen = data.canManage && (editing !== null || data.providers.length === 0);
  const editingProvider = editing && editing !== "new" ? (data.providers.find((p) => p.id === editing) ?? null) : null;
  const saved = (next: CustomProvidersResponse) => {
    setEditing(null);
    apply(next);
  };

  return (
    <div className="space-y-3">
      <CustomHelp dataSent={data.dataSent} />
      {!data.canManage && <p className={mutedText}>Only the workspace owner can add, change, or remove custom providers.</p>}
      {state.error !== null && <ErrorState error={state.error} onRetry={state.reload} title="Could not refresh custom providers" />}

      {active && editing !== active.id && (
        <SavedProviderItem workspaceId={workspaceId} p={active} canManage={data.canManage} apply={apply} reload={state.reload} onEdit={() => setEditing(active.id)} />
      )}

      {formOpen && (
        <CustomProviderForm
          key={editing ?? "new"}
          workspaceId={workspaceId}
          initial={editingProvider}
          onSaved={saved}
          onCancel={data.providers.length > 0 ? () => setEditing(null) : undefined}
        />
      )}

      {others.length > 0 && (
        <div className="space-y-2">
          <p className="text-sm font-medium">{active ? "Other saved custom providers" : "Saved custom providers (not in use)"}</p>
          <ul className="space-y-2">
            {others
              .filter((p) => p.id !== editing)
              .map((p) => (
                <li key={p.id}>
                  <SavedProviderItem workspaceId={workspaceId} p={p} canManage={data.canManage} apply={apply} reload={state.reload} onEdit={() => setEditing(p.id)} />
                </li>
              ))}
          </ul>
        </div>
      )}

      {data.canManage && !formOpen && (
        <div>
          {data.providers.length < data.maxProviders ? (
            <Button size="sm" onClick={() => setEditing("new")}>
              {data.providers.length === 0 ? "Add a custom provider" : "Add another custom provider"}
            </Button>
          ) : (
            <p className={mutedText}>This workspace has the maximum of {data.maxProviders} custom providers; remove one to add another.</p>
          )}
        </div>
      )}
    </div>
  );
}

/** One saved provider: details, Test, Change model, Edit, Use as writer, Remove. */
export function SavedProviderItem({
  workspaceId,
  p,
  canManage,
  apply,
  reload,
  onEdit,
}: {
  workspaceId: string;
  p: CustomProviderStatus;
  canManage: boolean;
  apply: (next: CustomProvidersResponse) => void;
  reload: () => void;
  onEdit: () => void;
}) {
  const base = `${providersPath(workspaceId)}/${encodeURIComponent(p.id)}`;
  const test = useMutation(() => api<TestResult>(`${base}/test`, { method: "POST", body: {} }));
  const del = useMutation(() => api<CustomProvidersResponse>(base, { method: "DELETE" }));
  const use = useMutation(() =>
    api<CustomProvidersResponse>(`/workspaces/${encodeURIComponent(workspaceId)}/writer-source`, { method: "PUT", body: { source: `custom:${p.id}` satisfies WriterSource } }),
  );
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [changingModel, setChangingModel] = useState(false);

  return (
    <div className={cx("rounded-lg border p-3", p.isWriter ? "border-emerald-300 dark:border-emerald-800" : "border-zinc-200 dark:border-zinc-800")}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="break-words text-sm font-semibold">
            {p.label}
            {p.isWriter && <span className="ml-2 text-xs font-medium text-emerald-800 dark:text-emerald-300">Active writer</span>}
          </p>
          <dl className="mt-1 space-y-0.5 text-xs">
            <div className="flex flex-wrap gap-x-2">
              <dt className="text-zinc-600 dark:text-zinc-400">Base URL</dt>
              <dd className="min-w-0 break-all font-mono">{p.baseUrl}</dd>
            </div>
            <div className="flex flex-wrap gap-x-2">
              <dt className="text-zinc-600 dark:text-zinc-400">Model</dt>
              <dd className="min-w-0 break-all font-mono">{p.model}</dd>
            </div>
            <div className="flex flex-wrap gap-x-2">
              <dt className="text-zinc-600 dark:text-zinc-400">Key</dt>
              <dd className="font-mono">…{p.keyHint}</dd>
            </div>
            <div className="flex flex-wrap gap-x-2">
              <dt className="text-zinc-600 dark:text-zinc-400">Last test</dt>
              <dd className="min-w-0 break-words">
                {p.lastTestedAt ? (
                  <>
                    {formatDateTime(p.lastTestedAt)} — {p.lastTestOk === true ? "passed" : p.lastTestOk === null ? "not confirmed" : "failed"}
                    {p.lastTestDetail && ` (${p.lastTestDetail})`}
                  </>
                ) : (
                  "never"
                )}
              </dd>
            </div>
          </dl>
        </div>
        <StateBadge state={customState(p)} />
      </div>

      {changingModel ? (
        <ModelChanger
          workspaceId={workspaceId}
          p={p}
          onSaved={(next) => {
            setChangingModel(false);
            apply(next);
          }}
          onCancel={() => setChangingModel(false)}
        />
      ) : (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <Button
            size="sm"
            loading={test.loading}
            onClick={async () => {
              const r = await test.run();
              if (r) reload();
            }}
          >
            Test
          </Button>
          {canManage && (
            <>
              {!p.isWriter && (
                <Button
                  size="sm"
                  variant="primary"
                  loading={use.loading}
                  onClick={async () => {
                    const next = await use.run();
                    if (next) apply(next);
                  }}
                >
                  Use as writer
                </Button>
              )}
              <Button size="sm" onClick={() => setChangingModel(true)}>
                Change model
              </Button>
              <Button size="sm" variant="ghost" onClick={onEdit}>
                Edit URL or key
              </Button>
              {!confirmDelete ? (
                <Button size="sm" variant="ghost" onClick={() => setConfirmDelete(true)}>
                  Remove
                </Button>
              ) : (
                <span className="flex flex-wrap items-center gap-1">
                  <span className="text-xs">{p.isWriter ? "Remove it? The writer switches back to the default." : "Remove it?"}</span>
                  <Button
                    size="sm"
                    variant="danger"
                    loading={del.loading}
                    onClick={async () => {
                      const next = await del.run();
                      setConfirmDelete(false);
                      if (next) apply(next);
                    }}
                  >
                    Confirm remove
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => setConfirmDelete(false)}>
                    Cancel
                  </Button>
                </span>
              )}
            </>
          )}
        </div>
      )}
      <div aria-live="polite" className="mt-2 text-xs">
        {test.data && <span className={test.data.ok === true ? "text-emerald-800 dark:text-emerald-300" : test.data.ok === null ? "text-amber-800 dark:text-amber-300" : errorText}>{testOutcomeText(test.data.ok, test.data.detail)}</span>}
        {[test.error, del.error, use.error].map((e, i) =>
          e !== null ? (
            <span key={i} className={cx("block", errorText)}>
              {errorMessage(e)}
            </span>
          ) : null,
        )}
      </div>
    </div>
  );
}

/** "Change model": re-fetches the saved provider's model list with its stored key, then PATCHes the model. */
function ModelChanger({ workspaceId, p, onSaved, onCancel }: { workspaceId: string; p: CustomProviderStatus; onSaved: (next: CustomProvidersResponse) => void; onCancel: () => void }) {
  const id = useId();
  const fetchModels = useMutation(() => api<CustomProviderModelList>(`${providersPath(workspaceId)}/models`, { method: "POST", body: { providerId: p.id } }));
  const save = useMutation((model: string) => api<CustomProvidersResponse>(`${providersPath(workspaceId)}/${encodeURIComponent(p.id)}`, { method: "PATCH", body: { model } }));
  const [model, setModel] = useState(p.model);
  const run = fetchModels.run;
  // Fetch once when opened (the ref also keeps React StrictMode's double effect from calling the provider twice).
  const started = useRef(false);
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    void run();
  }, [run]);

  return (
    <form
      className="mt-3 space-y-2 border-t border-zinc-100 pt-3 dark:border-zinc-800"
      onSubmit={async (e) => {
        e.preventDefault();
        if (!model.trim()) return;
        const next = await save.run(model.trim());
        if (next) onSaved(next);
      }}
    >
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" loading={fetchModels.loading} onClick={() => void fetchModels.run()}>
          Re-fetch models
        </Button>
        {fetchModels.loading && <span className={mutedText}>Fetching the model list from {p.host}…</span>}
      </div>
      <FetchOutcome result={fetchModels.data} error={fetchModels.error} />
      <ModelPicker id={id} list={fetchModels.data} value={model} onChange={setModel} error={fieldErrorFor(save.error, "model")} />
      <div className="flex flex-wrap gap-2">
        <Button type="submit" size="sm" variant="primary" loading={save.loading} disabled={!model.trim() || model.trim() === p.model}>
          Save model
        </Button>
        <Button size="sm" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
      </div>
      {save.error !== null && !isFieldError(save.error, ["model"]) && <p className={cx("text-xs", errorText)}>{errorMessage(save.error)}</p>}
    </form>
  );
}

/** Add (initial = null) or edit a custom provider: base URL, API key, Fetch models, model, Save. */
export function CustomProviderForm({
  workspaceId,
  initial,
  onSaved,
  onCancel,
}: {
  workspaceId: string;
  initial: CustomProviderStatus | null;
  onSaved: (next: CustomProvidersResponse) => void;
  onCancel?: () => void;
}) {
  const id = useId();
  const path = providersPath(workspaceId);
  const [label, setLabel] = useState(initial?.label ?? "");
  const [baseUrl, setBaseUrl] = useState(initial?.baseUrl ?? "");
  const [apiKey, setApiKey] = useState("");
  const [model, setModel] = useState(initial?.model ?? "");
  const [clientError, setClientError] = useState<{ field: "baseUrl" | "apiKey" | "model"; message: string } | null>(null);
  const fetchModels = useMutation((body: { baseUrl: string; apiKey: string } | { providerId: string }) =>
    api<CustomProviderModelList>(`${path}/models`, { method: "POST", body }),
  );
  const save = useMutation((body: Record<string, unknown>) =>
    initial
      ? api<CustomProvidersResponse>(`${path}/${encodeURIComponent(initial.id)}`, { method: "PATCH", body })
      : api<CustomProvidersResponse>(path, { method: "POST", body }),
  );
  const sameUrl = initial !== null && baseUrl.trim() === initial.baseUrl;
  const keyNeeded = !initial || !sameUrl;
  const err = (field: "baseUrl" | "apiKey" | "model" | "label") =>
    (clientError?.field === field ? clientError.message : null) ?? fieldErrorFor(fetchModels.error, field) ?? fieldErrorFor(save.error, field);

  const resetFetched = () => {
    if (fetchModels.data || fetchModels.error) fetchModels.reset();
  };

  const doFetch = async () => {
    setClientError(null);
    const urlError = baseUrlInputError(baseUrl);
    if (urlError) return setClientError({ field: "baseUrl", message: urlError });
    if (apiKey.trim()) await fetchModels.run({ baseUrl: baseUrl.trim(), apiKey: apiKey.trim() });
    else if (initial && sameUrl) await fetchModels.run({ providerId: initial.id });
    else setClientError({ field: "apiKey", message: "Enter the API key to fetch the provider's models." });
  };

  return (
    <form
      noValidate
      className="space-y-3 rounded-lg border border-zinc-200 p-3 dark:border-zinc-800"
      aria-label={initial ? `Edit ${initial.label}` : "Add a custom provider"}
      onSubmit={async (e) => {
        e.preventDefault();
        setClientError(null);
        const urlError = baseUrlInputError(baseUrl);
        if (urlError) return setClientError({ field: "baseUrl", message: urlError });
        if (keyNeeded && !apiKey.trim()) {
          return setClientError({ field: "apiKey", message: initial ? "Re-enter the API key when changing the base URL." : "Enter the API key." });
        }
        if (!model.trim()) return setClientError({ field: "model", message: "Choose a model, or type a model id." });
        const body: Record<string, unknown> = { baseUrl: baseUrl.trim(), model: model.trim() };
        if (label.trim()) body.label = label.trim();
        if (apiKey.trim()) body.apiKey = apiKey.trim();
        if (!initial) body.useAsWriter = true;
        const next = await save.run(body);
        if (next) {
          setApiKey("");
          onSaved(next);
        }
      }}
    >
      <p className="text-sm font-medium">{initial ? `Edit ${initial.label}` : "Custom provider (OpenAI-compatible)"}</p>
      <div className="grid gap-3 sm:grid-cols-2">
        <TextField
          id={`${id}-url`}
          label="Base URL"
          type="url"
          inputMode="url"
          autoComplete="off"
          spellCheck={false}
          required
          value={baseUrl}
          onChange={(e) => {
            setBaseUrl(e.target.value);
            resetFetched();
          }}
          placeholder="https://openrouter.ai/api/v1"
          hint="The part before /chat/completions. https only; public hostnames only."
          error={err("baseUrl")}
        />
        <TextField
          id={`${id}-key`}
          label="API key"
          type="password"
          autoComplete="off"
          spellCheck={false}
          required={keyNeeded}
          value={apiKey}
          onChange={(e) => {
            setApiKey(e.target.value);
            resetFetched();
          }}
          placeholder={initial ? (sameUrl ? `Keep …${initial.keyHint}` : "Required for a new base URL") : "Paste key"}
          hint={initial && sameUrl ? "Leave empty to keep the saved key." : "Stored encrypted; never shown again."}
          error={err("apiKey")}
        />
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Button loading={fetchModels.loading} onClick={() => void doFetch()} disabled={!baseUrl.trim()}>
          Fetch models
        </Button>
        {fetchModels.loading && <span className={mutedText}>Asking the provider for its model list…</span>}
      </div>
      <FetchOutcome result={fetchModels.data} error={isFieldError(fetchModels.error, ["baseUrl", "apiKey"]) ? null : fetchModels.error} />
      <ModelPicker id={id} list={fetchModels.data} value={model} onChange={setModel} error={err("model")} />
      <div className="sm:max-w-sm">
        <TextField
          id={`${id}-label`}
          label="Name (optional)"
          autoComplete="off"
          maxLength={60}
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          placeholder="Defaults to the host name"
          error={err("label")}
        />
      </div>
      <div className="flex flex-wrap gap-2">
        <Button type="submit" variant="primary" loading={save.loading}>
          {initial ? "Save changes" : "Save and use as writer"}
        </Button>
        {onCancel && (
          <Button variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
        )}
      </div>
      {save.error !== null && !isFieldError(save.error, ["baseUrl", "apiKey", "model", "label"]) && (
        <p role="alert" className={cx("text-xs", errorText)}>
          {errorMessage(save.error)}
        </p>
      )}
    </form>
  );
}

/** Outcome of a model-list fetch: provider detail (our text, never the provider's body) or the request error. */
function FetchOutcome({ result, error }: { result: CustomProviderModelList | null; error: unknown }) {
  return (
    <div aria-live="polite" className="text-xs">
      {result &&
        (result.ok === true ? (
          <span className={result.models.length ? "text-emerald-800 dark:text-emerald-300" : "text-amber-800 dark:text-amber-300"}>{result.detail}</span>
        ) : result.ok === null ? (
          <span className="text-amber-800 dark:text-amber-300">{result.detail}</span>
        ) : (
          <span role="alert" className={errorText}>
            {result.detail}
          </span>
        ))}
      {error !== null && error !== undefined && (
        <span role="alert" className={cx("block", errorText)}>
          {errorMessage(error)}
        </span>
      )}
    </div>
  );
}

/**
 * Searchable model dropdown over the fetched list (search box narrows the options; the current value
 * stays selectable), with a manual "type a model id" fallback, used automatically when no list is available.
 */
export function ModelPicker({
  id,
  list,
  value,
  onChange,
  error,
}: {
  id: string;
  list: CustomProviderModelList | null;
  value: string;
  onChange: (v: string) => void;
  error?: string | null;
}) {
  const models = list?.models ?? [];
  const [manual, setManual] = useState(false);
  const [query, setQuery] = useState("");
  if (models.length > 0 && !manual) {
    const { shown, matched } = filterModels(models, query);
    const options = value && !shown.includes(value) ? [value, ...shown] : shown;
    const more = matched > shown.length ? ` (first ${shown.length} shown; refine the search)` : "";
    return (
      <div className="space-y-2">
        <div className="grid gap-3 sm:grid-cols-2">
          <TextField
            id={`${id}-search`}
            label="Search models"
            type="search"
            autoComplete="off"
            spellCheck={false}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Filter, e.g. llama 70b"
          />
          <SelectField
            id={`${id}-model`}
            label="Model"
            value={value}
            onChange={(e) => onChange(e.target.value)}
            error={error}
            hint={`${matched} of ${list!.total} models match${more}.${list!.truncated ? " The provider listed more than 500; type the id if yours is missing." : ""}`}
          >
            <option value="">Select a model…</option>
            {options.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </SelectField>
        </div>
        <Button size="sm" variant="ghost" onClick={() => setManual(true)}>
          Type a model id instead
        </Button>
      </div>
    );
  }
  return (
    <div className="space-y-1 sm:max-w-md">
      <TextField
        id={`${id}-model-manual`}
        label="Model id"
        autoComplete="off"
        spellCheck={false}
        maxLength={200}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="provider/model-name"
        error={error}
        hint={
          models.length > 0
            ? "The exact model id as the provider names it."
            : "Fetch models to pick from the provider's list, or type the exact model id from its documentation."
        }
      />
      {models.length > 0 && (
        <Button size="sm" variant="ghost" onClick={() => setManual(false)}>
          Pick from the fetched list
        </Button>
      )}
    </div>
  );
}
