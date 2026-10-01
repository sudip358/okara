/**
 * "Model" row on a built-in provider card (Gemini, Perplexity, OpenAI, Anthropic, TypeSafe): shows the model
 * the runtime uses and where it comes from, and lets the owner choose one for this workspace: "Fetch models"
 * (listed server-side with the typed key, else the saved workspace key, else the operator key), a searchable
 * dropdown, a typed-id fallback, and Save. Model ids and names are untrusted plain text. OWNED BY: web-shell.
 */
import { useId, useState } from "react";
import type { IntegrationsStatus, ModelSelectableProviderId, ProviderModelList } from "@shared/types";
import { api, errorMessage } from "@web/lib/api";
import { useMutation } from "@web/lib/hooks";
import { Button, cx } from "@web/components/ui";
import { fieldErrorFor, isFieldError } from "./custom-writer-lib";
import { ModelPicker } from "./CustomWriter";
import {
  COHORT_NOTE,
  GEO_ENGINE_PROVIDERS,
  MUST_SUPPORT_TEXT,
  hasWorkspaceSelection,
  modelInputError,
  modelSourceText,
  mustSupportNote,
  operatorKeyHint,
  rateNote,
} from "./model-lib";

type ProviderStatus = IntegrationsStatus["providers"][number];

const errorText = "text-red-700 dark:text-red-400";
const mutedText = "text-xs text-zinc-600 dark:text-zinc-400";

const KEY_SOURCE_TEXT: Record<NonNullable<ProviderModelList["keySource"]>, string> = {
  typed_key: "the typed key",
  workspace_key: "the saved workspace key",
  operator_key: "the operator key",
};

export function ProviderModelRow({
  workspaceId,
  p,
  typedKey,
  onChange,
}: {
  workspaceId: string;
  p: ProviderStatus & { provider: ModelSelectableProviderId };
  /** The key typed in the card's key field (not saved); used for Fetch models when present. */
  typedKey?: string;
  onChange: (next: ProviderStatus) => void;
}) {
  const id = useId();
  const base = `/workspaces/${encodeURIComponent(workspaceId)}/credentials/${encodeURIComponent(p.provider)}`;
  const [editing, setEditing] = useState(false);
  const [model, setModel] = useState(p.model ?? "");
  const [clientError, setClientError] = useState<string | null>(null);
  const fetchModels = useMutation((apiKey?: string) => api<ProviderModelList>(`${base}/models`, { method: "POST", body: apiKey ? { apiKey } : {} }));
  const save = useMutation((value: string | null) => api<ProviderStatus>(`${base}/model`, { method: "PUT", body: { model: value } }));
  const isEngine = GEO_ENGINE_PROVIDERS.includes(p.provider);
  const must = mustSupportNote(fetchModels.data?.mustSupport ?? MUST_SUPPORT_TEXT[p.provider]);
  const rate = rateNote(p);
  const operatorHint = operatorKeyHint(p);
  const typed = typedKey?.trim() ?? "";
  const canFetch = typed.length > 0 || p.source !== "none";

  const done = (next: ProviderStatus | undefined) => {
    if (!next) return;
    setEditing(false);
    fetchModels.reset();
    setModel(next.model ?? "");
    onChange(next);
  };

  return (
    <div className="mt-3 border-t border-zinc-100 pt-3 dark:border-zinc-800">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <dl className="min-w-0 text-xs">
          <div className="flex flex-wrap gap-x-2">
            <dt className="font-medium text-zinc-800 dark:text-zinc-200">Model</dt>
            <dd className="min-w-0 break-all">
              {p.model ? (
                <>
                  <span className="font-mono">{p.model}</span> <span className="text-zinc-600 dark:text-zinc-400">({modelSourceText(p.modelSource)})</span>
                </>
              ) : (
                <span className="text-amber-800 dark:text-amber-300">No model chosen: choose one to use this provider.</span>
              )}
            </dd>
          </div>
        </dl>
        {!editing && (
          <div className="flex flex-wrap gap-2">
            <Button size="sm" onClick={() => setEditing(true)}>
              {p.model ? "Change model" : "Choose a model"}
            </Button>
            {hasWorkspaceSelection(p) && (
              <Button size="sm" variant="ghost" loading={save.loading} onClick={async () => done(await save.run(null))}>
                Use operator default
              </Button>
            )}
          </div>
        )}
      </div>
      {p.modelNote && <p className="mt-1 text-xs text-amber-800 dark:text-amber-300">{p.modelNote}</p>}
      {rate && <p className="mt-1 text-xs text-amber-800 dark:text-amber-300">{rate}</p>}
      {isEngine && <p className={cx("mt-1", mutedText)}>{COHORT_NOTE}</p>}

      {editing && (
        <form
          noValidate
          className="mt-2 space-y-2"
          aria-label={`Choose the ${p.label} model`}
          onSubmit={async (e) => {
            e.preventDefault();
            const problem = modelInputError(model);
            setClientError(problem);
            if (problem) return;
            done(await save.run(model.trim()));
          }}
        >
          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm" loading={fetchModels.loading} disabled={!canFetch} onClick={() => void fetchModels.run(typed || undefined)}>
              Fetch models
            </Button>
            {!canFetch && <span className={mutedText}>Save or type a key to fetch the model list, or type a model id below.</span>}
            {fetchModels.loading && <span className={mutedText}>Asking the provider for its model list…</span>}
          </div>
          <div aria-live="polite" className="text-xs">
            {fetchModels.data && (
              <span
                role={fetchModels.data.ok === false ? "alert" : undefined}
                className={fetchModels.data.ok === true ? "text-emerald-800 dark:text-emerald-300" : fetchModels.data.ok === null ? "text-amber-800 dark:text-amber-300" : errorText}
              >
                {fetchModels.data.detail}
                {fetchModels.data.keySource && ` Listed with ${KEY_SOURCE_TEXT[fetchModels.data.keySource]}.`}
              </span>
            )}
            {fetchModels.error !== null && <span className={cx("block", errorText)}>{errorMessage(fetchModels.error)}</span>}
          </div>
          <ModelPicker
            id={id}
            list={fetchModels.data}
            value={model}
            onChange={setModel}
            error={clientError ?? fieldErrorFor(save.error, "model")}
            manualPlaceholder={p.provider === "perplexity" ? "provider/model-name" : "model-id"}
          />
          {must && <p className={mutedText}>{must}</p>}
          {operatorHint && <p className={mutedText}>{operatorHint}</p>}
          <div className="flex flex-wrap gap-2">
            <Button type="submit" size="sm" variant="primary" loading={save.loading} disabled={!model.trim() || (model.trim() === p.model && p.modelSource === "workspace")}>
              Save model
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                setEditing(false);
                setClientError(null);
                setModel(p.model ?? "");
              }}
            >
              Cancel
            </Button>
          </div>
        </form>
      )}
      {save.error !== null && !isFieldError(save.error, ["model"]) && <p className={cx("mt-1 text-xs", errorText)}>{errorMessage(save.error)}</p>}
    </div>
  );
}
