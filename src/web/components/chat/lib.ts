/**
 * Ask Okara panel helpers (pure; tested in Node). Model output is untrusted: it is parsed into a tiny
 * markdown-lite tree (paragraphs, bullet/numbered lists, bold, inline code, links) and rendered as React text,
 * never as HTML. Links are kept only for in-app routes of the current project or http(s) URLs.
 */
import type { ChatAction, ChatMessage, ChatSecretField, ChatStep, ChatStepKind } from "@shared/types";

// ------------------------------------------------------------------ markdown-lite
export type Inline =
  | { t: "text"; v: string }
  | { t: "bold"; v: string }
  | { t: "code"; v: string }
  | { t: "link"; text: string; href: string; internal: boolean };

export type Block = { t: "p"; lines: Inline[][] } | { t: "ul"; items: Inline[][] } | { t: "ol"; items: Inline[][]; start: number } | { t: "h"; inline: Inline[] };

/**
 * Allowed link targets: an in-app route of this project (`/projects/<id>` or below; returned as internal) or an
 * absolute http(s) URL without credentials. Everything else (javascript:, data:, other projects, relative
 * paths, protocol-relative URLs) is null and rendered as plain text.
 */
export function safeHref(raw: string, projectId: string): { href: string; internal: boolean } | null {
  const href = raw.trim();
  const base = `/projects/${encodeURIComponent(projectId)}`;
  if (href.startsWith("/")) {
    if (href.startsWith("//") || href.includes("\\")) return null;
    if (href === base || href.startsWith(`${base}/`) || href.startsWith(`${base}?`)) {
      if (/(^|\/)\.\.?(\/|$)/.test(href.slice(base.length))) return null;
      return { href, internal: true };
    }
    return null;
  }
  try {
    const u = new URL(href);
    if ((u.protocol === "https:" || u.protocol === "http:") && !u.username && !u.password) return { href: u.toString(), internal: false };
  } catch {
    // not a URL
  }
  return null;
}

const INLINE_RE = /\*\*([^*\n]+)\*\*|`([^`\n]+)`|\[([^\]\n]+)\]\(([^)\s]+)\)/g;

export function parseInline(text: string, projectId: string): Inline[] {
  const out: Inline[] = [];
  let last = 0;
  const push = (v: string) => {
    if (!v) return;
    const prev = out[out.length - 1];
    if (prev && prev.t === "text") prev.v += v;
    else out.push({ t: "text", v });
  };
  for (const m of text.matchAll(INLINE_RE)) {
    const i = m.index ?? 0;
    push(text.slice(last, i));
    if (m[1] !== undefined) out.push({ t: "bold", v: m[1] });
    else if (m[2] !== undefined) out.push({ t: "code", v: m[2] });
    else {
      const safe = safeHref(m[4]!, projectId);
      if (safe) out.push({ t: "link", text: m[3]!, href: safe.href, internal: safe.internal });
      else push(m[3]!);
    }
    last = i + m[0].length;
  }
  push(text.slice(last));
  return out;
}

const UL_RE = /^\s{0,3}[-*•]\s+(.*)$/;
const OL_RE = /^\s{0,3}(\d{1,3})[.)]\s+(.*)$/;
const H_RE = /^\s{0,3}#{1,6}\s+(.*)$/;

export function parseMarkdownLite(text: string, projectId: string): Block[] {
  const blocks: Block[] = [];
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  let para: Inline[][] = [];
  const flush = () => {
    if (para.length) blocks.push({ t: "p", lines: para });
    para = [];
  };
  for (const raw of lines) {
    if (/^\s*```/.test(raw)) continue; // fences are dropped; their content stays plain text
    if (!raw.trim()) {
      flush();
      continue;
    }
    const ul = UL_RE.exec(raw);
    const ol = OL_RE.exec(raw);
    const h = H_RE.exec(raw);
    if (ul) {
      flush();
      const prev = blocks[blocks.length - 1];
      const item = parseInline(ul[1]!, projectId);
      if (prev && prev.t === "ul") prev.items.push(item);
      else blocks.push({ t: "ul", items: [item] });
    } else if (ol) {
      flush();
      const prev = blocks[blocks.length - 1];
      const item = parseInline(ol[2]!, projectId);
      if (prev && prev.t === "ol") prev.items.push(item);
      else blocks.push({ t: "ol", items: [item], start: Number(ol[1]) || 1 });
    } else if (h) {
      flush();
      blocks.push({ t: "h", inline: parseInline(h[1]!.replace(/#+\s*$/, ""), projectId) });
    } else {
      para.push(parseInline(raw.trim(), projectId));
    }
  }
  flush();
  return blocks;
}

// ------------------------------------------------------------------ steps
export interface StepGroup {
  kind: ChatStepKind;
  steps: ChatStep[];
  label: string;
}

const KIND_LABEL: Record<ChatStepKind, string> = { read: "Read data", action: "Performed action", output: "Prepared" };

/** Consecutive steps of the same kind form one collapsible group, e.g. "Read data · 3 steps". */
export function groupSteps(steps: ChatStep[]): StepGroup[] {
  const groups: StepGroup[] = [];
  for (const s of steps) {
    const prev = groups[groups.length - 1];
    if (prev && prev.kind === s.kind) prev.steps.push(s);
    else groups.push({ kind: s.kind, steps: [s], label: "" });
  }
  for (const g of groups) {
    const verb = g.kind === "action" && g.steps.every((s) => s.status === "awaiting_confirmation") ? "Proposed action" : g.kind === "action" && g.steps.every((s) => s.status === "cancelled" || s.status === "expired") ? "Action not run" : KIND_LABEL[g.kind];
    g.label = `${verb} · ${g.steps.length} step${g.steps.length === 1 ? "" : "s"}`;
  }
  return groups;
}

export const STEP_STATUS_LABEL: Record<ChatStep["status"], string> = {
  ok: "Done",
  error: "Error",
  awaiting_confirmation: "Waiting for your confirmation",
  executed: "Done",
  failed: "Failed",
  cancelled: "Cancelled",
  expired: "Not confirmed",
};

/** Upsert a step (same id replaces). */
export function upsertStep(steps: ChatStep[], step: ChatStep): ChatStep[] {
  const i = steps.findIndex((s) => s.id === step.id);
  if (i < 0) return [...steps, step];
  const next = steps.slice();
  next[i] = step;
  return next;
}

/** Replace or append messages by id, keeping order by first appearance. */
export function mergeMessages(list: ChatMessage[], incoming: Array<ChatMessage | null | undefined>): ChatMessage[] {
  let out = list.slice();
  for (const m of incoming) {
    if (!m) continue;
    const i = out.findIndex((x) => x.id === m.id);
    if (i >= 0) out[i] = m;
    else out = [...out, m];
  }
  return out;
}

export function mergeActions(list: ChatAction[], incoming: ChatAction[]): ChatAction[] {
  const byId = new Map(list.map((a) => [a.id, a]));
  for (const a of incoming) byId.set(a.id, a);
  return [...byId.values()];
}

/** Live-region text while a turn runs. */
export function progressText(steps: ChatStep[]): string {
  const last = steps[steps.length - 1];
  if (!last) return "Ask Okara is thinking…";
  if (last.status === "awaiting_confirmation") return "Waiting for your confirmation.";
  return `${last.kind === "read" ? "Read" : last.kind === "output" ? "Prepared" : "Ran"} ${last.tool.replace(/_/g, " ")}. Still working…`;
}

// ------------------------------------------------------------------ CSV (client-side export)
/** RFC 4180 CSV; cells that a spreadsheet would run as a formula are prefixed with an apostrophe. */
export function toCsv(columns: string[], rows: Array<Array<string | number | null>>): string {
  const cell = (v: string | number | null) => {
    if (v === null || v === undefined) return "";
    if (typeof v === "number") return Number.isFinite(v) ? String(v) : "";
    let s = String(v);
    if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [columns.map(cell), ...rows.map((r) => r.map(cell))].map((r) => r.join(",")).join("\r\n") + "\r\n";
}

/** Only a plain file name (no path separators or control characters). */
export function safeFilename(name: string): string {
  const base = name.replace(/[\\/:*?"<>|\u0000-\u001f]/g, "-").slice(0, 120);
  return base.toLowerCase().endsWith(".csv") ? base : `${base || "export"}.csv`;
}

// ------------------------------------------------------------------ starters
export const STARTER_PROMPTS = [
  "Which queries lost clicks vs last month?",
  "Which pages lost clicks in the last 28 days?",
  "Why isn't Gemini citing us?",
  "What should I fix first this week?",
  "Run the GEO agent now",
] as const;

/** Example keyword for the search-volume starter (a paid DataForSEO lookup; the chat asks to confirm first). */
export const STARTER_KEYWORD_EXAMPLE = "alabaster sconces";

/**
 * Starter prompts for a project: the fixed ones plus DataForSEO examples. The keyword-gap prompt names the
 * project's first tracked competitor domain (never an invented one) and is left out when there is none.
 */
export function starterPrompts(competitorDomain?: string | null): string[] {
  const domain = (competitorDomain ?? "").trim().toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/.*$/, "");
  const valid = /^[a-z0-9.-]{1,253}$/.test(domain) && domain.includes(".");
  return [
    STARTER_PROMPTS[0],
    STARTER_PROMPTS[1],
    ...(valid ? [`Show competitor keyword gap for ${domain}`] : []),
    `What's the search volume for '${STARTER_KEYWORD_EXAMPLE}'?`,
    ...STARTER_PROMPTS.slice(2),
  ];
}

// ------------------------------------------------------------------ secure field [A35]
/**
 * The only routes a secure-field card may send typed secrets to: the existing credential routes of a workspace.
 * Anything else (another path, method or a body that already carries a secret field) is refused client-side, so
 * even a malformed card can never post a key elsewhere.
 */
const SECRET_ROUTES: Array<[ChatSecretField["request"]["method"], RegExp]> = [
  ["PUT", /^\/workspaces\/[a-z0-9_]{1,100}\/credentials\/(typesafe|gemini|perplexity|openai_geo|anthropic_geo|writer)$/],
  ["PUT", /^\/workspaces\/[a-z0-9_]{1,100}\/dataforseo$/],
  ["PUT", /^\/workspaces\/[a-z0-9_]{1,100}\/maton$/],
  ["POST", /^\/workspaces\/[a-z0-9_]{1,100}\/custom-providers$/],
  ["PATCH", /^\/workspaces\/[a-z0-9_]{1,100}\/custom-providers\/[a-z0-9_]{1,100}$/],
];

export function secretRequestAllowed(f: ChatSecretField | null | undefined): boolean {
  if (!f || !f.request || typeof f.request.path !== "string") return false;
  if (!SECRET_ROUTES.some(([m, re]) => m === f.request.method && re.test(f.request.path))) return false;
  const body = f.request.body ?? {};
  return !Object.keys(body).some((k) => ["apiKey", "login", "password", "keepKeyForNewHost"].includes(k)) && f.fields.length > 0 && f.fields.length <= 2;
}

/** Route body: the card's non-secret fields plus the typed values (trimmed, as the routes trim them). */
export function secretRequestBody(f: ChatSecretField, values: Record<string, string>): Record<string, unknown> {
  const body: Record<string, unknown> = { ...f.request.body };
  for (const field of f.fields) body[field.name] = (values[field.name] ?? "").trim();
  return body;
}

/** Last 4 characters of the hint field, as the routes store it; null when empty. */
export function secretKeyHint(f: ChatSecretField, values: Record<string, string>): string | null {
  const v = (values[f.hintFrom] ?? "").trim();
  return v ? v.slice(-4) : null;
}
