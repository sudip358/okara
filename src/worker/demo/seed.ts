/**
 * Demo seed (DEMO_MODE only, never production). Creates a clearly labelled demo project (is_demo=1)
 * populated with fixture data for every screen. Every string says it is demo data; provider/model
 * are labelled "demo-fixture"; costs are unknown (null), never $0 actual.
 */
import type { Env } from "../env";
import { demoModeEnabled } from "../env";
import type { Db } from "../lib/db";
import { insertStatement } from "../lib/db";
import { HttpError } from "../lib/errors";
import { hashJson } from "../lib/hash";
import { newId } from "../lib/ids";
import { addDays, iso, utcDay } from "../lib/time";
import { cohortKey } from "../geo/cohort";
import type { ProjectRow } from "../platform/access";
import { contextInsertStatement, createProject } from "../platform/projects";
import {
  DEMO_ANSWERS,
  DEMO_BRAND,
  DEMO_FINDINGS,
  DEMO_GSC_ROWS,
  DEMO_LABEL,
  DEMO_MODEL,
  DEMO_ORIGIN,
  DEMO_PAGES,
  DEMO_PROJECT,
  DEMO_PROMPTS,
} from "./fixtures";

type Stmt = [string, ...unknown[]];

/** Deterministic pseudo-random sequence so demo charts are stable. */
function lcg(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 0x1_0000_0000;
  };
}

const GROUNDING: Record<"gemini" | "perplexity", string> = { gemini: "google_search", perplexity: "perplexity_web_search" };

export async function seedDemoProject(env: Env, db: Db, userId: string, now: Date): Promise<ProjectRow> {
  // Defense in depth: the route already 404s, but the seed itself refuses outside demo mode.
  if (!demoModeEnabled(env) || env.ENVIRONMENT === "production") throw new HttpError(404, "not_found", "Not found.");

  const ws = await db.first<{ workspace_id: string }>(
    "SELECT workspace_id FROM memberships WHERE user_id = ? ORDER BY created_at, workspace_id LIMIT 1",
    userId,
  );
  if (!ws) throw new HttpError(404, "not_found", "Workspace not found.");
  const wid = ws.workspace_id;

  const project = await createProject(db, wid, userId, DEMO_PROJECT, now, { isDemo: true, scheduleEnabled: false });
  const pid = project.id;
  const S: Stmt[] = [];
  const ins = (table: string, row: Record<string, unknown>) => S.push(insertStatement(table, row));
  const at = (minutesAgo: number) => iso(new Date(now.getTime() - minutesAgo * 60_000));
  const base = { workspace_id: wid, project_id: pid };

  await db.run("UPDATE projects SET gsc_property = ?, updated_at = ? WHERE workspace_id = ? AND id = ?", "sc-domain:demo.example", iso(now), wid, pid);

  // ------------------------------------------------------------ context: v2 of product with one inferred (unconfirmed) fact
  const productDocId = newId("ctx");
  S.push(
    contextInsertStatement(
      productDocId,
      wid,
      pid,
      "product",
      `${DEMO_PROJECT.productDescription}\nSlipcovers are removable and machine washable. (${DEMO_LABEL})`,
      [
        { id: newId("fact"), text: DEMO_PROJECT.productDescription, confirmed: true, source: "user" },
        { id: newId("fact"), text: `(${DEMO_LABEL}) Slipcovers are removable and machine washable.`, confirmed: false, source: "crawl:demo" },
      ],
      userId,
      at(150),
    ),
  );

  // ------------------------------------------------------------ runs
  const seoRun = newId("run");
  const geoRun = newId("run");
  ins("agent_runs", {
    id: seoRun, ...base, agent: "seo", trigger: "demo", idempotency_key: `demo:${pid}:seo`, status: "completed",
    policy_version: "demo-fixture", summary_json: JSON.stringify({ demo: true, label: DEMO_LABEL, pagesCrawled: 8, gscRows: DEMO_GSC_ROWS.length * 2, recommendations: 2 }),
    created_by: userId, created_at: at(125), started_at: at(125), finished_at: at(118),
  });
  ins("agent_runs", {
    id: geoRun, ...base, agent: "geo", trigger: "demo", idempotency_key: `demo:${pid}:geo`, status: "partial",
    policy_version: "demo-fixture", summary_json: JSON.stringify({ demo: true, label: DEMO_LABEL, observations: 10, failed: 1, recommendations: 2 }),
    created_by: userId, created_at: at(65), started_at: at(65), finished_at: at(58),
  });
  // Step events are timed (minutes ago) to fall after the rows each step produced, so the run's activity
  // replay (runs/activity.ts) reads in order: GSC sync -> page reads -> decisions -> proposals for SEO,
  // engine answers -> analysis -> decisions -> proposals for GEO. All of it is labelled demo data.
  const seoSteps: Array<[string, string, string, number]> = [
    ["validate_project", "completed", "Project validated.", 124.95],
    ["reserve_budget", "completed", "Budget reserved (demo: no real spend).", 124.9],
    ["fetch_gsc", "completed", `Imported ${DEMO_GSC_ROWS.length} query/page rows per 28-day window.`, 123.95],
    ["crawl", "completed", "8 of 8 pages crawled; 0 skipped.", 121.05],
    ["shortlist", "completed", "3 candidates shortlisted.", 120.95],
    ["decisions", "completed", "3 candidates judged; 1 rejected (low_fit).", 120.3],
    ["generate_proposals", "completed", "2 recommendations drafted.", 119.2],
    ["validate_evidence", "completed", "All evidence IDs resolved.", 118.5],
    ["persist_summary", "completed", "Run summary saved.", 118.05],
  ];
  const geoSteps: Array<[string, string, string, number]> = [
    ["validate_project", "completed", "Project validated.", 64.95],
    ["reserve_budget", "completed", "Budget reserved (demo: no real spend).", 64.9],
    ["run_prompts", "partial", "10 prompt runs: 9 ok, 1 failed (simulated timeout).", 59.45],
    ["analyze", "completed", "Brand mentions, citations, and displacements extracted.", 59.4],
    ["decisions", "completed", "3 candidates judged; 1 rejected (insufficient_evidence).", 59.1],
    ["generate_proposals", "completed", "2 proposals drafted.", 58.6],
    ["persist_summary", "completed", "Run summary saved.", 58.1],
  ];
  for (const [step, status, message, minutesAgo] of seoSteps) {
    ins("run_events", { id: newId("evt"), ...base, run_id: seoRun, step, status, message: `[${DEMO_LABEL}] ${message}`, created_at: at(minutesAgo) });
  }
  for (const [step, status, message, minutesAgo] of geoSteps) {
    ins("run_events", { id: newId("evt"), ...base, run_id: geoRun, step, status, message: `[${DEMO_LABEL}] ${message}`, created_at: at(minutesAgo) });
  }

  // ------------------------------------------------------------ GSC: 28-day finalized windows
  const today = utcDay(now);
  const end = addDays(today, -3);
  const start = addDays(end, -27);
  const prevEnd = addDays(start, -1);
  const prevStart = addDays(prevEnd, -27);
  const syncId = newId("gsc");
  const rnd = lcg(42);
  const daily: Array<{ date: string; clicks: number; impressions: number; window: "current" | "previous" }> = [];
  for (let i = 0; i < 56; i++) {
    const date = addDays(prevStart, i);
    const weekday = new Date(`${date}T00:00:00Z`).getUTCDay();
    const weekend = weekday === 0 || weekday === 6 ? 0.8 : 1;
    const trend = i < 28 ? 1 : 1.06;
    const impressions = Math.round((560 + rnd() * 120) * weekend * trend);
    const clicks = Math.round(impressions * (0.018 + rnd() * 0.006));
    daily.push({ date, clicks, impressions, window: date >= start ? "current" : "previous" });
  }
  const sum = (w: "current" | "previous") =>
    daily.filter((x) => x.window === w).reduce((a, x) => ({ clicks: a.clicks + x.clicks, impressions: a.impressions + x.impressions }), { clicks: 0, impressions: 0 });
  const cur = sum("current");
  const prev = sum("previous");
  ins("gsc_syncs", {
    id: syncId, ...base, run_id: seoRun, source: "demo", property: "sc-domain:demo.example",
    window_start: start, window_end: end, prev_window_start: prevStart, prev_window_end: prevEnd, data_state: "final",
    rows_fetched: DEMO_GSC_ROWS.length * 2, row_cap: 5000, truncated: 0,
    totals_json: JSON.stringify({
      current: { clicks: cur.clicks, impressions: cur.impressions, ctr: cur.clicks / cur.impressions, position: 14.2, derivedFrom: "demo_fixture" },
      previous: { clicks: prev.clicks, impressions: prev.impressions, ctr: prev.clicks / prev.impressions, position: 15.1, derivedFrom: "demo_fixture" },
      notes: [`${DEMO_LABEL}: fictional Search Console totals.`],
      provenance: { source: "demo", label: DEMO_LABEL },
    }),
    status: "completed", synced_at: at(124),
  });
  for (const dRow of daily) ins("gsc_daily", { sync_id: syncId, ...base, date: dRow.date, clicks: dRow.clicks, impressions: dRow.impressions });
  for (const [query, path, cc, ci, cp, pc, pi, pp] of DEMO_GSC_ROWS) {
    const page = `${DEMO_ORIGIN}${path}`;
    ins("gsc_metrics", { ...base, sync_id: syncId, window: "current", query, page, device: null, clicks: cc, impressions: ci, ctr: cc / ci, position: cp });
    ins("gsc_metrics", { ...base, sync_id: syncId, window: "previous", query, page, device: null, clicks: pc, impressions: pi, ctr: pc / pi, position: pp });
  }

  // ------------------------------------------------------------ crawl
  const crawlId = newId("crawl");
  ins("crawl_runs", {
    id: crawlId, ...base, run_id: seoRun, status: "completed", pages_limit: 20, pages_crawled: DEMO_PAGES.length, pages_skipped: 0,
    robots_json: JSON.stringify({
      llmsTxt: { present: false, notes: [`${DEMO_LABEL}: no /llms.txt found (advisory only).`] },
      crawlers: [
        { token: "OAI-SearchBot", vendor: "OpenAI", purpose: "answer_search", allowed: true, sourceUrl: "https://developers.openai.com/api/docs/bots" },
        { token: "GPTBot", vendor: "OpenAI", purpose: "training", allowed: false, sourceUrl: "https://developers.openai.com/api/docs/bots" },
      ],
      advisory: [`${DEMO_LABEL}: training crawler blocked by robots.txt; this is a business choice, not a defect.`],
    }),
    notes_json: JSON.stringify([DEMO_LABEL, `${DEMO_PAGES.length} of ${DEMO_PAGES.length} discovered pages crawled; 0 skipped.`]),
    started_at: at(123), finished_at: at(121),
  });
  const snapshotByPath = new Map<string, string>();
  const pageByPath = new Map<string, string>();
  for (const [pageIndex, p] of DEMO_PAGES.entries()) {
    // Page reads spread over the crawl window (123 -> 121 minutes ago) for the activity replay.
    const fetchedAt = at(122.9 - pageIndex * 0.2);
    const pageId = newId("pg");
    const snapId = newId("snap");
    const url = `${DEMO_ORIGIN}${p.path}`;
    pageByPath.set(p.path, pageId);
    snapshotByPath.set(p.path, snapId);
    ins("pages", { id: pageId, ...base, url, page_type: p.pageType, page_type_method: p.method, first_seen_at: at(123), last_crawled_at: fetchedAt });
    ins("page_snapshots", {
      id: snapId, ...base, page_id: pageId, crawl_run_id: crawlId, status_code: 200, final_url: url,
      content_hash: await hashJson({ demo: true, path: p.path }), skipped_reason: null, title: p.title, meta_description: p.metaDescription,
      h1_json: JSON.stringify(p.h1), headings_json: JSON.stringify(p.h1.map((text) => ({ level: 1, text }))), canonical: url, robots_meta: null,
      jsonld_types_json: JSON.stringify(p.jsonldTypes), jsonld_issues_json: JSON.stringify(p.jsonldIssues),
      internal_links_json: JSON.stringify(DEMO_PAGES.filter((o) => o.path !== p.path).slice(0, 4).map((o) => `${DEMO_ORIGIN}${o.path}`)),
      word_count: p.wordCount, main_text_excerpt: p.excerpt, first_paragraph: p.firstParagraph || null, author: null, last_updated: null,
      outbound_citations: 0, table_count: 0, fetched_at: fetchedAt,
    });
  }
  const findingIds: string[] = [];
  for (const f of DEMO_FINDINGS) {
    const id = newId("fnd");
    findingIds.push(id);
    ins("audit_findings", {
      id, ...base, crawl_run_id: crawlId, rule_id: f.ruleId, severity: f.severity, url: f.path ? `${DEMO_ORIGIN}${f.path}` : null,
      template: f.template, detail: f.detail, evidence_json: JSON.stringify({ demo: true, snapshotId: f.path ? snapshotByPath.get(f.path) : null }), created_at: at(121),
    });
  }

  // ------------------------------------------------------------ GEO prompts and observations
  const promptSetId = newId("gps");
  ins("geo_prompt_sets", { id: promptSetId, ...base, version: 1, active: 1, created_at: at(200) });
  const promptIds = DEMO_PROMPTS.map(() => newId("gp"));
  DEMO_PROMPTS.forEach((p, i) =>
    ins("geo_prompts", {
      id: promptIds[i], ...base, prompt_set_id: promptSetId, text: p.text, prompt_type: "discovery", stage: p.stage,
      locale: "en-US", language: "en", approved: 1, position: i,
    }),
  );
  const brandKeys = ["self", ...DEMO_PROJECT.competitors.map((c) => c.name)];
  const brandNames: Record<string, string> = { self: DEMO_BRAND };
  for (const c of DEMO_PROJECT.competitors) brandNames[c.name] = c.name;
  const cohorts = {
    gemini: await cohortKey({ promptSetVersion: 1, provider: "gemini", model: DEMO_MODEL, groundingMode: GROUNDING.gemini, samplingOptions: null }),
    perplexity: await cohortKey({ promptSetVersion: 1, provider: "perplexity", model: DEMO_MODEL, groundingMode: GROUNDING.perplexity, samplingOptions: null }),
  };
  const observationIds: string[][] = [];
  // Answers 30 s apart from 64 to 59.5 minutes ago, inside the run window, before the run_prompts event.
  let minute = 64.5;
  for (let pi = 0; pi < DEMO_ANSWERS.length; pi++) {
    observationIds.push([]);
    for (const a of DEMO_ANSWERS[pi]!) {
      const obsId = newId("obs");
      observationIds[pi]!.push(obsId);
      const created = at((minute -= 0.5));
      const ok = a.status === "ok";
      ins("geo_observations", {
        id: obsId, ...base, run_id: geoRun, prompt_id: promptIds[pi], prompt_set_id: promptSetId, prompt_text: DEMO_PROMPTS[pi]!.text,
        prompt_type: "discovery", cohort_key: cohorts[a.provider], provider: a.provider, model: DEMO_MODEL, grounding_mode: GROUNDING[a.provider],
        measurement_type: "api", imported_surface: null, status: a.status, grounded: ok && a.citations.length > 0 ? 1 : 0, raw_answer: a.text,
        request_id: `demo-fixture-${pi}-${a.provider}`, usage_json: JSON.stringify({ demo: true, inputTokens: null, outputTokens: null, searchRequests: null }),
        cost_usd: null, cost_is_estimate: 1, error: a.error ?? null, created_by: userId, created_at: created,
      });
      ins("provider_calls", {
        id: newId("call"), ...base, run_id: geoRun, provider: a.provider, model: DEMO_MODEL, purpose: "geo_answer (demo fixture)",
        status: ok ? "ok" : "timeout", request_id: `demo-fixture-${pi}-${a.provider}`, cost_usd: null, cost_is_estimate: 1,
        rate_version: null, latency_ms: null, error: a.error ?? null, created_at: created,
      });
      if (!ok || !a.text) continue;
      a.citations.forEach((cit, position) =>
        ins("geo_citations", {
          id: newId("cit"), ...base, observation_id: obsId, url: cit.url, host: new URL(cit.url).hostname, title: cit.title,
          position: position + 1, brand_key: cit.brandKey, source_type: cit.sourceType, source_type_method: "rule",
        }),
      );
      for (const key of brandKeys) {
        const m = a.mentions[key];
        const name = brandNames[key]!;
        const idx = a.text.indexOf(name);
        ins("geo_brand_observations", {
          id: newId("gbo"), ...base, observation_id: obsId, brand_key: key, is_self: key === "self" ? 1 : 0,
          mentioned: m ? 1 : 0, cited: a.citations.some((c) => c.brandKey === key) ? 1 : 0,
          recommendation_status: m ? m.status : "not_mentioned", list_rank: m ? m.rank : null,
          sentiment: m ? m.sentiment : "not_applicable",
          spans_json: JSON.stringify(m && idx >= 0 ? [{ start: idx, end: idx + name.length, text: name }] : []), method: "deterministic",
        });
      }
      for (const q of a.searchQueries ?? []) {
        ins("geo_search_queries", {
          id: newId("gsq"), ...base, observation_id: obsId, provider: a.provider, model: DEMO_MODEL, query: q,
          normalized: q.toLowerCase().replace(/\s+/g, " ").trim(), created_at: created,
        });
      }
      if (a.displacement) {
        ins("geo_displacements", {
          id: newId("gdp"), ...base, observation_id: obsId, entity: a.displacement.entity, url: a.displacement.url,
          source_type: a.displacement.sourceType, span: a.displacement.span, created_at: created,
        });
      }
    }
  }
  for (const run of [seoRun, geoRun]) {
    ins("provider_calls", {
      id: newId("call"), ...base, run_id: run, provider: "typesafe", model: DEMO_MODEL, purpose: "decisions (demo fixture)", status: "ok",
      request_id: null, cost_usd: null, cost_is_estimate: 1, rate_version: null, latency_ms: null, error: null, created_at: at(run === seoRun ? 120.8 : 59.35),
    });
  }

  // ------------------------------------------------------------ evidence
  const ev = async (runId: string, source: string, refId: string | null, window: string | null, text: string, data: unknown = {}) => {
    const id = newId("ev");
    const t = `[${DEMO_LABEL}] ${text}`.slice(0, 600);
    ins("evidence", {
      id, ...base, run_id: runId, source, ref_id: refId, window, text: t, data_json: JSON.stringify({ demo: true, ...(data as object) }), tainted: 0,
      hash: await hashJson({ s: source, r: refId, w: window, t }), created_at: at(runId === seoRun ? 120 : 60),
    });
    return id;
  };
  const gscWindow = `${start}..${end}`;
  const offerPaths = ["/products/linen-slipcover-sofa", "/products/oak-side-table", "/products/brass-table-lamp"];
  const eOffer1 = await ev(seoRun, "crawl", snapshotByPath.get(offerPaths[0]!)!, null, "Product JSON-LD on /products/linen-slipcover-sofa has no offers.");
  const eOffer2 = await ev(seoRun, "crawl", snapshotByPath.get(offerPaths[1]!)!, null, "Product JSON-LD on /products/oak-side-table has no offers.");
  const eOfferRule = await ev(seoRun, "rule", findingIds[0]!, null, "ECOM-PRODUCT-OFFER-INCOMPLETE: 3 of 3 crawled product pages lack offers.", { affected: 3, crawled: 8 });
  const eGsc = await ev(seoRun, "gsc", syncId, gscWindow, 'Query "washable linen sofa" on /collections/sofas: 4,120 impressions, 38 clicks (CTR 0.9%), average position 6.8.');
  const eMeta = await ev(seoRun, "crawl", snapshotByPath.get("/collections/sofas")!, null, "/collections/sofas has no meta description.");
  const eCtx = await ev(seoRun, "context_doc", productDocId, null, "Product context v2: slipcovers are removable and machine washable (unconfirmed, inferred).");
  const obs = (pi: number, provider: 0 | 1) => observationIds[pi]![provider]!;
  const eGeo1 = await ev(geoRun, "geo_observation", obs(0, 0), null, "Gemini (demo-fixture) answer to the washable-sofa prompt names Sample Sofa Co and cites a roundup; Demo Furnishings is absent.");
  const eGeo2 = await ev(geoRun, "geo_observation", obs(0, 1), null, "Perplexity (demo-fixture) answer to the washable-sofa prompt cites a review of Sample Sofa Co; Demo Furnishings is absent.");
  const eGeo3 = await ev(geoRun, "geo_observation", obs(1, 1), null, "Perplexity (demo-fixture) answer to the reading-lamp prompt cites Example Lamp House; Demo Furnishings is absent.");
  const eLamp = await ev(geoRun, "crawl", snapshotByPath.get("/products/brass-table-lamp")!, null, "/products/brass-table-lamp does not state bulb compatibility.");

  // ------------------------------------------------------------ decisions and recommendations
  // Decisions of one run are 6 s apart (after that run's Jev call row) so the replay lists them in order.
  const decisionCount: Record<string, number> = {};
  const decision = (runId: string, agent: "seo" | "geo", candidateKey: string, outcome: "selected" | "rejected", reason: string | null, answer: unknown, tier: string) => {
    const n = (decisionCount[runId] = (decisionCount[runId] ?? 0) + 1);
    ins("decision_records", {
      id: newId("dec"), ...base, run_id: runId, agent, candidate_key: candidateKey, question_id: `${agent}.action_choice`, question_version: "demo-fixture",
      policy_version: "demo-fixture", provider: DEMO_MODEL, model: DEMO_MODEL, state_hash: null, answer_json: JSON.stringify(answer), tier,
      outcome, reason_code: reason, created_at: at((runId === seoRun ? 120.8 : 59.35) - n * 0.1),
    });
  };
  decision(seoRun, "seo", `demo:${pid}:template:product:offer`, "selected", null, { type: "choice", choice: "add_offer_markup", confidence: 0.86, probabilities: { add_offer_markup: 0.86, insufficient_context: 0.14 } }, "act");
  decision(seoRun, "seo", `demo:${pid}:url:sofas:meta`, "selected", null, { type: "choice", choice: "rewrite_snippet", confidence: 0.64, probabilities: { rewrite_snippet: 0.64, none: 0.36 } }, "flag");
  decision(seoRun, "seo", "template:collection:intro", "rejected", "low_fit", { type: "choice", choice: "none", confidence: 0.71, probabilities: { add_intro: 0.29, none: 0.71 } }, "act");
  decision(geoRun, "geo", `demo:${pid}:geo:prompt0:comparison`, "selected", null, { type: "choice", choice: "add_comparison_content", confidence: 0.81, probabilities: { add_comparison_content: 0.81, insufficient_context: 0.19 } }, "act");
  decision(geoRun, "geo", `demo:${pid}:geo:prompt1:fact`, "selected", null, { type: "choice", choice: "clarify_product_fact", confidence: 0.77, probabilities: { clarify_product_fact: 0.77, none: 0.23 } }, "act");
  decision(geoRun, "geo", "prompt:4:none", "rejected", "insufficient_evidence", { type: "choice", choice: "insufficient_context", confidence: 0.9, probabilities: { insufficient_context: 0.9, none: 0.1 } }, "act");

  const rec = (runId: string, agent: "seo" | "geo", r: Record<string, unknown>, evidence: Array<[string, string, string]>, minutesAgo: number) => {
    const id = newId("rec");
    const ts = at(minutesAgo);
    ins("recommendations", {
      id, ...base, run_id: runId, agent, verified: 0, priority_version: "demo-fixture", status: "open", stage: "awaiting_approval",
      writer_provider: DEMO_MODEL, writer_model: DEMO_MODEL, is_demo: 1, created_at: ts, updated_at: ts,
      evidence_ids_json: JSON.stringify(evidence.map(([eid]) => eid)),
      evidence_bullets_json: JSON.stringify(evidence.map(([evidenceId, source, text]) => ({ evidenceId, source, text: `[${DEMO_LABEL}] ${text}` }))),
      limitations: `${DEMO_LABEL}. Fictional site and measurements; nothing was fetched or published.`,
      ...r,
    });
    ins("recommendation_events", { id: newId("rev"), ...base, recommendation_id: id, user_id: null, event: "created", note: DEMO_LABEL, created_at: ts });
  };
  rec(seoRun, "seo", {
    scope: "template",
    target_json: JSON.stringify({ kind: "template", template: "product", affectedUrlCount: 3, exampleUrls: offerPaths.map((p) => `${DEMO_ORIGIN}${p}`) }),
    issue_type: "product_offer_missing", trigger: "Template issue on 3 URLs",
    issue: `(${DEMO_LABEL}) Product structured data on the product template has no offers.`,
    action: "Add an Offer (price, priceCurrency, availability) to the Product JSON-LD in the product template, using values already shown on each page.",
    suggested_snippet: '"offers": { "@type": "Offer", "price": "[confirm: price]", "priceCurrency": "[confirm: currency]", "availability": "https://schema.org/InStock" }',
    rationale: `(${DEMO_LABEL}) All 3 crawled product pages share the gap; one template change fixes them. Rich results are never guaranteed.`,
    effort: "low", uncertainty: "low", priority: 0.72, decision_label: "act",
    decision_score_json: JSON.stringify({ choice: "add_offer_markup", confidence: 0.86 }),
    confirm_placeholders_json: JSON.stringify(["[confirm: price]", "[confirm: currency]"]), dedup_key: `demo:${pid}:template:product:offer`,
  }, [[eOffer1, "crawl", "linen-slipcover-sofa: Product JSON-LD without offers"], [eOffer2, "crawl", "oak-side-table: Product JSON-LD without offers"], [eOfferRule, "rule", "3 of 3 crawled product pages affected"]], 119);
  rec(seoRun, "seo", {
    scope: "page",
    target_json: JSON.stringify({ kind: "url", url: `${DEMO_ORIGIN}/collections/sofas` }),
    issue_type: "weak_ctr_missing_description", trigger: 'From GSC query "washable linen sofa"',
    issue: `(${DEMO_LABEL}) /collections/sofas gets impressions for "washable linen sofa" at position 6.8 with 0.9% CTR and has no meta description.`,
    action: "Write a meta description for /collections/sofas that states the covers are removable and washable (confirm the washable claim first).",
    suggested_snippet: "Linen slipcover sofas with removable covers. [confirm: machine washable] Free fabric swatches.",
    rationale: `(${DEMO_LABEL}) High impressions with weak CTR for a matching query; the snippet is currently chosen by the search engine.`,
    effort: "low", uncertainty: "medium", priority: 0.55, decision_label: "flag",
    decision_score_json: JSON.stringify({ choice: "rewrite_snippet", confidence: 0.64 }),
    confirm_placeholders_json: JSON.stringify(["[confirm: machine washable]"]), dedup_key: `demo:${pid}:url:sofas:meta`,
  }, [[eGsc, "gsc", `GSC ${gscWindow}: 4,120 impressions, 38 clicks, position 6.8`], [eMeta, "crawl", "No meta description on /collections/sofas"], [eCtx, "context_doc", "Product context v2 (unconfirmed): washable slipcovers"]], 118);
  rec(geoRun, "geo", {
    scope: "page",
    target_json: JSON.stringify({ kind: "url", url: `${DEMO_ORIGIN}/blog/how-to-choose-a-washable-sofa` }),
    issue_type: "comparison_content", trigger: "Provider gemini answer missing brand",
    issue: `(${DEMO_LABEL}) For "best washable sofas for homes with kids and pets", both demo answers name Sample Sofa Co via a roundup and a review site; Demo Furnishings is absent.`,
    action: "Add a factual comparison section (cover removal, washing instructions, fabric weight) to the washable-sofa guide, using only confirmed product facts.",
    suggested_snippet: null,
    rationale: `(${DEMO_LABEL}) Cited pages answer the comparison directly; the guide does not. This is a hypothesis, not a predicted citation.`,
    effort: "medium", uncertainty: "high", priority: 0.61, decision_label: "act",
    decision_score_json: JSON.stringify({ choice: "add_comparison_content", confidence: 0.81 }),
    confirm_placeholders_json: JSON.stringify(["[confirm: fabric weight]"]), dedup_key: `demo:${pid}:geo:prompt0:comparison`,
  }, [[eGeo1, "geo_observation", "Gemini: Sample Sofa Co cited via roundup; brand absent"], [eGeo2, "geo_observation", "Perplexity: Sample Sofa Co cited via review site; brand absent"], [eCtx, "context_doc", "Product context v2: washable slipcovers (unconfirmed)"]], 59);
  rec(geoRun, "geo", {
    scope: "page",
    target_json: JSON.stringify({ kind: "url", url: `${DEMO_ORIGIN}/products/brass-table-lamp` }),
    issue_type: "missing_product_fact", trigger: "Provider perplexity answer missing brand",
    issue: `(${DEMO_LABEL}) The reading-lamp answer cites Example Lamp House; the brass lamp page does not state bulb compatibility.`,
    action: "State the supported bulb type and maximum wattage on the brass table lamp page.",
    suggested_snippet: "Uses one [confirm: bulb base] bulb, up to [confirm: maximum wattage].",
    rationale: `(${DEMO_LABEL}) Answers for reading lamps describe light characteristics; the page omits them.`,
    effort: "low", uncertainty: "medium", priority: 0.48, decision_label: "act",
    decision_score_json: JSON.stringify({ choice: "clarify_product_fact", confidence: 0.77 }),
    confirm_placeholders_json: JSON.stringify(["[confirm: bulb base]", "[confirm: maximum wattage]"]), dedup_key: `demo:${pid}:geo:prompt1:fact`,
  }, [[eGeo3, "geo_observation", "Perplexity: Example Lamp House cited; brand absent"], [eLamp, "crawl", "Bulb compatibility not stated on the lamp page"]], 58);

  try {
    await db.batch(S);
  } catch (e) {
    await db.run("DELETE FROM projects WHERE workspace_id = ? AND id = ?", wid, pid);
    throw e;
  }
  return (await db.first<ProjectRow>("SELECT * FROM projects WHERE workspace_id = ? AND id = ?", wid, pid))!;
}
