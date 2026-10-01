/**
 * Model row on built-in provider cards and custom GEO engines in the Integrations page: pure helpers and
 * server-rendered markup (no DOM, no live calls). Model ids and names are untrusted plain text.
 */
import { createElement as h, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CustomProviderStatus, CustomProvidersResponse, IntegrationsStatus } from "@shared/types";
import {
  COHORT_NOTE,
  CUSTOM_GEO_NOTE,
  UNKNOWN_RATE_NOTE,
  filterModelOptions,
  geoEngines,
  hasWorkspaceSelection,
  isModelSelectable,
  modelInputError,
  modelSourceText,
  modelSummary,
  mustSupportNote,
  operatorKeyHint,
  rateNote,
  toOptions,
  writerProviders,
} from "@web/pages/integrations/model-lib";
import {
  CUSTOM_CITATION_NOT_MEASURED,
  CUSTOM_LANE_BODY_NOTE,
  LABELS,
  apiSampledTipFor,
  engineGlyph,
  engineName,
  isCustomEngine,
  lanesApiSampledTip,
  mentionStatText,
} from "@web/pages/geo/board/lib";
import { readyLane } from "./geo-batch-board-fixtures";
import { activity, item } from "./activity-web-fixtures";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type FC = (props: any) => ReactElement | null;
const load = async <T,>(rel: string): Promise<T> => (await import(/* @vite-ignore */ rel)) as T;
const model = await load<Record<"ProviderModelRow", FC>>("../src/web/pages/integrations/ProviderModel.tsx");
const integrations = await load<Record<"ProviderRow", FC>>("../src/web/pages/Integrations.tsx");
const writer = await load<Record<"ModelPicker" | "CustomProviderForm" | "SavedProviderItem", FC>>("../src/web/pages/integrations/CustomWriter.tsx");
const geo = await load<Record<"CustomGeoEngines", FC>>("../src/web/pages/integrations/CustomGeo.tsx");
const board = await load<Record<"EngineColumn", FC>>("../src/web/pages/geo/board/EngineColumn.tsx");
const header = await load<Record<"LaneHeader", FC>>("../src/web/pages/geo/board/LaneHeader.tsx");
const activityView = await load<Record<"Lanes" | "FeedItem", FC>>("../src/web/components/activity/ActivityView.tsx");

const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/\s+/g, " ");
const buttons = (html: string) => [...html.matchAll(/<button\b[^>]*>([\s\S]*?)<\/button>/g)].map((m) => text(m[1]!).trim());
const noop = () => {};

type ProviderStatus = IntegrationsStatus["providers"][number];
const status = (over: Partial<ProviderStatus> = {}): ProviderStatus => ({
  provider: "openai_geo",
  label: "OpenAI (AI engine, web search)",
  source: "workspace_key",
  keyHint: "abcd",
  state: "ready",
  lastTestedAt: null,
  lastTestOk: null,
  lastTestDetail: null,
  model: "gpt-5.5",
  modelSource: "workspace",
  rateKnown: false,
  dataSent: "Prompts.",
  ...over,
});

const custom = (over: Partial<CustomProviderStatus> = {}): CustomProviderStatus => ({
  id: "cprov_g",
  role: "geo",
  label: "My gateway",
  baseUrl: "https://llm.example.com/v1",
  host: "llm.example.com",
  model: "meta/llama-3.3-70b",
  keyHint: "WXYZ",
  isWriter: false,
  lastTestedAt: null,
  lastTestOk: null,
  lastTestDetail: null,
  createdAt: "2026-09-30T12:00:00.000Z",
  updatedAt: "2026-09-30T12:00:00.000Z",
  ...over,
});

describe("model-lib helpers", () => {
  it("knows which providers have a model row", () => {
    expect(["gemini", "perplexity", "openai_geo", "anthropic_geo"].every(isModelSelectable)).toBe(true);
    // "TypeSafe will perform as it is": no model picker on the TypeSafe card.
    expect(isModelSelectable("typesafe")).toBe(false);
    expect(isModelSelectable("writer")).toBe(false);
  });

  it("describes the model and its source; no model says choose one", () => {
    expect(modelSourceText("workspace")).toBe("chosen for this workspace");
    expect(modelSourceText("operator")).toBe("operator default");
    expect(modelSourceText(null)).toBe("not chosen");
    expect(modelSummary({ model: "gpt-5.5", modelSource: "operator" })).toBe("gpt-5.5 (operator default)");
    expect(modelSummary({ model: null, modelSource: null })).toMatch(/No model chosen/);
  });

  it("notes an unknown rate only for GEO engines with a model, and the feature the model must support", () => {
    expect(rateNote({ provider: "openai_geo", model: "x", rateKnown: false })).toBe(UNKNOWN_RATE_NOTE);
    expect(rateNote({ provider: "openai_geo", model: "x", rateKnown: true })).toBeNull();
    expect(rateNote({ provider: "typesafe", model: "x", rateKnown: false })).toBeNull();
    expect(rateNote({ provider: "gemini", model: null, rateKnown: false })).toBeNull();
    expect(mustSupportNote("the Responses API web_search tool")).toBe("Must support the Responses API web_search tool; the Test run will tell you.");
    expect(mustSupportNote(null)).toBeNull();
  });

  it("filters options by id or label; validates typed ids", () => {
    const opts = [
      { id: "claude-opus-5", label: "Claude Opus 5 (claude-opus-5)" },
      { id: "gemini-3.8-flash", label: "Gemini 3.8 Flash (gemini-3.8-flash)" },
    ];
    expect(filterModelOptions(opts, "opus").shown.map((o) => o.id)).toEqual(["claude-opus-5"]);
    expect(filterModelOptions(opts, "FLASH 3.8").matched).toBe(1);
    expect(filterModelOptions(opts, "").matched).toBe(2);
    expect(toOptions(["a"])).toEqual([{ id: "a", label: "a" }]);
    expect(modelInputError("")).toMatch(/Choose a model/);
    expect(modelInputError("a".repeat(201))).toMatch(/200/);
    expect(modelInputError("ok")).toBeNull();
  });

  it("splits custom providers by role (rows without a role are writers)", () => {
    const data = { providers: [custom(), custom({ id: "w1", role: "writer" }), custom({ id: "w0", role: undefined })] } as CustomProvidersResponse;
    expect(geoEngines(data).map((p) => p.id)).toEqual(["cprov_g"]);
    expect(writerProviders(data).map((p) => p.id)).toEqual(["w1", "w0"]);
  });

  it("names custom board lanes without inventing a vendor", () => {
    expect(isCustomEngine("custom_geo:abc")).toBe(true);
    expect(engineName("custom_geo:abc")).toBe("Custom engine");
    expect(engineGlyph("custom_geo:abc")).toBe("C");
    expect(engineName("gemini")).toBe("Gemini");
  });
});

describe("ProviderModelRow markup", () => {
  it("shows the model, where it comes from, the unknown-rate note and the cohort note", () => {
    const html = renderToStaticMarkup(h(model.ProviderModelRow, { workspaceId: "ws1", p: status(), onChange: noop }));
    const t = text(html);
    expect(t).toContain("Model");
    expect(t).toContain("gpt-5.5");
    expect(t).toContain("(chosen for this workspace)");
    expect(t).toContain(UNKNOWN_RATE_NOTE);
    expect(t).toContain(COHORT_NOTE);
    expect(buttons(html)).toEqual(["Change model", "Use operator default"]);
  });

  it("without a model it asks to choose one", () => {
    const none = text(renderToStaticMarkup(h(model.ProviderModelRow, { workspaceId: "ws1", p: status({ model: null, modelSource: null, rateKnown: null }), onChange: noop })));
    expect(none).toContain("No model chosen: choose one to use this provider.");
    expect(none).toContain("Choose a model");
  });

  it("the TypeSafe card is unchanged: model shown in its summary line, no model row, no model buttons", () => {
    const ts = status({ provider: "typesafe", label: "TypeSafe (Jev decisions)", source: "operator_key", keyHint: null, model: "jev-latest", modelSource: "default", rateKnown: null });
    const html = renderToStaticMarkup(h(integrations.ProviderRow, { workspaceId: "ws1", p: ts, onChange: noop }));
    const t = text(html);
    expect(t).toContain("· model jev-latest");
    expect(buttons(html)).toEqual(["Save key", "Test saved key"]);
    for (const banned of ["Change model", "Choose a model", "Fetch models", "Use operator default", "documented default alias", COHORT_NOTE, UNKNOWN_RATE_NOTE]) {
      expect(t, banned).not.toContain(banned);
    }
    // A GEO engine card keeps its model row (and drops the model from the summary line).
    const engine = renderToStaticMarkup(h(integrations.ProviderRow, { workspaceId: "ws1", p: status(), onChange: noop }));
    expect(buttons(engine)).toContain("Change model");
    expect(text(engine)).not.toContain("· model gpt-5.5");
  });

  it("renders a hostile model id as plain text", () => {
    const html = renderToStaticMarkup(h(model.ProviderModelRow, { workspaceId: "ws1", p: status({ model: '<img src=x onerror="alert(1)">' }), onChange: noop }));
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;img");
  });

  it("the picker shows provider display names as labels with ids as values", () => {
    const html = renderToStaticMarkup(
      h(writer.ModelPicker, { id: "mp", list: { models: [{ id: "claude-opus-5", label: "Claude Opus 5 (claude-opus-5)" }], total: 1, truncated: false }, value: "", onChange: noop }),
    );
    expect(html).toContain('<option value="claude-opus-5">Claude Opus 5 (claude-opus-5)</option>');
  });
});

describe("custom GEO engine markup", () => {
  it("the add form saves a custom GEO engine (never 'use as writer')", () => {
    const html = renderToStaticMarkup(h(writer.CustomProviderForm, { workspaceId: "ws1", initial: null, onSaved: noop, onCancel: noop, role: "geo" }));
    const t = text(html);
    expect(t).toContain("Custom GEO engine (OpenAI-compatible)");
    expect(buttons(html)).toEqual(["Fetch models", "Save custom GEO engine", "Cancel"]);
    expect(t).not.toContain("use as writer");
  });

  it("a saved GEO engine is labelled and offers no 'Use as writer'", () => {
    const html = renderToStaticMarkup(h(writer.SavedProviderItem, { workspaceId: "ws1", p: custom(), canManage: true, apply: noop, reload: noop, onEdit: noop }));
    const t = text(html);
    expect(t).toContain(CUSTOM_GEO_NOTE);
    expect(buttons(html)).toEqual(["Test", "Change model", "Quick update URL", "Edit URL or key", "Remove"]);
  });

  it("the section explains the lane before data loads", () => {
    const t = text(renderToStaticMarkup(h(geo.CustomGeoEngines, { workspaceId: "ws1" })));
    expect(t).toContain("Custom GEO engines");
    expect(t).toContain(CUSTOM_GEO_NOTE);
    expect(t).toContain("never citation rate");
    expect(t).toContain("At most 2 per workspace");
  });
});

describe("model row: operator-key guard", () => {
  const MSG = "OpenAI model gpt-unpriced-test has no verified price and this workspace uses the operator key; add your own OpenAI key to use it.";

  it("shows why a workspace model cannot run on the operator key, and keeps it resettable", () => {
    const html = renderToStaticMarkup(
      h(model.ProviderModelRow, {
        workspaceId: "ws1",
        p: status({ source: "operator_key", state: "setup_required", model: "gpt-unpriced-test", workspaceModel: "gpt-unpriced-test", modelNote: MSG }),
        onChange: noop,
      }),
    );
    const t = text(html);
    expect(t).toContain(MSG);
    expect(t).toContain(UNKNOWN_RATE_NOTE);
    expect(buttons(html)).toEqual(["Change model", "Use operator default"]);
  });

  it("a selection not in effect can still be reset", () => {
    const p = status({ provider: "gemini", source: "operator_key", model: "gemini-env", modelSource: "operator", workspaceModel: "gemini-unpriced-x", modelNote: "ignored", rateKnown: true });
    expect(hasWorkspaceSelection(p)).toBe(true);
    expect(hasWorkspaceSelection(status({ modelSource: "operator", workspaceModel: null }))).toBe(false);
    const html = renderToStaticMarkup(h(model.ProviderModelRow, { workspaceId: "ws1", p, onChange: noop }));
    expect(buttons(html)).toEqual(["Change model", "Use operator default"]);
    expect(text(html)).toContain("ignored");
  });

  it("explains the operator-key rule in the form (never with the workspace's own key)", () => {
    expect(operatorKeyHint({ provider: "gemini", source: "operator_key" })).toMatch(/only models with a verified price/);
    expect(operatorKeyHint({ provider: "typesafe", source: "operator_key" })).toBeNull(); // no model row on TypeSafe
    expect(operatorKeyHint({ provider: "gemini", source: "workspace_key" })).toBeNull();
    expect(operatorKeyHint({ provider: "writer", source: "operator_key" })).toBeNull();
  });
});

describe("AI engines board: a custom GEO lane", () => {
  const customLane = () =>
    readyLane({
      provider: "custom_geo:cprov_g",
      label: `My gateway (llm.example.com) · ${CUSTOM_GEO_NOTE}`,
      model: "meta/llama-3.3-70b",
      groundingMode: "none (custom provider)",
      counts: { valid: 4, grounded: 0, failed: 0, incomplete: 0 },
      promptsRun: 4,
      citationRate: { numerator: 0, denominator: 0, value: null },
      mentionRate: { numerator: 3, denominator: 4, value: 0.75 },
      answersCitingUs: 0,
      answersSkippingUs: 1,
      citedInstead: null,
      searchQueries: { state: "not_exposed", count: null },
      costUsd: { value: null, isEstimate: true },
      feed: [
        { promptId: "p1", promptText: "Best brass knobs?", observationId: "o1", status: "named", position: null, sentiment: null, latencyMs: 900, grounded: false, citedInstead: null, observedAt: "2026-09-30T10:00:00Z" },
        { promptId: "p2", promptText: "Brass pulls?", observationId: "o2", status: "missing", position: null, sentiment: null, latencyMs: 800, grounded: false, citedInstead: null, observedAt: "2026-09-30T10:00:00Z" },
      ],
    } as never);
  const listState = <T,>(data: T) => ({ data, error: null, loading: false, reload: () => {} });
  const column = (compact: boolean) =>
    renderToStaticMarkup(
      h(
        MemoryRouter,
        null,
        h(board.EngineColumn, {
          projectId: "proj1",
          lane: customLane(),
          compact,
          defaultOpen: true,
          competitors: listState([]),
          plans: listState([]),
          skipInputs: { coverage: null, pages: null, loading: false, error: null, reload: () => {} },
          onNeedSkipInputs: () => {
            throw new Error("a custom lane must never ask for skip-factor inputs");
          },
          onApproved: () => {},
        }),
      ),
    );
  afterEach(() => vi.unstubAllGlobals());

  for (const compact of [false, true]) {
    it(`${compact ? "mobile" : "desktop"}: only the prompt feed and the note; no citation sections, no gauge, no skip-factor request`, () => {
      const fetchSpy = vi.fn(async () => new Response("{}"));
      vi.stubGlobal("fetch", fetchSpy);
      const html = column(compact);
      const t = text(html);
      expect(t).toContain("prompts answered by Custom engine");
      expect(t).toContain("Best brass knobs?");
      expect(t).toContain(CUSTOM_LANE_BODY_NOTE);
      expect(t).toContain(CUSTOM_CITATION_NOT_MEASURED);
      expect(t).toContain("Named in 3 of 4");
      expect(t).toContain(CUSTOM_GEO_NOTE);
      for (const banned of ["no valid answers", "skips you: your pages, measured", "Pages Custom engine cites", "Pages to rewrite for Custom engine", "Answers citing us", "Cited instead", "Our pages", "Cited pages", "Plans"]) {
        expect(t, banned).not.toContain(banned);
      }
      expect(html).not.toContain('role="img"'); // no citation gauge
      expect(html).not.toContain(LABELS.apiSampledTip.replace(/'/g, "&#x27;"));
      expect(html).toContain(LABELS.customApiSampledTip.replace(/'/g, "&#x27;"));
      expect(html).not.toContain("engine=custom_geo");
      expect(fetchSpy.mock.calls.map((c) => String((c as unknown[])[0]))).not.toContainEqual(expect.stringContaining("engine=custom_geo"));
    });
  }

  it("the header without metrics (not ready) still uses the custom tooltip; built-in lanes keep the web-search one", () => {
    const custom = renderToStaticMarkup(h(header.LaneHeader, { lane: customLane(), showMetrics: false }));
    expect(custom).toContain(LABELS.customApiSampledTip.replace(/'/g, "&#x27;"));
    const builtIn = renderToStaticMarkup(h(header.LaneHeader, { lane: readyLane(), showMetrics: true }));
    expect(builtIn).toContain(LABELS.apiSampledTip.replace(/'/g, "&#x27;"));
    expect(text(builtIn)).toContain("Answers citing us");
  });

  it("helpers: tooltip per lane, mention stat, lane groups", () => {
    expect(apiSampledTipFor("custom_geo:x")).toBe(LABELS.customApiSampledTip);
    expect(apiSampledTipFor("gemini")).toBe(LABELS.apiSampledTip);
    expect(apiSampledTipFor(null)).toBe(LABELS.apiSampledTip);
    expect(LABELS.customApiSampledTip).toContain("without web search");
    expect(mentionStatText({ numerator: 3, denominator: 4, value: 0.75 })).toBe("Named in 3 of 4");
    expect(mentionStatText({ numerator: 0, denominator: 0, value: null })).toBe("Unavailable (no valid answers)");
    expect(lanesApiSampledTip([{ provider: "gemini" }])).toBe(LABELS.apiSampledTip);
    expect(lanesApiSampledTip([{ provider: "custom_geo:a" }])).toBe(LABELS.customApiSampledTip);
    expect(lanesApiSampledTip([{ provider: "gemini" }, { provider: "custom_geo:a" }])).toContain("Custom engines: Answers from the custom provider's API, without web search");
  });
});

describe("activity window: custom lanes are not described as web search", () => {
  it("the lanes section and a custom engine answer carry the custom tooltip", () => {
    const lanes = [
      { provider: "custom_geo:cprov_g", label: `My gateway (llm.example.com) · ${CUSTOM_GEO_NOTE}`, state: "done", done: 2, planned: 2, lastLatencyMs: 800 },
    ];
    const html = renderToStaticMarkup(h(MemoryRouter, null, h(activityView.Lanes, { lanes, items: [], activity: activity({ lanes } as never) })));
    expect(html).toContain(`title="${LABELS.customApiSampledTip.replace(/'/g, "&#x27;")}"`);
    expect(html).not.toContain(LABELS.apiSampledTip.replace(/'/g, "&#x27;"));
    const answer = renderToStaticMarkup(h(activityView.FeedItem, { item: item({ provider: "custom_geo:cprov_g", title: "Custom engine answered" }) }));
    expect(answer).toContain(LABELS.customApiSampledTip.replace(/'/g, "&#x27;"));
    const builtIn = renderToStaticMarkup(h(activityView.FeedItem, { item: item() }));
    expect(builtIn).toContain(LABELS.apiSampledTip.replace(/'/g, "&#x27;"));
  });
});
