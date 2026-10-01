/** Contract fixtures for the Activity window web tests (no live calls). */
import type { ActivityItem, RunActivity } from "../src/shared/types";

export function item(over: Partial<ActivityItem> = {}): ActivityItem {
  return {
    id: "obs:1",
    at: "2026-10-01T10:00:05.000Z",
    kind: "engine_answer",
    agent: "geo",
    title: 'Gemini answered: "best linen sofa"',
    detail: "Missing · cited instead: forum.example",
    status: "warn",
    provider: "gemini",
    latencyMs: 227,
    costUsd: 0.0012,
    costIsEstimate: true,
    url: null,
    outcome: "missing",
    ...over,
  };
}

export function activity(over: Partial<RunActivity> = {}): RunActivity {
  return {
    run: {
      id: "run1",
      agent: "geo",
      status: "running",
      trigger: "manual",
      createdAt: "2026-10-01T10:00:00.000Z",
      startedAt: "2026-10-01T10:00:00.000Z",
      finishedAt: null,
      elapsedMs: null,
    },
    active: true,
    totals: {
      spend: { usd: 0.162, isEstimate: true, unknownCalls: 2 },
      providerCalls: 14,
      pagesRead: 0,
      pagesPlanned: null,
      answers: { cited: 3, named: 1, missing: 9, failed: 1 },
      decisions: { act: 2, flag: 1, drop: 4 },
    },
    lanes: [
      { provider: "gemini", label: "Gemini", state: "asking", done: 5, planned: 12, lastLatencyMs: 190 },
      { provider: "perplexity", label: "Perplexity", state: "queued", done: 0, planned: 12, lastLatencyMs: null },
    ],
    queued: [{ provider: "perplexity", label: "Perplexity", promptText: "Where to buy <b>linen</b> sofas" }],
    nowReading: null,
    items: [item()],
    cursor: "c1",
    ...over,
  };
}
