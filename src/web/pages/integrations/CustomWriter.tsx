/**
 * Writer card on the Integrations page: choose the operator-configured default writer or a custom
 * OpenAI-compatible provider (base URL + API key, "Fetch models", searchable model list with a manual id
 * fallback, Save). Keys are write-only (only the last 4 characters come back). Model ids and provider
 * names are untrusted text and are only ever rendered as plain text. OWNED BY: web-shell.
 *
 * Base URLs that keep changing (tunnels such as *.trycloudflare.com, *.ngrok-free.app, *.loca.lt): "Edit URL
 * or key" and the inline "Quick update URL" accept a URL on a new host without re-entering the key, but only
 * after the owner ticks "Send my saved key to <new host>" (unchecked by default; Save stays disabled until it
 * is ticked or a new key is typed). After saving, Test re-runs automatically and "Change model" is offered when
 * the saved model is not in the new host's model list. The card shows when the URL last changed and by whom.
 */
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import type {
  ChatModelSource,
  CustomProviderInput,
  CustomProviderModelList,
  CustomProviderPatchInput,
  CustomProviderRole,
  CustomProviderStatus,
  CustomProvidersResponse,
  IntegrationsStatus,
  ProviderModelOption,
  WriterSource,
} from "@shared/types";
import { api, errorMessage } from "@web/lib/api";
import { useApi, useMutation, type ApiState } from "@web/lib/hooks";
import { formatDateTime } from "@web/lib/format";
import { Button, ErrorState, LoadingState, SelectField, StateBadge, TextField, cx } from "@web/components/ui";
import {
  activeCustomWriter,
  activeWriterChanged,
  baseUrlInputError,
  defaultWriterName,
  editPatchBody,
  fieldErrorFor,
  hostChangeGate,
  isFieldError,
  latestUrlChange,
  modelNotListed,
  newProviderBody,
  quickUrlPatchBody,
  retestIdAfterSave,
  sendSavedKeyLabel,
  testOutcomeText,
  TUNNEL_NAME_NOTE,
  urlChangeSummary,
} from "./custom-writer-lib";
import { CUSTOM_GEO_NOTE, filterModelOptions, toOptions, writerProviders } from "./model-lib";

type ProviderStatus = IntegrationsStatus["providers"][number];
/** POST .../custom-providers/:id/test. modelListed: is the saved model in the provider's list (null: unknown). */
type TestResult = { ok: boolean | null; detail: string; modelListed?: boolean | null };
/** After a save: the provider whose Test re-runs automatically (its URL or key changed); null for none. */
export type SavedInfo = { retestId: string | null };

const errorText = "text-red-700 dark:text-red-400";
const mutedText = "text-xs text-zinc-600 dark:text-zinc-400";

const customState = (p: CustomProviderStatus) => (p.lastTestOk === false ? "error" : "ready");

export const providersPath = (workspaceId: string) => `/workspaces/${encodeURIComponent(workspaceId)}/custom-providers`;

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
              const changed = activeWriterChanged(list.data, next);
              apply(next);
              // Leave the Custom panel only when the active writer changed (activated, switched or removed), never
              // after an edit of a saved provider: its automatic re-test and "Change model" offer must stay visible.
              if (changed) setChoice(null);
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
  /** A base URL typed in "Quick update URL" and handed to the full form ("Enter a new key instead"). */
  const [prefillUrl, setPrefillUrl] = useState<string | undefined>(undefined);
  /** Provider whose Test re-runs once its card is back (after its URL or key changed). */
  const [retestId, setRetestId] = useState<string | null>(null);
  const data = state.data;
  if (state.loading && !data) return <LoadingState />;
  if (!data) return <ErrorState error={state.error} onRetry={state.reload} />;
  const active = activeCustomWriter(data);
  // Custom GEO engines (role "geo") live in the AI engines section, never here.
  const writers = writerProviders(data);
  const others = writers.filter((p) => !p.isWriter);
  const formOpen = data.canManage && (editing !== null || writers.length === 0);
  const editingProvider = editing && editing !== "new" ? (writers.find((p) => p.id === editing) ?? null) : null;
  const saved = (next: CustomProvidersResponse, info?: SavedInfo) => {
    setEditing(null);
    setPrefillUrl(undefined);
    setRetestId(info?.retestId ?? null);
    apply(next);
  };
  const edit = (id: string) => (url?: string) => {
    setPrefillUrl(url);
    setEditing(id);
  };

  return (
    <div className="space-y-3">
      <CustomHelp dataSent={data.dataSent} />
      {!data.canManage && <p className={mutedText}>Only the workspace owner can add, change, or remove custom providers.</p>}
      {state.error !== null && <ErrorState error={state.error} onRetry={state.reload} title="Could not refresh custom providers" />}

      {active && editing !== active.id && (
        <SavedProviderItem
          // One instance per provider: a test result, quick-URL or change-model state never carries over when
          // another provider becomes the active writer.
          key={active.id}
          workspaceId={workspaceId}
          p={active}
          canManage={data.canManage}
          apply={apply}
          reload={state.reload}
          onEdit={edit(active.id)}
          autoTest={retestId === active.id}
          onAutoTested={() => setRetestId(null)}
        />
      )}

      {formOpen && (
        <CustomProviderForm
          key={editing ?? "new"}
          workspaceId={workspaceId}
          initial={editingProvider}
          initialBaseUrl={editingProvider ? prefillUrl : undefined}
          onSaved={saved}
          onCancel={
            writers.length > 0
              ? () => {
                  setEditing(null);
                  setPrefillUrl(undefined);
                }
              : undefined
          }
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
                  <SavedProviderItem
                    workspaceId={workspaceId}
                    p={p}
                    canManage={data.canManage}
                    apply={apply}
                    reload={state.reload}
                    onEdit={edit(p.id)}
                    autoTest={retestId === p.id}
                    onAutoTested={() => setRetestId(null)}
                  />
                </li>
              ))}
          </ul>
        </div>
      )}

      {data.canManage && !formOpen && (
        <div>
          {writers.length < data.maxProviders ? (
            <Button size="sm" onClick={() => setEditing("new")}>
              {writers.length === 0 ? "Add a custom provider" : "Add another custom provider"}
            </Button>
          ) : (
            <p className={mutedText}>This workspace has the maximum of {data.maxProviders} custom providers; remove one to add another.</p>
          )}
        </div>
      )}
    </div>
  );
}

/** One saved provider: details, Test, Change model, Quick update URL, Edit, Use as writer, Remove. */
export function SavedProviderItem({
  workspaceId,
  p,
  canManage,
  apply,
  reload,
  onEdit,
  autoTest = false,
  onAutoTested,
}: {
  workspaceId: string;
  p: CustomProviderStatus;
  canManage: boolean;
  apply: (next: CustomProvidersResponse) => void;
  reload: () => void;
  /** Open the full edit form; `prefillUrl` is a base URL already typed in "Quick update URL". */
  onEdit: (prefillUrl?: string) => void;
  /** Run Test once when the card mounts (its URL or key was just changed in the full edit form). */
  autoTest?: boolean;
  onAutoTested?: () => void;
}) {
  const base = `${providersPath(workspaceId)}/${encodeURIComponent(p.id)}`;
  const test = useMutation(() => api<TestResult>(`${base}/test`, { method: "POST", body: {} }));
  const [quickUrl, setQuickUrl] = useState(false);
  const urlChange = latestUrlChange(p);
  /** Test the saved settings and refresh the card (records the outcome). */
  const retest = async () => {
    const r = await test.run();
    if (r) reload();
  };
  const runTest = test.run;
  const autoDone = useRef(false);
  const onAutoTestedRef = useRef(onAutoTested);
  onAutoTestedRef.current = onAutoTested;
  useEffect(() => {
    // Once per mount (the ref also keeps React StrictMode's double effect from calling the provider twice).
    if (!autoTest || autoDone.current) return;
    autoDone.current = true;
    void (async () => {
      const r = await runTest();
      onAutoTestedRef.current?.();
      if (r) reload();
    })();
  }, [autoTest, runTest, reload]);
  const del = useMutation(() => api<CustomProvidersResponse>(base, { method: "DELETE" }));
  const use = useMutation(() =>
    api<CustomProvidersResponse>(`/workspaces/${encodeURIComponent(workspaceId)}/writer-source`, { method: "PUT", body: { source: `custom:${p.id}` satisfies WriterSource } }),
  );
  const useChat = useMutation(() =>
    api<CustomProvidersResponse>(`/workspaces/${encodeURIComponent(workspaceId)}/chat-model-source`, { method: "PUT", body: { source: `custom:${p.id}` satisfies ChatModelSource } }),
  );
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [changingModel, setChangingModel] = useState(false);
  const isGeo = p.role === "geo";
  const isChatRole = p.role === "chat";
  const active = p.isWriter || p.isChat === true;

  return (
    <div className={cx("rounded-lg border p-3", active ? "border-emerald-300 dark:border-emerald-800" : "border-zinc-200 dark:border-zinc-800")}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="break-words text-sm font-semibold">
            {p.label}
            {p.isWriter && <span className="ml-2 text-xs font-medium text-emerald-800 dark:text-emerald-300">Active writer</span>}
            {p.isChat === true && <span className="ml-2 text-xs font-medium text-emerald-800 dark:text-emerald-300">Ask Okara model</span>}
            {isGeo && <span className="ml-2 text-xs font-medium text-amber-800 dark:text-amber-300">{CUSTOM_GEO_NOTE}</span>}
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
            {urlChange && (
              <div className="flex flex-wrap gap-x-2">
                <dt className="text-zinc-600 dark:text-zinc-400">URL changed</dt>
                <dd className="min-w-0 break-all">
                  {formatDateTime(urlChange.at)} · {urlChangeSummary(urlChange)}
                </dd>
              </div>
            )}
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
            test.reset();
            apply(next);
          }}
          onCancel={() => setChangingModel(false)}
        />
      ) : quickUrl && canManage ? (
        <QuickUrlUpdate
          workspaceId={workspaceId}
          p={p}
          onSaved={(next) => {
            setQuickUrl(false);
            apply(next);
            void retest(); // check the new URL right away (and whether the saved model is still listed)
          }}
          onCancel={() => setQuickUrl(false)}
          onUseNewKey={(url) => {
            setQuickUrl(false);
            onEdit(url);
          }}
        />
      ) : (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <Button size="sm" loading={test.loading} onClick={() => void retest()}>
            Test
          </Button>
          {canManage && (
            <>
              {isChatRole && p.isChat !== true && (
                <Button
                  size="sm"
                  variant="primary"
                  loading={useChat.loading}
                  onClick={async () => {
                    const next = await useChat.run();
                    if (next) apply(next);
                  }}
                >
                  Use for Ask Okara
                </Button>
              )}
              {!p.isWriter && !isGeo && !isChatRole && (
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
              <Button size="sm" variant="ghost" onClick={() => setQuickUrl(true)}>
                Quick update URL
              </Button>
              <Button size="sm" variant="ghost" onClick={() => onEdit()}>
                Edit URL or key
              </Button>
              {!confirmDelete ? (
                <Button size="sm" variant="ghost" onClick={() => setConfirmDelete(true)}>
                  Remove
                </Button>
              ) : (
                <span className="flex flex-wrap items-center gap-1">
                  <span className="text-xs">
                    {p.isWriter
                      ? "Remove it? The writer switches back to the default."
                      : p.isChat === true
                        ? "Remove it? Ask Okara switches back to the writer model."
                        : isGeo
                        ? "Remove this GEO engine? Its earlier answers stay in your results."
                        : "Remove it?"}
                  </span>
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
        {test.loading && <span className={cx("block", mutedText)}>Testing {p.host}…</span>}
        {test.data && <span className={test.data.ok === true ? "text-emerald-800 dark:text-emerald-300" : test.data.ok === null ? "text-amber-800 dark:text-amber-300" : errorText}>{testOutcomeText(test.data.ok, test.data.detail)}</span>}
        {canManage && !changingModel && modelNotListed(test.data) && (
          <span role="status" className="mt-2 flex flex-wrap items-center gap-2 rounded-lg border border-amber-300 bg-amber-50 px-2 py-1.5 text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-200">
            <span className="min-w-0">
              The saved model <span className="break-all font-mono">{p.model}</span> is not in the model list of <span className="break-all font-mono">{p.host}</span>.
            </span>
            <Button size="sm" onClick={() => setChangingModel(true)}>
              Change model
            </Button>
          </span>
        )}
        {[test.error, del.error, use.error, useChat.error].map((e, i) =>
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

/**
 * Required confirmation shown when a typed base URL is on a new host and no new key is typed: the saved key is
 * sent to that host only when this box is ticked (unchecked by default).
 */
export function SendSavedKeyConfirm({ id, host, keyHint, checked, onChange }: { id: string; host: string; keyHint: string; checked: boolean; onChange: (checked: boolean) => void }) {
  return (
    <div className="rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-200">
      <label htmlFor={id} className="flex min-h-8 items-start gap-2 text-sm font-medium">
        <input
          id={id}
          type="checkbox"
          required
          className="mt-0.5 h-4 w-4 shrink-0 accent-amber-700"
          checked={checked}
          onChange={(e) => onChange(e.target.checked)}
          aria-describedby={`${id}-note`}
        />
        <span className="min-w-0 break-all">{sendSavedKeyLabel(host)}</span>
      </label>
      <p id={`${id}-note`} className="mt-1 text-xs">
        This base URL is on a different host. Your saved key (…{keyHint}) is sent there only if you tick this box; otherwise enter a new API key.
      </p>
      <p className="mt-1 text-xs">{TUNNEL_NAME_NOTE}</p>
    </div>
  );
}

/**
 * "Quick update URL": only the base URL (for example a new tunnel address), the saved-key confirmation when
 * the host changes, and Save. The key, model and name stay as they are.
 */
export function QuickUrlUpdate({
  workspaceId,
  p,
  initialUrl,
  onSaved,
  onCancel,
  onUseNewKey,
}: {
  workspaceId: string;
  p: CustomProviderStatus;
  /** Prefilled URL (default: the saved base URL). */
  initialUrl?: string;
  onSaved: (next: CustomProvidersResponse) => void;
  onCancel: () => void;
  /** Open the full edit form with the typed URL to enter a new key instead. */
  onUseNewKey?: (typedUrl: string) => void;
}) {
  const id = useId();
  const [url, setUrl] = useState(initialUrl ?? p.baseUrl);
  const [confirmedHost, setConfirmedHost] = useState<string | null>(null);
  const [clientError, setClientError] = useState<string | null>(null);
  const save = useMutation((body: CustomProviderPatchInput) =>
    api<CustomProvidersResponse>(`${providersPath(workspaceId)}/${encodeURIComponent(p.id)}`, { method: "PATCH", body }),
  );
  const gate = hostChangeGate({ savedHost: p.host, typedBaseUrl: url, typedKey: "", confirmedHost });
  const unchanged = !url.trim() || url.trim() === p.baseUrl;

  return (
    <form
      noValidate
      aria-label={`Quick update the base URL of ${p.label}`}
      className="mt-3 space-y-2 border-t border-zinc-100 pt-3 dark:border-zinc-800"
      onSubmit={async (e) => {
        e.preventDefault();
        const problem = baseUrlInputError(url);
        setClientError(problem);
        if (problem || unchanged || !gate.canSave) return;
        const next = await save.run(quickUrlPatchBody(p, url, confirmedHost));
        if (next) onSaved(next);
      }}
    >
      <div className="sm:max-w-xl">
        <TextField
          id={`${id}-url`}
          label="New base URL"
          type="url"
          inputMode="url"
          autoComplete="off"
          spellCheck={false}
          required
          value={url}
          onChange={(e) => {
            setUrl(e.target.value);
            setClientError(null);
            save.reset();
          }}
          placeholder="https://your-tunnel.trycloudflare.com/v1"
          hint="Paste the new address, e.g. a new tunnel URL. The key, model and name stay as they are; Test runs right after saving."
          error={clientError ?? fieldErrorFor(save.error, "baseUrl") ?? fieldErrorFor(save.error, "apiKey")}
        />
      </div>
      {gate.needsConfirm && gate.newHost && (
        <SendSavedKeyConfirm id={`${id}-keep`} host={gate.newHost} keyHint={p.keyHint} checked={gate.confirmed} onChange={(v) => setConfirmedHost(v ? gate.newHost : null)} />
      )}
      <div className="flex flex-wrap items-center gap-2">
        <Button type="submit" size="sm" variant="primary" loading={save.loading} disabled={unchanged || !gate.canSave}>
          Save URL
        </Button>
        <Button size="sm" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
        {gate.needsConfirm && onUseNewKey && (
          <Button size="sm" variant="ghost" onClick={() => onUseNewKey(url.trim())}>
            Enter a new key instead
          </Button>
        )}
      </div>
      {gate.blockedReason && <p className={mutedText}>{gate.blockedReason}</p>}
      {save.error !== null && !isFieldError(save.error, ["baseUrl", "apiKey"]) && (
        <p role="alert" className={cx("text-xs", errorText)}>
          {errorMessage(save.error)}
        </p>
      )}
    </form>
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
      {p.role === "geo" && <p className={mutedText}>Changing the model starts a new trend series for this engine (results are compared within one model only).</p>}
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
  initialBaseUrl,
  onSaved,
  onCancel,
  role = "writer",
}: {
  workspaceId: string;
  initial: CustomProviderStatus | null;
  /** Edit form only: start with this base URL typed (handed over from "Quick update URL"). */
  initialBaseUrl?: string;
  onSaved: (next: CustomProvidersResponse, info?: SavedInfo) => void;
  onCancel?: () => void;
  /** "geo": add a custom GEO engine lane (never the writer); "chat": Ask Okara's own chat model. */
  role?: CustomProviderRole;
}) {
  const id = useId();
  const path = providersPath(workspaceId);
  const [label, setLabel] = useState(initial?.label ?? "");
  const [baseUrl, setBaseUrl] = useState((initial && initialBaseUrl) || initial?.baseUrl || "");
  /** The new host the owner agreed to send the saved key to ("Send my saved key to <host>"). */
  const [confirmedHost, setConfirmedHost] = useState<string | null>(null);
  const [apiKey, setApiKey] = useState("");
  const [model, setModel] = useState(initial?.model ?? "");
  const [clientError, setClientError] = useState<{ field: "baseUrl" | "apiKey" | "model"; message: string } | null>(null);
  const fetchModels = useMutation((body: { baseUrl: string; apiKey: string } | { providerId: string }) =>
    api<CustomProviderModelList>(`${path}/models`, { method: "POST", body }),
  );
  const save = useMutation((body: CustomProviderPatchInput | CustomProviderInput) =>
    initial
      ? api<CustomProvidersResponse>(`${path}/${encodeURIComponent(initial.id)}`, { method: "PATCH", body })
      : api<CustomProvidersResponse>(path, { method: "POST", body }),
  );
  const sameUrl = initial !== null && baseUrl.trim() === initial.baseUrl;
  // Editing: a new key is optional; a URL on a new host needs a new key or the ticked confirmation.
  const gate = hostChangeGate({ savedHost: initial?.host ?? null, typedBaseUrl: baseUrl, typedKey: apiKey, confirmedHost });
  const keyNeeded = !initial;
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
    else if (initial && gate.newHost)
      setClientError({
        field: "apiKey",
        message: `Enter a new key to fetch models now, or tick "${sendSavedKeyLabel(gate.newHost)}" and save: the model list is checked right after saving.`,
      });
    else if (initial) setClientError({ field: "apiKey", message: "Save the new URL first (Test runs right after saving), or enter the key to fetch models now." });
    else setClientError({ field: "apiKey", message: "Enter the API key to fetch the provider's models." });
  };

  return (
    <form
      noValidate
      className="space-y-3 rounded-lg border border-zinc-200 p-3 dark:border-zinc-800"
      aria-label={initial ? `Edit ${initial.label}` : role === "geo" ? "Add a custom GEO engine" : role === "chat" ? "Add an Ask Okara chat model" : "Add a custom provider"}
      onSubmit={async (e) => {
        e.preventDefault();
        setClientError(null);
        const urlError = baseUrlInputError(baseUrl);
        if (urlError) return setClientError({ field: "baseUrl", message: urlError });
        if (keyNeeded && !apiKey.trim()) return setClientError({ field: "apiKey", message: "Enter the API key." });
        if (!gate.canSave) return setClientError({ field: "apiKey", message: gate.blockedReason ?? "Enter the API key." });
        if (!model.trim()) return setClientError({ field: "model", message: "Choose a model, or type a model id." });
        const next = await save.run(
          initial ? editPatchBody({ initial, baseUrl, apiKey, model, label, confirmedHost }) : newProviderBody({ role, baseUrl, apiKey, model, label }),
        );
        if (next) {
          // Re-run Test when the URL or the key changed (and offer "Change model" if the model is not listed).
          const retestId = retestIdAfterSave(initial, baseUrl, apiKey);
          setApiKey("");
          onSaved(next, { retestId });
        }
      }}
    >
      <p className="text-sm font-medium">
        {initial ? `Edit ${initial.label}` : role === "geo" ? "Custom GEO engine (OpenAI-compatible)" : role === "chat" ? "Custom chat model (OpenAI-compatible)" : "Custom provider (OpenAI-compatible)"}
      </p>
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
          placeholder={initial ? (gate.newHost ? `New key for ${gate.newHost}` : `Keep …${initial.keyHint}`) : "Paste key"}
          hint={
            initial && gate.newHost
              ? "New host: enter a new key, or leave this empty and tick the box below to send the saved key there."
              : initial
                ? "Leave empty to keep the saved key."
                : "Stored encrypted; never shown again."
          }
          error={err("apiKey")}
        />
      </div>
      {gate.needsConfirm && gate.newHost && initial && (
        <SendSavedKeyConfirm id={`${id}-keep`} host={gate.newHost} keyHint={initial.keyHint} checked={gate.confirmed} onChange={(v) => setConfirmedHost(v ? gate.newHost : null)} />
      )}
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
        <Button type="submit" variant="primary" loading={save.loading} disabled={!gate.canSave}>
          {initial ? "Save changes" : role === "geo" ? "Save custom GEO engine" : role === "chat" ? "Save & test" : "Save and use as writer"}
        </Button>
        {onCancel && (
          <Button variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
        )}
      </div>
      {gate.blockedReason && <p className={mutedText}>{gate.blockedReason}</p>}
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
  manualPlaceholder = "provider/model-name",
}: {
  id: string;
  /** A custom provider's list (ids), or a built-in provider's list (id + display label). */
  list: CustomProviderModelList | { models: ProviderModelOption[]; total: number; truncated: boolean } | null;
  value: string;
  onChange: (v: string) => void;
  error?: string | null;
  manualPlaceholder?: string;
}) {
  const models: ProviderModelOption[] = (list?.models ?? []).map((m) => (typeof m === "string" ? toOptions([m])[0]! : m));
  const [manual, setManual] = useState(false);
  const [query, setQuery] = useState("");
  if (models.length > 0 && !manual) {
    const { shown, matched } = filterModelOptions(models, query);
    const options = value && !shown.some((o) => o.id === value) ? [{ id: value, label: value }, ...shown] : shown;
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
              <option key={m.id} value={m.id}>
                {m.label}
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
        placeholder={manualPlaceholder}
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
