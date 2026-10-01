/**
 * Writer card, custom (OpenAI-compatible) provider flow: pure helpers and server-rendered markup (no DOM,
 * no live calls). Model ids from a provider's /models list are untrusted and must render as plain text.
 */
import { createElement as h, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { CustomProviderChange, CustomProviderModelList, CustomProviderStatus, CustomProvidersResponse, IntegrationsStatus } from "@shared/types";
import {
  MODEL_OPTIONS_SHOWN,
  TUNNEL_NAME_NOTE,
  activeCustomWriter,
  activeWriterChanged,
  baseUrlInputError,
  defaultWriterName,
  editPatchBody,
  fieldErrorFor,
  filterModels,
  hostChangeGate,
  isFieldError,
  latestUrlChange,
  modelNotListed,
  newHostFor,
  newProviderBody,
  quickUrlPatchBody,
  retestIdAfterSave,
  sendSavedKeyLabel,
  testOutcomeText,
  typedHost,
  urlChangeSummary,
} from "@web/pages/integrations/custom-writer-lib";

// Web .tsx modules load dynamically (test tsconfig has no JSX); Vitest transforms them at runtime.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type FC = (props: any) => ReactElement | null;
const load = async <T,>(rel: string): Promise<T> => (await import(/* @vite-ignore */ rel)) as T;
const ui = await load<Record<"WriterProviderRow" | "ModelPicker" | "CustomProviderForm" | "SavedProviderItem" | "QuickUrlUpdate" | "SendSavedKeyConfirm", FC>>(
  "../src/web/pages/integrations/CustomWriter.tsx",
);
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
    expect(buttons(html)).toEqual(["Test", "Change model", "Quick update URL", "Edit URL or key", "Remove"]);
    expect(buttons(html)).not.toContain("Use as writer");
  });

  it("owner, saved but not the writer: offers 'Use as writer'", () => {
    const html = renderToStaticMarkup(h(ui.SavedProviderItem, { workspaceId: "ws1", p: saved({ isWriter: false }), canManage: true, apply: noop, reload: noop, onEdit: noop }));
    expect(buttons(html)).toEqual(["Test", "Use as writer", "Change model", "Quick update URL", "Edit URL or key", "Remove"]);
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

// ------------------------------------------------------------------ base URL on a new host (tunnels)
const TUNNEL = "https://abc-def-123.trycloudflare.com/v1";
const TUNNEL_HOST = "abc-def-123.trycloudflare.com";
/** The checkbox <input> tags of the markup. */
const checkboxes = (html: string) => inputs(html).filter((i) => i.includes('type="checkbox"'));
const isDisabled = (html: string, label: string) => new RegExp(`<button[^>]*disabled=""[^>]*>(?:<[^>]+>)*${label}</button>`).test(html);
const change = (over: Partial<CustomProviderChange> = {}): CustomProviderChange => ({
  at: "2026-10-01T09:30:00.000Z",
  by: "Test User",
  fields: ["baseUrl"],
  fromBaseUrl: "https://llm.example.com/v1",
  toBaseUrl: TUNNEL,
  fromHost: "llm.example.com",
  toHost: TUNNEL_HOST,
  keyKeptForNewHost: true,
  ...over,
});

describe("host change helpers", () => {
  it("parses the typed host and compares it with the saved host", () => {
    expect(typedHost(" https://ABC-def-123.TryCloudflare.com./v1 ")).toBe(TUNNEL_HOST);
    expect(typedHost("not a url")).toBeNull();
    expect(typedHost("")).toBeNull();
    expect(newHostFor("llm.example.com", TUNNEL)).toBe(TUNNEL_HOST);
    expect(newHostFor("llm.example.com", "https://llm.example.com/v2")).toBeNull(); // same host, other path
    expect(newHostFor("llm.example.com", "https://LLM.example.com/v1")).toBeNull();
    expect(newHostFor("llm.example.com", "garbage")).toBeNull();
    expect(newHostFor(null, TUNNEL)).toBeNull(); // add form: nothing saved yet
  });

  it("gates Save: a new host needs the ticked box for that exact host, or a new key", () => {
    const base = { savedHost: "llm.example.com", typedBaseUrl: TUNNEL, typedKey: "", confirmedHost: null };
    expect(hostChangeGate(base)).toEqual({
      newHost: TUNNEL_HOST,
      needsConfirm: true,
      confirmed: false,
      canSave: false,
      blockedReason: `Tick "Send my saved key to ${TUNNEL_HOST}" or enter a new API key for it.`,
    });
    expect(hostChangeGate({ ...base, confirmedHost: TUNNEL_HOST })).toMatchObject({ needsConfirm: true, confirmed: true, canSave: true, blockedReason: null });
    // A confirmation never carries over to another host.
    expect(hostChangeGate({ ...base, typedBaseUrl: "https://my-gpu.loca.lt/v1", confirmedHost: TUNNEL_HOST })).toMatchObject({ newHost: "my-gpu.loca.lt", confirmed: false, canSave: false });
    // A new key replaces the confirmation.
    expect(hostChangeGate({ ...base, typedKey: "sk-new-key-1234" })).toMatchObject({ newHost: TUNNEL_HOST, needsConfirm: false, canSave: true });
    // Same host (path change) or unchanged: nothing to confirm.
    expect(hostChangeGate({ ...base, typedBaseUrl: "https://llm.example.com/api/v1" })).toMatchObject({ newHost: null, needsConfirm: false, canSave: true });
    expect(sendSavedKeyLabel("my-gpu.loca.lt")).toBe("Send my saved key to my-gpu.loca.lt");
  });

  it("offers Change model only when a successful test says the saved model is not listed", () => {
    expect(modelNotListed({ ok: true, detail: "", modelListed: false })).toBe(true);
    expect(modelNotListed({ ok: true, detail: "", modelListed: true })).toBe(false);
    expect(modelNotListed({ ok: true, detail: "", modelListed: null })).toBe(false);
    expect(modelNotListed({ ok: false, detail: "", modelListed: false })).toBe(false);
    expect(modelNotListed(null)).toBe(false);
  });

  it("summarises the latest URL change in plain text", () => {
    expect(latestUrlChange({ changes: [change({ fields: ["model"], fromHost: null, toHost: null, fromBaseUrl: null, toBaseUrl: null }), change()] })).toMatchObject({ toHost: TUNNEL_HOST });
    expect(latestUrlChange({ changes: [] })).toBeNull();
    expect(latestUrlChange({})).toBeNull();
    expect(urlChangeSummary(change())).toBe(`llm.example.com → ${TUNNEL_HOST} · saved key kept · by Test User`);
    expect(urlChangeSummary(change({ keyKeptForNewHost: false, fields: ["baseUrl", "apiKey"], by: null }))).toBe(`llm.example.com → ${TUNNEL_HOST} · new key`);
    expect(urlChangeSummary(change({ fromHost: "llm.example.com", toHost: "llm.example.com", toBaseUrl: "https://llm.example.com/v2", keyKeptForNewHost: false }))).toBe(
      "https://llm.example.com/v1 → https://llm.example.com/v2 · by Test User",
    );
  });
});

describe("Edit URL or key: a base URL on a new host", () => {
  it("shows the required, unchecked 'Send my saved key to <new host>' box and disables Save until it is ticked", () => {
    const html = renderToStaticMarkup(h(ui.CustomProviderForm, { workspaceId: "ws1", initial: saved(), initialBaseUrl: TUNNEL, onSaved: noop, onCancel: noop }));
    const t = text(html);
    expect(inputs(html).find((i) => i.includes('type="url"'))).toContain(`value="${TUNNEL}"`);
    const boxes = checkboxes(html);
    expect(boxes).toHaveLength(1);
    expect(boxes[0]).not.toContain("checked");
    expect(boxes[0]).toContain('required=""');
    expect(t).toContain(`Send my saved key to ${TUNNEL_HOST}`);
    expect(t).toContain("Your saved key (…QRST) is sent there only if you tick this box");
    expect(isDisabled(html, "Save changes")).toBe(true);
    expect(t).toContain(`Tick "Send my saved key to ${TUNNEL_HOST}" or enter a new API key for it.`);
    const key = inputs(html).find((i) => i.includes('type="password"'))!;
    expect(key).toContain(`placeholder="New key for ${TUNNEL_HOST}"`);
    expect(t).not.toContain("Leave empty to keep the saved key.");
  });

  it("the same flow applies to a custom GEO engine", () => {
    const html = renderToStaticMarkup(h(ui.CustomProviderForm, { workspaceId: "ws1", role: "geo", initial: saved({ role: "geo", isWriter: false }), initialBaseUrl: "https://my-gpu.loca.lt/v1", onSaved: noop }));
    expect(text(html)).toContain("Send my saved key to my-gpu.loca.lt");
    expect(isDisabled(html, "Save changes")).toBe(true);
  });

  it("no box and Save enabled when the host is unchanged (path change) or the form is unchanged", () => {
    for (const initialBaseUrl of ["https://llm.example.com/api/v2", undefined]) {
      const html = renderToStaticMarkup(h(ui.CustomProviderForm, { workspaceId: "ws1", initial: saved(), initialBaseUrl, onSaved: noop }));
      expect(checkboxes(html)).toHaveLength(0);
      expect(isDisabled(html, "Save changes")).toBe(false);
      expect(text(html)).toContain("Leave empty to keep the saved key.");
    }
    // The add form never shows it (nothing is saved yet) and ignores a prefill.
    const add = renderToStaticMarkup(h(ui.CustomProviderForm, { workspaceId: "ws1", initial: null, initialBaseUrl: TUNNEL, onSaved: noop }));
    expect(checkboxes(add)).toHaveLength(0);
    expect(inputs(add).find((i) => i.includes('type="url"'))).toContain('value=""');
  });

  it("the confirmation renders checked when ticked", () => {
    const html = renderToStaticMarkup(h(ui.SendSavedKeyConfirm, { id: "k", host: TUNNEL_HOST, keyHint: "QRST", checked: true, onChange: noop }));
    expect(checkboxes(html)[0]).toContain('checked=""');
    expect(text(html)).toContain(`Send my saved key to ${TUNNEL_HOST}`);
  });
});

describe("Quick update URL", () => {
  it("is an inline action on the saved card for owners only", () => {
    const owner = renderToStaticMarkup(h(ui.SavedProviderItem, { workspaceId: "ws1", p: saved(), canManage: true, apply: noop, reload: noop, onEdit: noop }));
    expect(buttons(owner)).toContain("Quick update URL");
    const member = renderToStaticMarkup(h(ui.SavedProviderItem, { workspaceId: "ws1", p: saved(), canManage: false, apply: noop, reload: noop, onEdit: noop }));
    expect(buttons(member)).not.toContain("Quick update URL");
  });

  it("just the URL field, the box (unchecked, required) on a new host, Save disabled until ticked, and a way to enter a new key", () => {
    const html = renderToStaticMarkup(h(ui.QuickUrlUpdate, { workspaceId: "ws1", p: saved(), initialUrl: TUNNEL, onSaved: noop, onCancel: noop, onUseNewKey: noop }));
    const t = text(html);
    expect(t).toContain("New base URL");
    expect(inputs(html).filter((i) => !i.includes('type="checkbox"'))).toHaveLength(1); // no key, model or name fields
    expect(inputs(html).some((i) => i.includes('type="password"'))).toBe(false);
    const boxes = checkboxes(html);
    expect(boxes).toHaveLength(1);
    expect(boxes[0]).not.toContain("checked");
    expect(boxes[0]).toContain('required=""');
    expect(t).toContain(`Send my saved key to ${TUNNEL_HOST}`);
    expect(buttons(html)).toEqual(["Save URL", "Cancel", "Enter a new key instead"]);
    expect(isDisabled(html, "Save URL")).toBe(true);
  });

  it("unchanged URL: Save disabled, no box; same host with a new path: Save enabled, no box", () => {
    const same = renderToStaticMarkup(h(ui.QuickUrlUpdate, { workspaceId: "ws1", p: saved(), onSaved: noop, onCancel: noop }));
    expect(inputs(same).find((i) => i.includes('type="url"'))).toContain('value="https://llm.example.com/v1"');
    expect(checkboxes(same)).toHaveLength(0);
    expect(isDisabled(same, "Save URL")).toBe(true);
    expect(buttons(same)).toEqual(["Save URL", "Cancel"]);
    const path = renderToStaticMarkup(h(ui.QuickUrlUpdate, { workspaceId: "ws1", p: saved(), initialUrl: "https://llm.example.com/api/v1", onSaved: noop, onCancel: noop }));
    expect(checkboxes(path)).toHaveLength(0);
    expect(isDisabled(path, "Save URL")).toBe(false);
  });

  it("the saved card shows when the URL last changed and by whom, as plain text", () => {
    const hostile = '<img src=x onerror="alert(1)">';
    const html = renderToStaticMarkup(
      h(ui.SavedProviderItem, { workspaceId: "ws1", p: saved({ baseUrl: TUNNEL, host: TUNNEL_HOST, changes: [change({ by: hostile })] }), canManage: true, apply: noop, reload: noop, onEdit: noop }),
    );
    const t = text(html);
    expect(t).toContain("URL changed");
    expect(t).toContain(`llm.example.com → ${TUNNEL_HOST} · saved key kept · by`);
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;img src=x onerror=");
    // No change recorded: no row.
    expect(text(renderToStaticMarkup(h(ui.SavedProviderItem, { workspaceId: "ws1", p: saved(), canManage: true, apply: noop, reload: noop, onEdit: noop })))).not.toContain("URL changed");
  });
});

describe("request bodies and re-test decision (pure helpers used by both forms)", () => {
  const p = saved();
  const KEY = "sk-new-key-for-the-tunnel-1234";

  it("Quick update URL: keepKeyForNewHost only when the box is ticked for exactly the typed new host", () => {
    expect(quickUrlPatchBody(p, ` ${TUNNEL} `, TUNNEL_HOST)).toEqual({ baseUrl: TUNNEL, keepKeyForNewHost: true });
    // Not ticked.
    expect(quickUrlPatchBody(p, TUNNEL, null)).toEqual({ baseUrl: TUNNEL });
    // Ticked for another host (the owner then changed the URL again): never carried over.
    expect(quickUrlPatchBody(p, "https://my-gpu.loca.lt/v1", TUNNEL_HOST)).toEqual({ baseUrl: "https://my-gpu.loca.lt/v1" });
    // Same host (another path): nothing to confirm, the flag is never sent.
    expect(quickUrlPatchBody(p, "https://llm.example.com/api/v1", "llm.example.com")).toEqual({ baseUrl: "https://llm.example.com/api/v1" });
    // Only the URL: no key, model or name.
    expect(Object.keys(quickUrlPatchBody(p, TUNNEL, TUNNEL_HOST)).sort()).toEqual(["baseUrl", "keepKeyForNewHost"]);
  });

  it("Edit URL or key: the flag only with the ticked box and no typed key; a typed key is sent instead", () => {
    const edit = (over: Partial<Parameters<typeof editPatchBody>[0]> = {}) =>
      editPatchBody({ initial: p, baseUrl: TUNNEL, apiKey: "", model: p.model, label: p.label, confirmedHost: TUNNEL_HOST, ...over });
    expect(edit()).toEqual({ baseUrl: TUNNEL, model: "meta/llama-3.3-70b", keepKeyForNewHost: true });
    expect(edit({ confirmedHost: null })).toEqual({ baseUrl: TUNNEL, model: "meta/llama-3.3-70b" });
    expect(edit({ confirmedHost: "my-gpu.loca.lt" })).not.toHaveProperty("keepKeyForNewHost");
    // A typed key replaces the confirmation: the key is sent, never the flag (even if the box was ticked before).
    expect(edit({ apiKey: ` ${KEY} ` })).toEqual({ baseUrl: TUNNEL, model: "meta/llama-3.3-70b", apiKey: KEY });
    // Same host or unchanged URL: never the flag.
    expect(edit({ baseUrl: "https://llm.example.com/api/v1", confirmedHost: "llm.example.com" })).not.toHaveProperty("keepKeyForNewHost");
    expect(edit({ baseUrl: p.baseUrl })).toEqual({ baseUrl: p.baseUrl, model: "meta/llama-3.3-70b" });
  });

  it("Edit URL or key: the name is sent only when the owner changed it (so a default name can follow the host)", () => {
    const base = { initial: p, baseUrl: p.baseUrl, apiKey: "", model: ` ${p.model} `, confirmedHost: null };
    expect(editPatchBody({ ...base, label: "My gateway" })).not.toHaveProperty("label");
    expect(editPatchBody({ ...base, label: "  My gateway " })).not.toHaveProperty("label");
    expect(editPatchBody({ ...base, label: "" })).not.toHaveProperty("label");
    expect(editPatchBody({ ...base, label: " GPU box " })).toEqual({ baseUrl: p.baseUrl, model: p.model, label: "GPU box" });
    // A provider named after its old host: the unchanged name is not sent.
    const hostNamed = saved({ label: "llm.example.com" });
    expect(editPatchBody({ ...base, initial: hostNamed, baseUrl: TUNNEL, label: "llm.example.com", confirmedHost: TUNNEL_HOST })).toEqual({
      baseUrl: TUNNEL,
      model: p.model,
      keepKeyForNewHost: true,
    });
  });

  it("add form: writer rows are selected as the writer, GEO rows get role geo; never the flag", () => {
    const fields = { baseUrl: ` ${TUNNEL} `, apiKey: ` ${KEY} `, model: "m", label: "" };
    expect(newProviderBody({ role: "writer", ...fields })).toEqual({ baseUrl: TUNNEL, apiKey: KEY, model: "m", useAsWriter: true });
    expect(newProviderBody({ role: "geo", ...fields, label: " Lane " })).toEqual({ baseUrl: TUNNEL, apiKey: KEY, model: "m", label: "Lane", role: "geo" });
  });

  it("Test re-runs after a URL or key change, not after a model- or name-only edit, and not for a new provider", () => {
    expect(retestIdAfterSave(p, TUNNEL, "")).toBe(p.id);
    expect(retestIdAfterSave(p, "https://llm.example.com/api/v1", "")).toBe(p.id); // same host, other path
    expect(retestIdAfterSave(p, p.baseUrl, KEY)).toBe(p.id);
    expect(retestIdAfterSave(p, ` ${p.baseUrl} `, "  ")).toBeNull(); // model or name only
    expect(retestIdAfterSave(null, TUNNEL, KEY)).toBeNull();
  });

  it("the writer card leaves the Custom panel only when the active writer changed", () => {
    const resp = (providers: CustomProviderStatus[]): CustomProvidersResponse => ({
      providers,
      writerSource: "default",
      maxProviders: 5,
      canManage: true,
      dataSent: "",
      maxGeoEngines: 2,
      geoDataSent: "",
    });
    const a = saved({ id: "a", isWriter: false });
    const b = saved({ id: "b", isWriter: false });
    // No active writer; a saved, unused provider's URL is edited: stay on the panel (auto re-test stays visible).
    expect(activeWriterChanged(resp([a, b]), resp([{ ...a, baseUrl: TUNNEL, host: TUNNEL_HOST }, b]))).toBe(false);
    // The active writer is edited: stay.
    expect(activeWriterChanged(resp([{ ...a, isWriter: true }, b]), resp([{ ...a, isWriter: true, baseUrl: TUNNEL }, b]))).toBe(false);
    // Activated, switched, removed: leave (the radio follows the new active writer).
    expect(activeWriterChanged(resp([a, b]), resp([{ ...a, isWriter: true }, b]))).toBe(true);
    expect(activeWriterChanged(resp([{ ...a, isWriter: true }, b]), resp([a, { ...b, isWriter: true }]))).toBe(true);
    expect(activeWriterChanged(resp([{ ...a, isWriter: true }, b]), resp([b]))).toBe(true);
    expect(activeWriterChanged(null, resp([a]))).toBe(false);
  });
});

describe("claimable tunnel names", () => {
  it("the 'Send my saved key' confirmation warns that runs and Test send the key to the saved host automatically", () => {
    expect(TUNNEL_NAME_NOTE).toMatch(/Runs and Test send the saved key to this host automatically/);
    expect(TUNNEL_NAME_NOTE).toMatch(/\*\.loca\.lt/);
    expect(TUNNEL_NAME_NOTE).toMatch(/update the URL, remove the provider, or rotate the key/);
    const box = text(renderToStaticMarkup(h(ui.SendSavedKeyConfirm, { id: "k", host: "my-gpu.loca.lt", keyHint: "QRST", checked: false, onChange: noop })));
    expect(box).toContain(TUNNEL_NAME_NOTE);
    for (const html of [
      renderToStaticMarkup(h(ui.QuickUrlUpdate, { workspaceId: "ws1", p: saved(), initialUrl: TUNNEL, onSaved: noop, onCancel: noop })),
      renderToStaticMarkup(h(ui.CustomProviderForm, { workspaceId: "ws1", initial: saved(), initialBaseUrl: TUNNEL, onSaved: noop })),
    ]) {
      expect(text(html)).toContain(TUNNEL_NAME_NOTE);
    }
    // Not shown when nothing is confirmed (same host).
    expect(text(renderToStaticMarkup(h(ui.QuickUrlUpdate, { workspaceId: "ws1", p: saved(), onSaved: noop, onCancel: noop })))).not.toContain(TUNNEL_NAME_NOTE);
  });
});
