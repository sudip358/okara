/**
 * Writer card, custom (OpenAI-compatible) provider flow: pure helpers and server-rendered markup (no DOM,
 * no live calls). Model ids from a provider's /models list are untrusted and must render as plain text.
 */
import { createElement as h, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { CustomProviderModelList, CustomProviderStatus, IntegrationsStatus } from "@shared/types";
import {
  MODEL_OPTIONS_SHOWN,
  activeCustomWriter,
  baseUrlInputError,
  defaultWriterName,
  fieldErrorFor,
  filterModels,
  isFieldError,
  testOutcomeText,
} from "@web/pages/integrations/custom-writer-lib";

// Web .tsx modules load dynamically (test tsconfig has no JSX); Vitest transforms them at runtime.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type FC = (props: any) => ReactElement | null;
const load = async <T,>(rel: string): Promise<T> => (await import(/* @vite-ignore */ rel)) as T;
const ui = await load<Record<"WriterProviderRow" | "ModelPicker" | "CustomProviderForm" | "SavedProviderItem", FC>>("../src/web/pages/integrations/CustomWriter.tsx");
// The api client is browser code (DOM fetch types); load it at runtime only.
const { ApiError } = await load<{ ApiError: new (status: number, body: { code: string; message: string; details?: unknown }) => Error }>("../src/web/lib/api.ts");

const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/\s+/g, " ");

const list = (models: string[], over: Partial<CustomProviderModelList> = {}): CustomProviderModelList => ({
  ok: true,
  detail: "Key accepted.",
  models,
  total: models.length,
  truncated: false,
  ...over,
});

describe("custom writer helpers", () => {
  it("filters models by every search term, case-insensitively, with a cap", () => {
    const models = ["meta/Llama-3.3-70B", "meta/llama-3.1-8b", "deepseek/deepseek-chat", "mistral/large"];
    expect(filterModels(models, "")).toEqual({ shown: models, matched: 4 });
    expect(filterModels(models, "LLAMA 70b")).toEqual({ shown: ["meta/Llama-3.3-70B"], matched: 1 });
    expect(filterModels(models, "  meta  ").matched).toBe(2);
    expect(filterModels(models, "gpt")).toEqual({ shown: [], matched: 0 });
    const many = Array.from({ length: 450 }, (_, i) => `m-${i}`);
    expect(filterModels(many, "m").shown).toHaveLength(MODEL_OPTIONS_SHOWN);
    expect(filterModels(many, "m").matched).toBe(450);
  });

  it("checks base URLs quickly on the client (the server stays authoritative)", () => {
    expect(baseUrlInputError("https://openrouter.ai/api/v1")).toBeNull();
    expect(baseUrlInputError("")).toMatch(/Enter the provider's base URL/);
    expect(baseUrlInputError("openrouter.ai")).toMatch(/not a valid URL/);
    expect(baseUrlInputError("http://openrouter.ai/api/v1")).toMatch(/https/);
    expect(baseUrlInputError("https://u:p@openrouter.ai")).toMatch(/user name or password/);
    expect(baseUrlInputError("https://openrouter.ai/api/v1?x=1")).toMatch(/query/);
  });

  it("maps server field errors to their fields", () => {
    const err = new ApiError(400, { code: "bad_request", message: "Base URL must use a hostname, not an IP address.", details: { field: "baseUrl", reason: "ip_literal" } });
    expect(fieldErrorFor(err, "baseUrl")).toBe("Base URL must use a hostname, not an IP address.");
    expect(fieldErrorFor(err, "apiKey")).toBeNull();
    expect(isFieldError(err, ["apiKey", "baseUrl"])).toBe(true);
    expect(fieldErrorFor(new ApiError(409, { code: "conflict", message: "Max 5." }), "baseUrl")).toBeNull();
    expect(fieldErrorFor(new Error("x"), "baseUrl")).toBeNull();
  });

  it("names the default writer and the test outcome", () => {
    expect(defaultWriterName("Writer (Anthropic)")).toBe("Anthropic");
    expect(defaultWriterName("Writer (OpenAI-compatible)")).toBe("OpenAI-compatible");
    expect(defaultWriterName("Writer")).toBe("Default writer");
    expect(testOutcomeText(true, "Key accepted.")).toBe("Test passed: Key accepted.");
    expect(testOutcomeText(false, "Key rejected.")).toBe("Test failed: Key rejected.");
    expect(testOutcomeText(null, "Rate limited.")).toBe("Test not confirmed: Rate limited.");
    expect(activeCustomWriter(null)).toBeNull();
  });
});

describe("ModelPicker markup", () => {
  it("renders a searchable dropdown of fetched ids as plain text, keeping the current value selectable", () => {
    const hostile = '<img src=x onerror="alert(1)">';
    const html = renderToStaticMarkup(
      h(ui.ModelPicker, { id: "mp", list: list(["deepseek/deepseek-chat", hostile, "meta/llama-3.3-70b"], { truncated: true, total: 900 }), value: "custom/not-listed", onChange: () => {} }),
    );
    const t = text(html);
    expect(t).toContain("Search models");
    expect(t).toContain("Model");
    expect(t).toContain("Select a model…");
    expect(t).toContain("3 of 900 models match");
    expect(t).toContain("The provider listed more than 500");
    expect(t).toContain("Type a model id instead");
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;img src=x onerror=");
    // The saved value stays an option even when the list does not contain it.
    expect(html).toContain('value="custom/not-listed"');
    expect(html.indexOf('value="custom/not-listed"')).toBeLessThan(html.indexOf('value="deepseek/deepseek-chat"'));
  });

  it("falls back to a manual model id field when no list is available", () => {
    const html = renderToStaticMarkup(h(ui.ModelPicker, { id: "mp", list: list([], { detail: "Key accepted, but the provider returned no model ids; type a model id." }), value: "", onChange: () => {} }));
    const t = text(html);
    expect(t).toContain("Model id");
    expect(t).toContain("Fetch models to pick from the provider's list, or type the exact model id");
    expect(html).not.toContain("<select");
    expect(renderToStaticMarkup(h(ui.ModelPicker, { id: "mp", list: null, value: "x", onChange: () => {} }))).toContain('value="x"');
  });
});

describe("WriterProviderRow markup", () => {
  it("offers the provider type choice and shows the default writer's key row", () => {
    const writer: IntegrationsStatus["providers"][number] = {
      provider: "writer",
      label: "Writer (Anthropic)",
      source: "none",
      keyHint: null,
      state: "setup_required",
      lastTestedAt: null,
      lastTestOk: null,
      lastTestDetail: null,
      model: "claude-test",
      dataSent: "Stored evidence.",
    };
    const html = renderToStaticMarkup(h(ui.WriterProviderRow, { workspaceId: "ws1", writer, defaultPanel: h("p", null, "DEFAULT KEY ROW"), onChange: () => {} }));
    const t = text(html);
    expect(t).toContain("Writer");
    expect(t).toContain("Provider type");
    expect(t).toContain("Anthropic");
    expect(t).toContain("Custom (OpenAI-compatible)");
    expect(t).toContain("DEFAULT KEY ROW");
    expect(html.match(/type="radio"/g)).toHaveLength(2);
    expect(html).toMatch(/checked="" value="default"/);
  });
});

const saved = (over: Partial<CustomProviderStatus> = {}): CustomProviderStatus => ({
  id: "cprov_1",
  label: "My gateway",
  baseUrl: "https://llm.example.com/v1",
  host: "llm.example.com",
  model: "meta/llama-3.3-70b",
  keyHint: "QRST",
  isWriter: true,
  lastTestedAt: null,
  lastTestOk: null,
  lastTestDetail: null,
  createdAt: "2026-09-30T12:00:00.000Z",
  updatedAt: "2026-09-30T12:00:00.000Z",
  ...over,
});

/** Visible text of every <button> in the markup, in order. */
const buttons = (html: string) => [...html.matchAll(/<button\b[^>]*>([\s\S]*?)<\/button>/g)].map((m) => text(m[1]!).trim());
/** The <input> tags of the markup, each as its raw tag. */
const inputs = (html: string) => html.match(/<input\b[^>]*>/g) ?? [];
const noop = () => {};

describe("CustomProviderForm markup (Writer card, Custom provider type)", () => {
  it("add form: base URL and password key fields, Fetch models, manual model id fallback, Save and use as writer", () => {
    const html = renderToStaticMarkup(h(ui.CustomProviderForm, { workspaceId: "ws1", initial: null, onSaved: noop }));
    const t = text(html);
    expect(t).toContain("Custom provider (OpenAI-compatible)");
    expect(html).toMatch(/<label[^>]*>[^<]*Base URL/);
    expect(html).toMatch(/<label[^>]*>[^<]*API key/);
    const url = inputs(html).find((i) => i.includes('placeholder="https://openrouter.ai/api/v1"'))!;
    expect(url).toContain('type="url"');
    expect(url).toContain('value=""');
    // The key is a password field (never shown), empty, with the "stored encrypted" hint.
    const keys = inputs(html).filter((i) => i.includes('type="password"'));
    expect(keys).toHaveLength(1);
    expect(keys[0]).toContain('placeholder="Paste key"');
    expect(keys[0]).toContain('value=""');
    expect(keys[0]).toMatch(/autocomplete="off"/i);
    expect(t).toContain("Stored encrypted; never shown again.");
    // Fetch models is disabled until a base URL is entered; before any fetch the model is typed by hand.
    expect(buttons(html)).toEqual(["Fetch models", "Save and use as writer"]);
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Fetch models<\/button>/);
    expect(t).toContain("Model id");
    expect(t).toContain("Fetch models to pick from the provider's list, or type the exact model id");
    expect(html).not.toContain("<select");
    expect(t).toContain("Name (optional)");
    expect(t).not.toContain("Leave empty to keep the saved key.");
  });

  it("edit form: key left empty keeps the saved key (placeholder shows only its last 4), Save changes, Cancel", () => {
    const html = renderToStaticMarkup(h(ui.CustomProviderForm, { workspaceId: "ws1", initial: saved(), onSaved: noop, onCancel: noop }));
    const t = text(html);
    expect(t).toContain("Edit My gateway");
    const key = inputs(html).find((i) => i.includes('type="password"'))!;
    expect(key).toContain('placeholder="Keep …QRST"');
    expect(key).toContain('value=""');
    expect(key).not.toContain("required");
    expect(t).toContain("Leave empty to keep the saved key.");
    // Saved values prefill the other fields.
    expect(inputs(html).find((i) => i.includes('type="url"'))).toContain('value="https://llm.example.com/v1"');
    expect(inputs(html).some((i) => i.includes('value="meta/llama-3.3-70b"'))).toBe(true);
    expect(inputs(html).some((i) => i.includes('value="My gateway"'))).toBe(true);
    expect(buttons(html)).toEqual(["Fetch models", "Save changes", "Cancel"]);
    expect(t).not.toContain("Save and use as writer");
  });

  it("renders a hostile label and model id as escaped text", () => {
    const hostile = '<img src=x onerror="alert(1)">';
    const html = renderToStaticMarkup(h(ui.CustomProviderForm, { workspaceId: "ws1", initial: saved({ label: hostile, model: hostile }), onSaved: noop }));
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;img src=x onerror=");
  });
});

describe("SavedProviderItem markup", () => {
  it("owner, active writer: base URL, model, key hint, Test, Change model, Remove; no 'Use as writer'", () => {
    const html = renderToStaticMarkup(h(ui.SavedProviderItem, { workspaceId: "ws1", p: saved(), canManage: true, apply: noop, reload: noop, onEdit: noop }));
    const t = text(html);
    expect(t).toContain("My gateway");
    expect(t).toContain("Active writer");
    expect(t).toContain("https://llm.example.com/v1");
    expect(t).toContain("llm.example.com");
    expect(t).toContain("meta/llama-3.3-70b");
    expect(t).toContain("…QRST");
    expect(t).toContain("Last test never");
    expect(buttons(html)).toEqual(["Test", "Change model", "Edit URL or key", "Remove"]);
    expect(buttons(html)).not.toContain("Use as writer");
  });

  it("owner, saved but not the writer: offers 'Use as writer'", () => {
    const html = renderToStaticMarkup(h(ui.SavedProviderItem, { workspaceId: "ws1", p: saved({ isWriter: false }), canManage: true, apply: noop, reload: noop, onEdit: noop }));
    expect(buttons(html)).toEqual(["Test", "Use as writer", "Change model", "Edit URL or key", "Remove"]);
    expect(text(html)).not.toContain("Active writer");
  });

  it("member (cannot manage): only Test", () => {
    const html = renderToStaticMarkup(
      h(ui.SavedProviderItem, {
        workspaceId: "ws1",
        p: saved({ lastTestedAt: "2026-09-30T12:00:00.000Z", lastTestOk: false, lastTestDetail: "Key rejected by provider (HTTP 401)." }),
        canManage: false,
        apply: noop,
        reload: noop,
        onEdit: noop,
      }),
    );
    expect(buttons(html)).toEqual(["Test"]);
    expect(text(html)).toContain("failed (Key rejected by provider (HTTP 401).)");
  });

  it("renders a hostile label and model id as escaped text", () => {
    const hostile = '<img src=x onerror="alert(1)">';
    const html = renderToStaticMarkup(
      h(ui.SavedProviderItem, { workspaceId: "ws1", p: saved({ label: hostile, model: hostile, lastTestedAt: "2026-09-30T12:00:00.000Z", lastTestDetail: hostile }), canManage: true, apply: noop, reload: noop, onEdit: noop }),
    );
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;img src=x onerror=");
    // Label, model and last-test detail: each shown as text.
    expect(html.match(/&lt;img src=x onerror=/g)).toHaveLength(3);
  });
});
