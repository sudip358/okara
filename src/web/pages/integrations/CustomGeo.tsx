/**
 * "Custom GEO engines" in the AI engines section of the Integrations page: add an OpenAI-compatible provider
 * (base URL + API key + Fetch models + model picker, the same form as the custom writer) as an extra GEO
 * lane. The prompt is sent without tools; an answer counts toward citation rate only when the provider's
 * response returns web sources (e.g. an OpenRouter model with web search, a Perplexity-compatible API),
 * otherwise mention rate only. Lanes are labelled "Custom · citations count only when the provider returns
 * sources" everywhere. Keys are write-only. Untrusted names and model ids render as plain text. Base URL
 * changes (tunnels) work as for the custom writer: "Quick update URL" or "Edit URL or key", with the required
 * "Send my saved key to <new host>" confirmation, then an automatic Test (CustomWriter.tsx).
 * OWNED BY: web-shell.
 */
import { useId, useState } from "react";
import type { CustomProvidersResponse } from "@shared/types";
import { useApi } from "@web/lib/hooks";
import { Button, ErrorState, LoadingState } from "@web/components/ui";
import { CustomProviderForm, SavedProviderItem, providersPath, type SavedInfo } from "./CustomWriter";
import { CUSTOM_GEO_NOTE, geoEngines } from "./model-lib";

const mutedText = "text-xs text-zinc-600 dark:text-zinc-400";
export const DEFAULT_MAX_GEO_ENGINES = 2;

export function CustomGeoEngines({ workspaceId, onChange }: { workspaceId: string; onChange?: () => void }) {
  const id = useId();
  const list = useApi<CustomProvidersResponse>(providersPath(workspaceId));
  /** null: no form; "new": add form; otherwise the id being edited. */
  const [editing, setEditing] = useState<string | null>(null);
  /** A base URL typed in "Quick update URL" and handed to the full form ("Enter a new key instead"). */
  const [prefillUrl, setPrefillUrl] = useState<string | undefined>(undefined);
  /** Engine whose Test re-runs once its card is back (after its URL or key changed). */
  const [retestId, setRetestId] = useState<string | null>(null);
  const data = list.data;
  const engines = geoEngines(data);
  const max = data?.maxGeoEngines ?? DEFAULT_MAX_GEO_ENGINES;
  const apply = (next: CustomProvidersResponse, info?: SavedInfo) => {
    list.setData(next);
    setEditing(null);
    setPrefillUrl(undefined);
    if (info) setRetestId(info.retestId);
    onChange?.();
  };

  return (
    <section aria-labelledby={`${id}-title`} className="rounded-lg border border-dashed border-zinc-300 p-3 dark:border-zinc-700">
      <h4 id={`${id}-title`} className="text-sm font-semibold">
        Custom GEO engines
      </h4>
      <div className="mt-1 space-y-1 rounded bg-zinc-50 px-2 py-1.5 text-xs text-zinc-700 dark:bg-zinc-950 dark:text-zinc-300">
        <p>
          Add any OpenAI-compatible API (for example OpenRouter, Groq, Together, DeepSeek, Mistral, or your own gateway) as an extra AI engine lane: enter its base
          URL and API key, fetch its models, pick one, and save. At most {max} per workspace.
        </p>
        <p>
          <span className="font-medium">{CUSTOM_GEO_NOTE}.</span> The prompt is sent to /chat/completions with no tools. To get a citation rate, pick a model or
          provider that searches the web and returns its sources (for example an OpenRouter model with web search, such as a &quot;:online&quot; model, or a
          Perplexity-compatible API): answers that return sources count toward citation rate (provider-reported sources). Answers without sources count toward
          mention rate only. Costs are recorded as unknown.
        </p>
        {data?.geoDataSent && (
          <p>
            <span className="font-medium">Data sent:</span> {data.geoDataSent}
          </p>
        )}
        <p>Each model is its own trend series: changing the model starts a new series.</p>
      </div>

      <div className="mt-3 space-y-2">
        {list.loading && !data ? (
          <LoadingState />
        ) : !data ? (
          <ErrorState error={list.error} onRetry={list.reload} />
        ) : (
          <>
            {!data.canManage && <p className={mutedText}>Only the workspace owner can add, change, or remove custom GEO engines.</p>}
            {engines.length === 0 && editing === null && <p className={mutedText}>No custom GEO engine yet.</p>}
            <ul className="space-y-2">
              {engines
                .filter((p) => p.id !== editing)
                .map((p) => (
                  <li key={p.id}>
                    <SavedProviderItem
                      workspaceId={workspaceId}
                      p={p}
                      canManage={data.canManage}
                      apply={(next) => apply(next)}
                      reload={list.reload}
                      onEdit={(url) => {
                        setPrefillUrl(url);
                        setEditing(p.id);
                      }}
                      autoTest={retestId === p.id}
                      onAutoTested={() => setRetestId(null)}
                    />
                  </li>
                ))}
            </ul>
            {data.canManage && editing !== null && (
              <CustomProviderForm
                key={editing}
                workspaceId={workspaceId}
                role="geo"
                initial={editing === "new" ? null : (engines.find((p) => p.id === editing) ?? null)}
                initialBaseUrl={editing === "new" ? undefined : prefillUrl}
                onSaved={apply}
                onCancel={() => {
                  setEditing(null);
                  setPrefillUrl(undefined);
                }}
              />
            )}
            {data.canManage &&
              editing === null &&
              (engines.length < max ? (
                <Button size="sm" onClick={() => setEditing("new")}>
                  Add custom GEO engine
                </Button>
              ) : (
                <p className={mutedText}>This workspace has the maximum of {max} custom GEO engines; remove one to add another.</p>
              ))}
          </>
        )}
      </div>
    </section>
  );
}
