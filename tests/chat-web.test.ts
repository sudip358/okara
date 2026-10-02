/**
 * Ask Okara panel: pure helpers (markdown-lite parsing, link safety, step grouping, CSV export, merging) and
 * server-rendered markup of an assistant message (plain-text rendering of untrusted output, step groups,
 * confirmation card, accessible labels).
 */
import { createElement as h, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";
import type { ChatAction, ChatMessage, ChatStep } from "@shared/types";
import { groupSteps, mergeMessages, parseInline, parseMarkdownLite, progressText, safeFilename, safeHref, toCsv, upsertStep } from "@web/components/chat/lib";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type FC = (props: any) => ReactElement | null;
// Web .tsx modules load dynamically (test tsconfig has no JSX); Vitest transforms them at runtime.
const load = async <T,>(rel: string): Promise<T> => (await import(/* @vite-ignore */ rel)) as T;
const panel = await load<Record<"AssistantMessage" | "MarkdownLite", FC>>("../src/web/components/chat/ChatPanel.tsx");
const render = (el: ReactElement) => renderToStaticMarkup(h(MemoryRouter, null, el));

const step = (over: Partial<ChatStep>): ChatStep => ({ id: Math.random().toString(36), kind: "read", tool: "get_overview", args: "", result: "ok", status: "ok", ...over });
const msg = (over: Partial<ChatMessage>): ChatMessage => ({ id: "m1", role: "assistant", content: "", status: "complete", steps: [], error: null, model: { provider: "anthropic", model: "configured-model" }, createdAt: "2026-10-02T00:00:00Z", ...over });

describe("markdown-lite", () => {
  it("parses paragraphs, lists, bold, code and headings", () => {
    const b = parseMarkdownLite("## Summary\n\n**/knobs** lost 50 clicks.\nSecond line\n\n- one\n- `two`\n\n1. first\n2. second", "p1");
    expect(b.map((x) => x.t)).toEqual(["h", "p", "ul", "ol"]);
    expect(b[1]).toEqual({ t: "p", lines: [[{ t: "bold", v: "/knobs" }, { t: "text", v: " lost 50 clicks." }], [{ t: "text", v: "Second line" }]] });
    expect(b[2]).toEqual({ t: "ul", items: [[{ t: "text", v: "one" }], [{ t: "code", v: "two" }]] });
    expect(b[3]).toMatchObject({ t: "ol", start: 1 });
  });

  it("keeps links only for this project's routes and http(s) URLs", () => {
    expect(safeHref("/projects/p1/live", "p1")).toEqual({ href: "/projects/p1/live", internal: true });
    expect(safeHref("/projects/p1", "p1")).toEqual({ href: "/projects/p1", internal: true });
    expect(safeHref("/projects/p2/live", "p1")).toBeNull();
    expect(safeHref("/projects/p1/../p2", "p1")).toBeNull();
    expect(safeHref("//evil.example/x", "p1")).toBeNull();
    expect(safeHref("javascript:alert(1)", "p1")).toBeNull();
    expect(safeHref("data:text/html,<b>x</b>", "p1")).toBeNull();
    expect(safeHref("https://user:pw@evil.example/", "p1")).toBeNull();
    expect(safeHref("https://example.com/a?b=1", "p1")).toEqual({ href: "https://example.com/a?b=1", internal: false });
    expect(parseInline("see [it](javascript:void0)", "p1")).toEqual([{ t: "text", v: "see it" }]);
  });

  it("renders untrusted HTML as text, never markup", () => {
    const html = render(h(panel.MarkdownLite, { text: '<img src=x onerror="alert(1)"> **hi** [x](javascript:alert(1)) [live](/projects/p1/live)', projectId: "p1" }));
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;img");
    expect(html).not.toContain("javascript:");
    expect(html).toMatch(/<a href="\/projects\/p1\/live"[^>]*>live<\/a>/);
    expect(html).toContain("<strong");
  });
});

describe("steps and state helpers", () => {
  it("groups consecutive steps by kind with counts", () => {
    const g = groupSteps([step({}), step({ tool: "list_pages" }), step({ tool: "geo_results" }), step({ kind: "action", tool: "run_agent_now", status: "executed" }), step({ kind: "output", tool: "navigate" })]);
    expect(g.map((x) => x.label)).toEqual(["Read data · 3 steps", "Performed action · 1 step", "Prepared · 1 step"]);
    expect(groupSteps([step({ kind: "action", status: "awaiting_confirmation" })])[0]!.label).toBe("Proposed action · 1 step");
    expect(groupSteps([step({ kind: "action", status: "cancelled" })])[0]!.label).toBe("Action not run · 1 step");
  });

  it("upserts steps and merges messages by id", () => {
    const a = step({ id: "a", result: "first" });
    expect(upsertStep(upsertStep([], a), { ...a, result: "second" })).toEqual([{ ...a, result: "second" }]);
    const m = mergeMessages([msg({ id: "x", content: "old" })], [msg({ id: "x", content: "new" }), null, msg({ id: "y" })]);
    expect(m.map((x) => [x.id, x.content])).toEqual([["x", "new"], ["y", ""]]);
    expect(progressText([])).toMatch(/thinking/);
    expect(progressText([step({ tool: "search_console_queries" })])).toBe("Read search console queries. Still working…");
  });

  it("builds CSV with quoting and neutralises spreadsheet formulas", () => {
    const csv = toCsv(["query", "clicks"], [["=cmd|'/C calc'!A0", 3], ['say "hi", ok', null], ["-5 brass", -5]]);
    expect(csv).toBe(`query,clicks\r\n'=cmd|'/C calc'!A0,3\r\n"say ""hi"", ok",\r\n'-5 brass,-5\r\n`);
    expect(safeFilename("../../etc/passwd")).toBe("..-..-etc-passwd.csv");
    expect(safeFilename("okara-pages.csv")).toBe("okara-pages.csv");
  });
});

describe("assistant message markup", () => {
  const action: ChatAction = { id: "a1", messageId: "m1", name: "run_agent_now", title: "Run the SEO agent now?", detail: "Starts a manual run.", args: { agent: "seo" }, status: "pending", result: null, createdAt: "", decidedAt: null };

  it("shows collapsible step groups, the confirmation card with Confirm/Cancel, and output buttons", () => {
    const html = render(
      h(panel.AssistantMessage, {
        message: msg({
          status: "awaiting_confirmation",
          content: "I can start the SEO agent.",
          steps: [
            step({ tool: "list_runs", args: "limit=5", result: "3 run(s)" }),
            step({ kind: "action", tool: "run_agent_now", args: "agent=seo", result: "Run the SEO agent now?", status: "awaiting_confirmation", actionId: "a1" }),
          ],
        }),
        actions: [action],
        projectId: "p1",
        busy: false,
        onDecide: () => {},
        onNavigate: () => {},
      }),
    );
    expect(html).toContain("<details");
    expect(html).toContain("Read data · 1 step");
    expect(html).toContain("Proposed action · 1 step");
    expect(html).toContain("list_runs");
    expect(html).toContain("(limit=5)");
    expect(html).toContain("Run the SEO agent now?");
    expect(html).toContain(">Confirm<");
    expect(html).toContain(">Cancel<");
    expect(html).toContain('aria-label="Action needs confirmation"');
  });

  it("renders error states and download/navigate outputs; no confirm buttons once decided", () => {
    const html = render(
      h(panel.AssistantMessage, {
        message: msg({
          content: "Done. Open [Live view](/projects/p1/live).",
          steps: [
            step({ kind: "action", tool: "run_agent_now", status: "executed", actionId: "a1", navigate: { path: "/projects/p1/live", label: "Open Live view" } }),
            step({ kind: "output", tool: "export_csv", download: { filename: "x.csv", columns: ["a"], rows: [["1"]], truncated: false } }),
          ],
        }),
        actions: [{ ...action, status: "executed", result: "Started SEO run run_1 (pending)" }],
        projectId: "p1",
        busy: false,
        onDecide: () => {},
        onNavigate: () => {},
      }),
    );
    expect(html).not.toContain(">Confirm<");
    expect(html).toContain("Confirmed and done");
    expect(html).toContain("Open Live view");
    expect(html).toContain("Download CSV (1 row)");
    expect(html).toContain("Copy");
    const err = render(h(panel.AssistantMessage, { message: msg({ status: "error", error: "Daily usage limit reached." }), actions: [], projectId: "p1", busy: false, onDecide: () => {}, onNavigate: () => {} }));
    expect(err).toContain('role="alert"');
    expect(err).toContain("Daily usage limit reached.");
  });
});
