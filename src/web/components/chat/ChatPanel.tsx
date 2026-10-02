/**
 * Ask Okara: chat panel docked on the right of every project page (full-height; a full-screen sheet on
 * phones). The launcher sits in the project sidebar. Answers stream as ndjson (POST ...?stream=1): steps show
 * as collapsible groups ("Read data · 3 steps"); state-changing actions show a confirmation card and run only
 * when the user presses Confirm (enforced server-side). Model output renders as markdown-lite text, never HTML.
 */
import { useCallback, useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Link, useNavigate } from "react-router";
import type { ChatAction, ChatMessage, ChatSessionDetail, ChatSessionSummary, ChatStatus, ChatStep, ChatStreamEvent } from "@shared/types";
import { api, apiStream, errorMessage, isRateLimited } from "@web/lib/api";
import { formatRelative } from "@web/lib/format";
import { projectPath } from "@web/lib/project-context";
import { Badge, Spinner, buttonClass, cx } from "@web/components/ui";
import { groupSteps, mergeActions, mergeMessages, parseMarkdownLite, progressText, safeFilename, STARTER_PROMPTS, STEP_STATUS_LABEL, toCsv, upsertStep, type Block, type Inline } from "./lib";

const store = {
  get(key: string): string | null {
    try {
      return window.localStorage.getItem(key);
    } catch {
      return null;
    }
  },
  set(key: string, value: string | null) {
    try {
      if (value === null) window.localStorage.removeItem(key);
      else window.localStorage.setItem(key, value);
    } catch {
      // per-viewer convenience only
    }
  },
};
const openKey = "okara.chat.open";
const sessionKey = (projectId: string) => `okara.chat.session.${projectId}`;

// ------------------------------------------------------------------ markdown-lite rendering
function InlineText({ parts }: { parts: Inline[] }) {
  return (
    <>
      {parts.map((p, i) =>
        p.t === "text" ? (
          <span key={i}>{p.v}</span>
        ) : p.t === "bold" ? (
          <strong key={i} className="font-semibold">
            {p.v}
          </strong>
        ) : p.t === "code" ? (
          <code key={i} className="rounded bg-zinc-100 px-1 py-0.5 font-mono text-[0.85em] dark:bg-zinc-800">
            {p.v}
          </code>
        ) : p.internal ? (
          <Link key={i} to={p.href}>
            {p.text}
          </Link>
        ) : (
          <a key={i} href={p.href} target="_blank" rel="noopener noreferrer nofollow">
            {p.text}
          </a>
        ),
      )}
    </>
  );
}

export function MarkdownLite({ text, projectId }: { text: string; projectId: string }) {
  const blocks = useMemo<Block[]>(() => parseMarkdownLite(text, projectId), [text, projectId]);
  return (
    <div className="space-y-2 break-words text-sm leading-relaxed [overflow-wrap:anywhere]">
      {blocks.map((b, i) =>
        b.t === "p" ? (
          <p key={i}>
            {b.lines.map((l, j) => (
              <span key={j}>
                {j > 0 && <br />}
                <InlineText parts={l} />
              </span>
            ))}
          </p>
        ) : b.t === "h" ? (
          <p key={i} className="font-semibold">
            <InlineText parts={b.inline} />
          </p>
        ) : b.t === "ul" ? (
          <ul key={i} className="list-disc space-y-1 pl-5">
            {b.items.map((it, j) => (
              <li key={j}>
                <InlineText parts={it} />
              </li>
            ))}
          </ul>
        ) : (
          <ol key={i} start={b.start} className="list-decimal space-y-1 pl-5">
            {b.items.map((it, j) => (
              <li key={j}>
                <InlineText parts={it} />
              </li>
            ))}
          </ol>
        ),
      )}
    </div>
  );
}

// ------------------------------------------------------------------ steps, actions, outputs
function StepStatusDot({ status }: { status: ChatStep["status"] }) {
  const tone =
    status === "ok" || status === "executed" ? "bg-emerald-500" : status === "awaiting_confirmation" ? "bg-amber-500" : status === "cancelled" || status === "expired" ? "bg-zinc-400" : "bg-red-500";
  return <span aria-hidden="true" className={cx("mt-1.5 inline-block h-2 w-2 shrink-0 rounded-full", tone)} />;
}

function download(step: ChatStep) {
  const d = step.download;
  if (!d) return;
  const blob = new Blob(["﻿", toCsv(d.columns, d.rows)], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = safeFilename(d.filename);
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function StepGroups({ steps }: { steps: ChatStep[] }) {
  const groups = groupSteps(steps);
  if (!groups.length) return null;
  return (
    <div className="space-y-1.5">
      {groups.map((g, gi) => (
        <details key={gi} className="group rounded-lg border border-zinc-200 bg-zinc-50 text-xs dark:border-zinc-800 dark:bg-zinc-900/60">
          <summary className="flex cursor-pointer list-none items-center gap-2 px-2.5 py-1.5 font-medium text-zinc-700 focus-visible:outline-2 focus-visible:outline-sky-600 dark:text-zinc-300 [&::-webkit-details-marker]:hidden">
            <span aria-hidden="true" className="inline-block transition-transform group-open:rotate-90">
              ›
            </span>
            {g.label}
          </summary>
          <ol className="space-y-2 border-t border-zinc-200 px-2.5 py-2 dark:border-zinc-800">
            {g.steps.map((s) => (
              <li key={s.id} className="flex min-w-0 gap-2">
                <StepStatusDot status={s.status} />
                <div className="min-w-0 flex-1">
                  <p className="break-words font-mono text-[11px] text-zinc-900 [overflow-wrap:anywhere] dark:text-zinc-100">
                    {s.tool}
                    {s.args ? <span className="text-zinc-500 dark:text-zinc-400">({s.args})</span> : null}
                  </p>
                  <p className="break-words text-zinc-600 [overflow-wrap:anywhere] dark:text-zinc-400">
                    <span className="sr-only">{STEP_STATUS_LABEL[s.status]}: </span>
                    {s.result}
                  </p>
                </div>
              </li>
            ))}
          </ol>
        </details>
      ))}
    </div>
  );
}

function Outputs({ steps, onNavigate }: { steps: ChatStep[]; onNavigate: (path: string) => void }) {
  const items = steps.filter((s) => (s.navigate && (s.status === "ok" || s.status === "executed")) || (s.download && s.status === "ok"));
  if (!items.length) return null;
  return (
    <div className="flex flex-wrap gap-2">
      {items.map((s) =>
        s.download ? (
          <button key={`${s.id}-dl`} type="button" className={buttonClass("secondary", "sm")} onClick={() => download(s)}>
            Download CSV ({s.download.rows.length} row{s.download.rows.length === 1 ? "" : "s"}
            {s.download.truncated ? ", capped" : ""})
          </button>
        ) : s.navigate ? (
          <button key={`${s.id}-nav`} type="button" className={buttonClass("secondary", "sm")} onClick={() => onNavigate(s.navigate!.path)}>
            {s.navigate.label}
          </button>
        ) : null,
      )}
    </div>
  );
}

function ConfirmCard({ action, busy, onDecide }: { action: ChatAction; busy: boolean; onDecide: (id: string, d: "confirm" | "cancel") => void }) {
  const pending = action.status === "pending";
  return (
    <div
      role="group"
      aria-label="Action needs confirmation"
      className={cx("rounded-xl border p-3 text-sm", pending ? "border-amber-300 bg-amber-50 dark:border-amber-800 dark:bg-amber-950/40" : "border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900")}
    >
      <p className="font-semibold text-zinc-900 dark:text-zinc-50">{action.title}</p>
      {action.detail && <p className="mt-1 break-words text-xs text-zinc-700 [overflow-wrap:anywhere] dark:text-zinc-300">{action.detail}</p>}
      {pending ? (
        <div className="mt-2.5 flex gap-2">
          <button type="button" className={buttonClass("primary", "sm")} disabled={busy} onClick={() => onDecide(action.id, "confirm")}>
            Confirm
          </button>
          <button type="button" className={buttonClass("secondary", "sm")} disabled={busy} onClick={() => onDecide(action.id, "cancel")}>
            Cancel
          </button>
        </div>
      ) : (
        <p className="mt-1.5 text-xs text-zinc-600 dark:text-zinc-400" role="status">
          {action.status === "executed" ? "Confirmed and done" : action.status === "executing" ? "Running…" : action.status === "failed" ? "Failed" : action.status === "cancelled" ? "Cancelled" : "Not confirmed"}
          {action.result ? ` · ${action.result}` : ""}
        </p>
      )}
    </div>
  );
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className={buttonClass("ghost", "sm")}
      onClick={() => {
        void navigator.clipboard?.writeText(text).then(
          () => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          },
          () => setCopied(false),
        );
      }}
    >
      {copied ? "Copied" : "Copy"}
    </button>
  );
}

export function AssistantMessage({
  message,
  actions,
  projectId,
  busy,
  onDecide,
  onNavigate,
}: {
  message: ChatMessage;
  actions: ChatAction[];
  projectId: string;
  busy: boolean;
  onDecide: (id: string, d: "confirm" | "cancel") => void;
  onNavigate: (path: string) => void;
}) {
  const mine = actions.filter((a) => message.steps.some((s) => s.actionId === a.id));
  const running = message.status === "running";
  return (
    <div className="min-w-0 space-y-2">
      <StepGroups steps={message.steps} />
      {message.content ? <MarkdownLite text={message.content} projectId={projectId} /> : running ? null : message.status === "error" ? null : <p className="text-sm text-zinc-500">No answer.</p>}
      {mine.map((a) => (
        <ConfirmCard key={a.id} action={a} busy={busy} onDecide={onDecide} />
      ))}
      <Outputs steps={message.steps} onNavigate={onNavigate} />
      {running && (
        <p className="flex items-center gap-2 text-xs text-zinc-500 dark:text-zinc-400">
          <Spinner className="h-3.5 w-3.5" /> {progressText(message.steps)}
        </p>
      )}
      {message.status === "error" && (
        <p role="alert" className="rounded-lg border border-red-200 bg-red-50 px-2.5 py-1.5 text-xs text-red-800 dark:border-red-900 dark:bg-red-950/40 dark:text-red-200">
          {message.error ?? "Something went wrong while answering."}
        </p>
      )}
      {message.status === "stopped" && <p className="text-xs text-amber-800 dark:text-amber-300">Stopped early (tool-round or time limit).</p>}
      {!running && message.content && (
        <div className="flex items-center gap-2">
          <CopyButton text={message.content} />
          {message.model && <span className="truncate text-[11px] text-zinc-500 dark:text-zinc-400">{message.model.model}</span>}
        </div>
      )}
    </div>
  );
}

// ------------------------------------------------------------------ panel state
interface ChatState {
  sessionId: string | null;
  messages: ChatMessage[];
  actions: ChatAction[];
}
const EMPTY: ChatState = { sessionId: null, messages: [], actions: [] };

function useChat(projectId: string, enabled: boolean) {
  const [status, setStatus] = useState<ChatStatus | null>(null);
  const [statusError, setStatusError] = useState<unknown>(null);
  const [state, setState] = useState<ChatState>(EMPTY);
  const [sessions, setSessions] = useState<ChatSessionSummary[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loadingSession, setLoadingSession] = useState(false);
  const ctrl = useRef<AbortController | null>(null);

  const loadStatus = useCallback(() => {
    setStatusError(null);
    api<ChatStatus>(`/projects/${encodeURIComponent(projectId)}/chat/status`).then(setStatus, setStatusError);
  }, [projectId]);

  const loadSessions = useCallback(() => {
    api<ChatSessionSummary[]>(`/projects/${encodeURIComponent(projectId)}/chat/sessions`).then(setSessions, () => setSessions([]));
  }, [projectId]);

  const openSession = useCallback(
    async (id: string) => {
      setLoadingSession(true);
      setError(null);
      try {
        const d = await api<ChatSessionDetail>(`/projects/${encodeURIComponent(projectId)}/chat/sessions/${encodeURIComponent(id)}`);
        setState({ sessionId: d.id, messages: d.messages, actions: d.actions });
        store.set(sessionKey(projectId), d.id);
      } catch {
        store.set(sessionKey(projectId), null);
        setState(EMPTY);
      } finally {
        setLoadingSession(false);
      }
    },
    [projectId],
  );

  useEffect(() => {
    setState(EMPTY);
    setSessions(null);
    setStatus(null);
    if (!enabled) return;
    loadStatus();
    const saved = store.get(sessionKey(projectId));
    if (saved) void openSession(saved);
  }, [projectId, enabled, loadStatus, openSession]);

  useEffect(() => () => ctrl.current?.abort(), []);

  const newChat = useCallback(() => {
    ctrl.current?.abort();
    setState(EMPTY);
    setError(null);
    store.set(sessionKey(projectId), null);
  }, [projectId]);

  const stream = useCallback(
    async (path: string, body: unknown, assistantId: string | null) => {
      ctrl.current?.abort();
      const c = new AbortController();
      ctrl.current = c;
      let currentId = assistantId;
      let sawDone = false;
      await apiStream<ChatStreamEvent>(
        path,
        body,
        (ev) => {
          if (ev.type === "started") {
            currentId = ev.messageId;
            setState((s) => {
              const withoutTemp = s.messages.filter((m) => !m.id.startsWith("tmp_"));
              const optimisticUser = s.messages.find((m) => m.id === "tmp_user");
              const user = ev.userMessage ?? null;
              const assistant: ChatMessage = withoutTemp.find((m) => m.id === ev.messageId) ?? { id: ev.messageId, role: "assistant", content: "", status: "running", steps: [], error: null, model: null, createdAt: new Date().toISOString() };
              const base = optimisticUser && !user ? [...withoutTemp, optimisticUser] : withoutTemp;
              return { ...s, messages: mergeMessages(base, [user, { ...assistant, status: "running" }]) };
            });
          } else if (ev.type === "step") {
            setState((s) => ({ ...s, messages: s.messages.map((m) => (m.id === currentId ? { ...m, steps: upsertStep(m.steps, ev.step) } : m)) }));
          } else if (ev.type === "done") {
            sawDone = true;
            const r = ev.result;
            setState((s) => ({ ...s, messages: mergeMessages(s.messages.filter((m) => !m.id.startsWith("tmp_")), [r.userMessage, r.message]), actions: mergeActions(s.actions, r.actions) }));
            setSessions((list) => (list ? [r.session, ...list.filter((x) => x.id !== r.session.id)] : list));
          } else if (ev.type === "error") {
            setError(ev.message);
          }
        },
        c.signal,
      );
      return sawDone;
    },
    [],
  );

  const send = useCallback(
    async (text: string) => {
      const content = text.trim();
      if (!content || busy) return;
      setBusy(true);
      setError(null);
      const now = new Date().toISOString();
      let sid = state.sessionId;
      setState((s) => ({
        ...s,
        messages: [
          ...s.messages,
          { id: "tmp_user", role: "user", content, status: "complete", steps: [], error: null, model: null, createdAt: now },
          { id: "tmp_assistant", role: "assistant", content: "", status: "running", steps: [], error: null, model: null, createdAt: now },
        ],
      }));
      try {
        if (!sid) {
          const created = await api<ChatSessionSummary>(`/projects/${encodeURIComponent(projectId)}/chat/sessions`, { method: "POST" });
          sid = created.id;
          store.set(sessionKey(projectId), sid);
          setState((s) => ({ ...s, sessionId: created.id }));
        }
        const ok = await stream(`/projects/${encodeURIComponent(projectId)}/chat/sessions/${encodeURIComponent(sid)}/messages?stream=1`, { content }, null);
        if (!ok) await openSession(sid);
      } catch (e) {
        setState((s) => ({ ...s, messages: s.messages.filter((m) => !m.id.startsWith("tmp_")) }));
        setError(isRateLimited(e) ? "Too many messages. Wait a few minutes and try again." : errorMessage(e));
        if (sid) await openSession(sid);
        if ((e as { status?: number })?.status === 412) loadStatus();
      } finally {
        setBusy(false);
      }
    },
    [busy, state.sessionId, projectId, stream, openSession, loadStatus],
  );

  const decide = useCallback(
    async (actionId: string, decision: "confirm" | "cancel") => {
      const sid = state.sessionId;
      if (!sid || busy) return;
      setBusy(true);
      setError(null);
      setState((s) => ({ ...s, actions: s.actions.map((a) => (a.id === actionId ? { ...a, status: decision === "confirm" ? "executing" : a.status } : a)) }));
      try {
        const ok = await stream(`/projects/${encodeURIComponent(projectId)}/chat/sessions/${encodeURIComponent(sid)}/actions/${encodeURIComponent(actionId)}/${decision}?stream=1`, undefined, null);
        if (!ok) await openSession(sid);
      } catch (e) {
        setError(errorMessage(e));
        await openSession(sid);
      } finally {
        setBusy(false);
      }
    },
    [busy, state.sessionId, projectId, stream, openSession],
  );

  const remove = useCallback(
    async (id: string) => {
      try {
        await api(`/projects/${encodeURIComponent(projectId)}/chat/sessions/${encodeURIComponent(id)}`, { method: "DELETE" });
        setSessions((l) => (l ? l.filter((x) => x.id !== id) : l));
        if (state.sessionId === id) newChat();
      } catch (e) {
        setError(errorMessage(e));
      }
    },
    [projectId, state.sessionId, newChat],
  );

  return { status, statusError, loadStatus, state, sessions, loadSessions, openSession, newChat, send, decide, remove, busy, error, setError, loadingSession };
}

// ------------------------------------------------------------------ panel
function Icon() {
  return (
    <span aria-hidden="true" className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-gradient-to-br from-sky-500 to-emerald-500 text-[11px] font-bold text-white">
      O
    </span>
  );
}

function HeaderButton({ children, label, onClick, pressed }: { children: ReactNode; label: string; onClick: () => void; pressed?: boolean }) {
  return (
    <button type="button" className={cx(buttonClass("ghost", "sm"), "px-2")} onClick={onClick} aria-label={label} title={label} aria-pressed={pressed}>
      {children}
    </button>
  );
}

export function ChatPanel({ projectId, onClose, onMinimize }: { projectId: string; onClose: () => void; onMinimize: () => void }) {
  const titleId = useId();
  const inputId = useId();
  const chat = useChat(projectId, true);
  const [view, setView] = useState<"chat" | "history">("chat");
  const [draft, setDraft] = useState("");
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const navigate = useNavigate();
  const max = chat.status?.limits.maxMessageChars ?? 4000;
  const ready = chat.status?.state === "ready";
  const running = chat.state.messages.some((m) => m.status === "running");
  const lastAssistant = [...chat.state.messages].reverse().find((m) => m.role === "assistant");
  const live = running && lastAssistant ? progressText(lastAssistant.steps) : lastAssistant && !chat.busy ? (lastAssistant.status === "awaiting_confirmation" ? "Answer ready. An action is waiting for your confirmation." : "Answer ready.") : "";

  useEffect(() => {
    inputRef.current?.focus();
  }, []);
  useEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [chat.state.messages]);

  const goTo = (path: string) => {
    navigate(path);
    if (typeof window !== "undefined" && window.matchMedia?.("(max-width: 639px)").matches) onMinimize();
  };

  const submit = (text = draft) => {
    if (!text.trim() || chat.busy || !ready) return;
    void chat.send(text);
    setDraft("");
  };

  return (
    <div
      role="dialog"
      aria-modal="false"
      aria-labelledby={titleId}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.stopPropagation();
          onMinimize();
        }
      }}
      className={cx(
        "fixed inset-0 z-50 flex flex-col overflow-hidden bg-white text-zinc-900 dark:bg-zinc-950 dark:text-zinc-100",
        "sm:inset-y-0 sm:right-0 sm:left-auto sm:w-[420px] sm:max-w-[100vw] sm:border-l sm:border-zinc-200 sm:shadow-2xl sm:dark:border-zinc-800",
      )}
    >
      <div className="flex items-center gap-1.5 border-b border-zinc-200 px-3 py-2.5 dark:border-zinc-800">
        <Icon />
        <h2 id={titleId} className="min-w-0 flex-1 truncate text-base font-semibold tracking-tight">
          Ask Okara <Badge tone="info" className="ml-1 align-middle">beta</Badge>
        </h2>
        <HeaderButton
          label="New chat"
          onClick={() => {
            chat.newChat();
            setView("chat");
            inputRef.current?.focus();
          }}
        >
          New
        </HeaderButton>
        <HeaderButton
          label="History"
          pressed={view === "history"}
          onClick={() => {
            if (view !== "history") chat.loadSessions();
            setView((v) => (v === "history" ? "chat" : "history"));
          }}
        >
          History
        </HeaderButton>
        <HeaderButton label="Minimise Ask Okara" onClick={onMinimize}>
          <span aria-hidden="true">–</span>
        </HeaderButton>
        <HeaderButton label="Close Ask Okara" onClick={onClose}>
          <span aria-hidden="true">✕</span>
        </HeaderButton>
      </div>

      <p className="sr-only" aria-live="polite" role="status">
        {live}
      </p>

      {view === "history" ? (
        <div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden px-3 py-3">
          <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-zinc-500">Your chats in this project</h3>
          {chat.sessions === null ? (
            <p className="flex items-center gap-2 text-sm text-zinc-500">
              <Spinner className="h-4 w-4" /> Loading…
            </p>
          ) : chat.sessions.length === 0 ? (
            <p className="text-sm text-zinc-600 dark:text-zinc-400">No chats yet.</p>
          ) : (
            <ul className="space-y-1">
              {chat.sessions.map((s) => (
                <li key={s.id} className="flex min-w-0 items-center gap-1">
                  <button
                    type="button"
                    className={cx(
                      "min-w-0 flex-1 rounded-lg px-2.5 py-2 text-left text-sm hover:bg-zinc-100 focus-visible:outline-2 focus-visible:outline-sky-600 dark:hover:bg-zinc-900",
                      s.id === chat.state.sessionId && "bg-zinc-100 dark:bg-zinc-900",
                    )}
                    onClick={() => {
                      void chat.openSession(s.id);
                      setView("chat");
                    }}
                  >
                    <span className="block truncate font-medium">{s.title}</span>
                    <span className="block text-xs text-zinc-500 dark:text-zinc-400">
                      {formatRelative(s.updatedAt)} · {s.messageCount} message{s.messageCount === 1 ? "" : "s"}
                      {s.status === "awaiting_confirmation" ? " · action waiting" : ""}
                    </span>
                  </button>
                  <button type="button" className={cx(buttonClass("ghost", "sm"), "px-2")} aria-label={`Delete chat ${s.title}`} onClick={() => void chat.remove(s.id)}>
                    <span aria-hidden="true">🗑</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : (
        <div ref={listRef} className="min-h-0 flex-1 space-y-4 overflow-y-auto overflow-x-hidden px-3 py-4">
          {chat.statusError ? (
            <p role="alert" className="text-sm text-red-700 dark:text-red-300">
              Could not load Ask Okara. {errorMessage(chat.statusError)}{" "}
              <button type="button" className="underline" onClick={chat.loadStatus}>
                Retry
              </button>
            </p>
          ) : !chat.status ? (
            <p className="flex items-center gap-2 text-sm text-zinc-500">
              <Spinner className="h-4 w-4" /> Loading…
            </p>
          ) : !ready ? (
            <div className="rounded-xl border border-amber-300 bg-amber-50 p-3 text-sm dark:border-amber-800 dark:bg-amber-950/40">
              <p className="font-semibold">Setup required</p>
              <p className="mt-1 break-words text-zinc-700 dark:text-zinc-300">{chat.status.message ?? "No chat model is configured."}</p>
              <p className="mt-1 text-zinc-700 dark:text-zinc-300">Ask Okara uses the workspace writer model (Anthropic or an OpenAI-compatible endpoint with tool calling).</p>
              <Link className={cx(buttonClass("secondary", "sm"), "mt-2")} to={projectPath(projectId, "integrations")} onClick={() => onMinimize()}>
                Open Integrations
              </Link>
            </div>
          ) : chat.loadingSession ? (
            <p className="flex items-center gap-2 text-sm text-zinc-500">
              <Spinner className="h-4 w-4" /> Loading chat…
            </p>
          ) : chat.state.messages.length === 0 ? (
            <div className="space-y-3">
              <p className="text-sm text-zinc-700 dark:text-zinc-300">
                Ask about this project's SEO and GEO data. Answers use stored Search Console, crawl, AI-answer and run data, and say when data is missing. Actions such as running an agent always ask you to confirm first.
              </p>
              <div className="flex flex-col gap-2">
                {STARTER_PROMPTS.map((p) => (
                  <button
                    key={p}
                    type="button"
                    className="rounded-xl border border-zinc-200 bg-white px-3 py-2 text-left text-sm hover:border-zinc-400 focus-visible:outline-2 focus-visible:outline-sky-600 dark:border-zinc-800 dark:bg-zinc-900 dark:hover:border-zinc-600"
                    onClick={() => submit(p)}
                  >
                    {p}
                  </button>
                ))}
              </div>
            </div>
          ) : (
            chat.state.messages.map((m) =>
              m.role === "user" ? (
                <div key={m.id} className="flex justify-end">
                  <p className="max-w-[85%] whitespace-pre-wrap break-words rounded-2xl rounded-br-sm bg-zinc-900 px-3 py-2 text-sm text-white [overflow-wrap:anywhere] dark:bg-zinc-100 dark:text-zinc-900">{m.content}</p>
                </div>
              ) : (
                <AssistantMessage key={m.id} message={m} actions={chat.state.actions} projectId={projectId} busy={chat.busy} onDecide={(id, d) => void chat.decide(id, d)} onNavigate={goTo} />
              ),
            )
          )}
          {chat.error && (
            <p role="alert" className="rounded-lg border border-red-200 bg-red-50 px-2.5 py-1.5 text-xs text-red-800 dark:border-red-900 dark:bg-red-950/40 dark:text-red-200">
              {chat.error}
            </p>
          )}
        </div>
      )}

      <form
        className="border-t border-zinc-200 p-3 dark:border-zinc-800"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <label htmlFor={inputId} className="sr-only">
          Message Ask Okara
        </label>
        <div className="flex items-end gap-2">
          <textarea
            id={inputId}
            ref={inputRef}
            rows={2}
            maxLength={max}
            value={draft}
            disabled={!ready}
            placeholder="Ask about your SEO and GEO…"
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                submit();
              }
            }}
            className="block min-h-[2.75rem] w-full min-w-0 flex-1 resize-none rounded-xl border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-900 placeholder:text-zinc-400 focus-visible:outline-2 focus-visible:outline-sky-600 disabled:opacity-60 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100 dark:placeholder:text-zinc-500"
          />
          <button type="submit" className={buttonClass("primary", "md")} disabled={!ready || chat.busy || !draft.trim()} aria-busy={chat.busy || undefined}>
            {chat.busy ? <Spinner className="h-4 w-4" /> : null}
            Send
          </button>
        </div>
        <p className="mt-1.5 text-[11px] text-zinc-500 dark:text-zinc-400">
          Uses stored project data; AI answers can be wrong. {draft.length > max * 0.8 ? `${draft.length}/${max}` : ""}
        </p>
      </form>
    </div>
  );
}

/** Sidebar toggle + panel (portal), mounted once per project page. */
export function ChatLauncher({ projectId, className }: { projectId: string; className?: string }) {
  const [mode, setMode] = useState<"closed" | "open" | "minimized">(() => (store.get(openKey) === "1" ? "open" : "closed"));
  const buttonRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    store.set(openKey, mode === "open" ? "1" : null);
  }, [mode]);
  const close = () => {
    setMode("closed");
    buttonRef.current?.focus();
  };
  const panel =
    mode === "open" ? (
      <ChatPanel projectId={projectId} onClose={close} onMinimize={() => setMode("minimized")} />
    ) : mode === "minimized" ? (
      <button
        type="button"
        onClick={() => setMode("open")}
        className="fixed right-4 bottom-4 z-50 inline-flex items-center gap-2 rounded-full border border-zinc-200 bg-white px-3.5 py-2 text-sm font-medium shadow-lg hover:bg-zinc-50 focus-visible:outline-2 focus-visible:outline-sky-600 dark:border-zinc-700 dark:bg-zinc-900 dark:hover:bg-zinc-800"
      >
        <Icon /> Ask Okara
      </button>
    ) : null;
  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        className={cx(buttonClass("secondary", "sm"), className)}
        aria-expanded={mode === "open"}
        aria-haspopup="dialog"
        onClick={() => setMode((m) => (m === "open" ? "closed" : "open"))}
      >
        Ask Okara
      </button>
      {panel && typeof document !== "undefined" ? createPortal(panel, document.body) : panel}
    </>
  );
}
