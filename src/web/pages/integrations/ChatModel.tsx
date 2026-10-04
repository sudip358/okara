/**
 * "Ask Okara chat model" card on the Integrations page [A36]: Ask Okara uses the workspace writer (default, as
 * before) or its own custom OpenAI-compatible chat model (role "chat": base URL + API key + Fetch models + model
 * picker, Save & test; Test, Change model, Quick update URL, Edit URL or key, Remove), independent of the writer
 * that drafts content. The chat model must support tool calling (function tools); a model that ignores tools gets
 * the tools described in the prompt instead (text-tools fallback). Keys are write-only; names and model ids are
 * untrusted plain text. The chat panel header links here (#ask-okara-model). OWNED BY: web-shell.
 */
import { useEffect, useId, useRef, useState } from "react";
import { useLocation } from "react-router";
import type { ChatModelSource, CustomProvidersResponse, IntegrationsStatus } from "@shared/types";
import { api, errorMessage } from "@web/lib/api";
import { useApi, useMutation } from "@web/lib/hooks";
import { Button, ErrorState, LoadingState, StateBadge, cx } from "@web/components/ui";
import { CustomProviderForm, SavedProviderItem, providersPath, type SavedInfo } from "./CustomWriter";
import { activeChatProvider, CHAT_MODEL_ANCHOR, chatProviders, writerModelLabel } from "./custom-writer-lib";

type ProviderStatus = IntegrationsStatus["providers"][number];

const mutedText = "text-xs text-zinc-600 dark:text-zinc-400";
export const DEFAULT_MAX_CHAT_PROVIDERS = 3;
export const TOOL_CALLING_HINT =
  "Ask Okara needs a model that supports tool calling (OpenAI-style function tools), for example most current GPT, Claude, Gemini, Llama 3.1+, Qwen or DeepSeek chat models. A model without tool calling can answer, but cannot look up your data.";

export function ChatModelCard({ workspaceId, writer }: { workspaceId: string; writer: ProviderStatus | null }) {
  const id = useId();
  const location = useLocation();
  const sectionRef = useRef<HTMLElement>(null);
  const list = useApi<CustomProvidersResponse>(providersPath(workspaceId));
  const data = list.data;
  const active = activeChatProvider(data);
  const providers = chatProviders(data);
  const [choice, setChoice] = useState<"writer" | "custom" | null>(null);
  const shown = choice ?? (active ? "custom" : "writer");
  /** null: no form; "new": add form; otherwise the id being edited. */
  const [editing, setEditing] = useState<string | null>(null);
  const [prefillUrl, setPrefillUrl] = useState<string | undefined>(undefined);
  /** Provider whose Test runs once its card is back (after it was added, or its URL or key changed). */
  const [retestId, setRetestId] = useState<string | null>(null);
  const max = data?.maxChatProviders ?? DEFAULT_MAX_CHAT_PROVIDERS;
  const writerModel = writerModelLabel(data, writer?.model ?? null);
  const useWriter = useMutation(() =>
    api<CustomProvidersResponse>(`/workspaces/${encodeURIComponent(workspaceId)}/chat-model-source`, { method: "PUT", body: { source: "writer" satisfies ChatModelSource } }),
  );

  // The chat panel links to #ask-okara-model: bring the card into view.
  useEffect(() => {
    if (location.hash === `#${CHAT_MODEL_ANCHOR}`) sectionRef.current?.scrollIntoView?.({ block: "start", behavior: "smooth" });
  }, [location.hash]);

  const apply = (next: CustomProvidersResponse, info?: SavedInfo) => {
    const wasNew = editing === "new";
    list.setData(next);
    setEditing(null);
    setPrefillUrl(undefined);
    // Save & test: a new chat model is tested right away; an edit re-tests when its URL or key changed.
    setRetestId(wasNew ? (activeChatProvider(next)?.id ?? null) : (info?.retestId ?? null));
  };
  const formOpen = data?.canManage === true && (editing !== null || providers.length === 0);
  const editingProvider = editing && editing !== "new" ? (providers.find((p) => p.id === editing) ?? null) : null;
  const ordered = [...providers].sort((a, b) => Number(b.isChat === true) - Number(a.isChat === true));

  return (
    <section
      id={CHAT_MODEL_ANCHOR}
      ref={sectionRef}
      aria-labelledby={`${id}-title`}
      className="scroll-mt-20 rounded-lg border border-zinc-200 p-3 dark:border-zinc-800"
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <h3 id={`${id}-title`} className="text-sm font-semibold">
            Ask Okara chat model
          </h3>
          <p className={mutedText}>
            In use:{" "}
            {list.loading && !data ? (
              "loading…"
            ) : active ? (
              <>
                Custom chat model · <span className="break-all font-mono">{active.host}</span> · model <span className="break-all font-mono">{active.model}</span>
              </>
            ) : (
              <>
                Same as writer{writerModel && (
                  <>
                    {" "}
                    · model <span className="break-all font-mono">{writerModel}</span>
                  </>
                )}
              </>
            )}
          </p>
        </div>
        {active ? <StateBadge state={active.lastTestOk === false ? "error" : "ready"} /> : writer ? <StateBadge state={writer.state} /> : null}
      </div>

      <fieldset className="mt-3">
        <legend className="text-sm font-medium text-zinc-800 dark:text-zinc-200">Model for the chat</legend>
        <div className="mt-1 flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:gap-x-5">
          <label className="flex min-h-8 items-center gap-2 text-sm">
            <input type="radio" name={`${id}-source`} value="writer" checked={shown === "writer"} onChange={() => setChoice("writer")} />
            <span className="min-w-0 break-words">
              Same as writer{writerModel ? <> (current: <span className="break-all font-mono">{writerModel}</span>)</> : null}
            </span>
          </label>
          <label className="flex min-h-8 items-center gap-2 text-sm">
            <input type="radio" name={`${id}-source`} value="custom" checked={shown === "custom"} onChange={() => setChoice("custom")} />
            Custom chat model
          </label>
        </div>
      </fieldset>
      <p className={cx("mt-2", mutedText)}>{TOOL_CALLING_HINT}</p>

      <div className="mt-3 space-y-3">
        {list.loading && !data ? (
          <LoadingState />
        ) : !data ? (
          <ErrorState error={list.error} onRetry={list.reload} />
        ) : shown === "writer" ? (
          <div className="space-y-2">
            {active ? (
              <div role="status" className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-sky-300 bg-sky-50 px-3 py-2 text-sm text-sky-900 dark:border-sky-800 dark:bg-sky-950 dark:text-sky-200">
                <span className="min-w-0">
                  Ask Okara uses its own chat model <span className="break-all font-mono">{active.host}</span>. Switch to use the writer model again (your chat models are kept).
                </span>
                {data.canManage && (
                  <Button
                    size="sm"
                    loading={useWriter.loading}
                    onClick={async () => {
                      const next = await useWriter.run();
                      if (next) {
                        list.setData(next);
                        setChoice(null);
                      }
                    }}
                  >
                    Use the writer model
                  </Button>
                )}
              </div>
            ) : (
              <p className={mutedText}>Ask Okara uses the writer above (change the writer to change the chat model, or choose a custom chat model).</p>
            )}
            {useWriter.error !== null && <p className="text-xs text-red-700 dark:text-red-400">{errorMessage(useWriter.error)}</p>}
          </div>
        ) : (
          <>
            <div className="space-y-1 rounded bg-zinc-50 px-2 py-1.5 text-xs text-zinc-700 dark:bg-zinc-950 dark:text-zinc-300">
              <p>
                Use any OpenAI-compatible API (for example OpenRouter, Groq, Together, DeepSeek, Mistral, or your own gateway) only for Ask Okara: enter its
                base URL and API key, fetch its models, pick one, and Save &amp; test. The writer keeps drafting content with its own model.
              </p>
              {data.chatDataSent && (
                <p>
                  <span className="font-medium">Data sent:</span> {data.chatDataSent}
                </p>
              )}
              <p>The key is stored encrypted on the server and never shown again (only its last 4 characters). Costs of custom provider calls are recorded as unknown.</p>
            </div>
            {!data.canManage && <p className={mutedText}>Only the workspace owner can add, change, select or remove Ask Okara chat models.</p>}
            {list.error !== null && <ErrorState error={list.error} onRetry={list.reload} title="Could not refresh custom providers" />}
            <ul className="space-y-2">
              {ordered
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
            {formOpen && (
              <CustomProviderForm
                key={editing ?? "new"}
                workspaceId={workspaceId}
                role="chat"
                initial={editingProvider}
                initialBaseUrl={editingProvider ? prefillUrl : undefined}
                onSaved={apply}
                onCancel={
                  providers.length > 0
                    ? () => {
                        setEditing(null);
                        setPrefillUrl(undefined);
                      }
                    : undefined
                }
              />
            )}
            {data.canManage &&
              !formOpen &&
              (providers.length < max ? (
                <Button size="sm" onClick={() => setEditing("new")}>
                  {providers.length === 0 ? "Add a chat model" : "Add another chat model"}
                </Button>
              ) : (
                <p className={mutedText}>This workspace has the maximum of {max} chat models; remove one to add another.</p>
              ))}
          </>
        )}
      </div>
    </section>
  );
}
