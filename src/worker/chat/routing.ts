/**
 * Ask Okara tool routing [A40]. Sending all ~54 tool schemas every round made each model round ~16k input
 * tokens; most questions need one or two areas. So each turn sends:
 *  - the CORE tools (always): get_overview, models, list_runs, run_activity, navigate and the `more_tools` meta tool;
 *  - plus the GROUPS chosen deterministically from the user's message (keyword/intent map below) and the groups the
 *    previous turn used (follow-up questions), or DEFAULT_GROUPS when nothing matched.
 * Within a turn the set only grows (in registry order, so the tool list stays stable for prompt caching):
 *  - a call to a registered tool that was not sent still runs (validated and confirm-gated exactly the same) and its
 *    group joins the next rounds;
 *  - `more_tools` loads the named groups once per turn; and when the model answers that it lacks a tool, the loop
 *    loads every group once (loop.ts).
 * Code decides which tools exist for a round; the model never sees hidden tools' schemas until they are loaded.
 */
import type { ChatTool } from "./tool-base";
import type { ToolSpec } from "./types";

export const TOOL_GROUPS = ["search_console", "dataforseo", "internal_links", "backlinks", "live", "geo", "imports", "models", "settings", "work", "seo_site", "export"] as const;
export type ToolGroup = (typeof TOOL_GROUPS)[number];

/** Always sent. */
export const CORE_TOOLS: readonly string[] = ["get_overview", "models", "list_runs", "run_activity", "navigate"];

/** Group of every non-core tool (registry names). A tool not listed here (and not core) falls back to "work". */
export const TOOL_GROUP: Record<string, ToolGroup> = {
  search_console_queries: "search_console",
  search_console_pages: "search_console",
  search_console_trend: "search_console",
  search_console_compare: "search_console",
  search_console_brand_split: "search_console",
  search_console_buyer_queries: "search_console",
  search_console_live_query: "search_console",
  classify_buyer_queries: "search_console",
  dataforseo_competitor_data: "dataforseo",
  dataforseo_refresh_competitor: "dataforseo",
  dataforseo_keyword_lookup: "dataforseo",
  list_competitors: "dataforseo",
  update_competitors: "dataforseo",
  internal_link_suggestions: "internal_links",
  link_workbench: "internal_links",
  link_job: "internal_links",
  set_link_suggestion_status: "internal_links",
  edit_link_cluster: "internal_links",
  backlinks: "backlinks",
  live_insight: "live",
  geo_results: "geo",
  geo_data: "geo",
  update_geo_prompts: "geo",
  approve_competitor_page: "geo",
  import_data: "imports",
  imported_research: "imports",
  maton_data: "imports",
  manage_import_sync: "imports",
  provider_models: "models",
  manage_models: "models",
  manage_credentials: "models",
  project_admin: "settings",
  integration_options: "settings",
  admin_settings: "settings",
  update_project_settings: "settings",
  list_recommendations: "work",
  get_recommendation: "work",
  update_recommendation_status: "work",
  run_detail: "work",
  run_agent_now: "work",
  cancel_run: "work",
  list_pages: "seo_site",
  page_details: "seo_site",
  seo_audit: "seo_site",
  checklist_status: "seo_site",
  update_checklist_item: "seo_site",
  set_page_type: "seo_site",
  draft_check: "seo_site",
  export_csv: "export",
};

export const GROUP_LABEL: Record<ToolGroup, string> = {
  search_console: "Search Console queries, pages, trends, compare, brand split, buyer queries, live query",
  dataforseo: "competitors and DataForSEO (keyword gap, top keywords, search volume, difficulty)",
  internal_links: "internal-link suggestions, orphans, link workbench",
  backlinks: "backlink monitor (built links: dofollow/nofollow, status, changes)",
  live: "Live view containers (striking distance, movers, technical, cited domains, budget)",
  geo: "GEO / AI-answer results, prompts, citations, displacements, competitor pages",
  imports: "imports, the master Google Sheet, Maton (live Sheets, Search Console, GA4)",
  models: "change models, providers and API keys",
  settings: "project settings, limits, usage, integrations, members, verification",
  work: "recommendations and agent runs (start, cancel, details)",
  seo_site: "crawled pages, SEO audit, checklists, draft check",
  export: "CSV export",
};

/** Used when the message matches no group and the previous turn used none. */
export const DEFAULT_GROUPS: readonly ToolGroup[] = ["work"];

/** Keyword / intent map over the lowercased user message (deterministic; order irrelevant). */
const RULES: Array<[ToolGroup | ToolGroup[], RegExp]> = [
  ["search_console", /search console|\bgsc\b|\bquer(?:y|ies)\b|\bclicks?\b|\bimpressions?\b|\bctr\b|\bpositions?\b|\branking|\brank(?:s|ed)?\b|\btraffic\b|non-?brand|\bbrand(?:ed)? (?:vs|split|queries)|\bbuyer|\bdeclin|\bdropp?(?:ed|ing)?\b|\blost\b|\bgain(?:ed|ing)?\b|\btop pages\b|\bstriking/],
  ["dataforseo", /dataforseo|competitor|keyword gap|\bgap\b|search volume|\bvolume\b|keyword difficulty|\bdifficulty\b|\bkd\b|\bcpc\b|top keywords/],
  ["internal_links", /internal[ -]?link|\borphan|link suggestion|workbench|\bclusters?\b|broken link|interlink|\banchors?\b(?!.*\b(?:backlink|dofollow|nofollow)\b)/],
  ["backlinks", /backlink|back-link|do-?follow|no-?follow|\bsponsored\b|\bugc\b|built links?|link building|guest post|\bvendors?\b|\blink (?:is|still|live)\b|\b(?:the|this|that|our) [a-z0-9.-]+ link\b/],
  ["live", /\blive (?:view|insight|tab|container)|striking|\bmovers\b|technical issue|\bbudget\b|\bquotas?\b|cited domains|engine quer|prompt history/],
  ["geo", /\bgeo\b|\bai (?:answers?|engines?|overviews?|visibility|search|mode)\b|gemini|perplexity|chatgpt|copilot|\bcitations?\b|\bcit(?:ed|ing|e)\b|\bmention|\bprompts?\b|displac|rewrite plan|answer coverage|skip factor|competitor page|\bllms?\b/],
  ["imports", /\bimport|\bsheets?\b|spreadsheet|\bmaton\b|google analytics|\bga4?\b|\brevenue\b|\bsessions\b|landing page|blog hub|ai questions|\bsync(?:s|ed|ing)?\b|research table/],
  ["models", /\bmodels?\b|\bwriter\b|\bproviders?\b|api key|\bkeys?\b|credential|base ?url|\bgrok\b|anthropic|openai|\bgpt\b|\bllm\b|engine model|chat model/],
  ["settings", /setting|\blimits?\b|\busage\b|\bmembers?\b|integration|verif|context doc|propert(?:y|ies)|schedul|crawl pages|attention|\bowner\b|workspace|gsc source|connection/],
  ["work", /recommend|\bfix\b|priorit|\bapprove|\bdismiss|\breject|\bruns?\b|\brunning\b|\bagent\b|\bcancel|failed|what should/],
  ["seo_site", /\baudit|\bcrawl|checklist|\bdraft|meta (?:title|description)|title tags?|\bh1\b|canonical|robots|word count|thin content|page type|structured data|schema markup|translation|page details|list (?:of |all )?(?:the )?pages|which pages (?:are|have)|\bindex(?:ed|ing|able)?\b|status codes?|\b404\b/],
  ["export", /\bexport|\bcsv\b|download/],
  // Intent: "what should I fix first" combines recommendations, audit findings and striking-distance queries.
  [["work", "seo_site", "live"], /fix first|what should i (?:fix|do|work on)|prioriti[sz]e|biggest (?:issue|problem|opportunit)/],
];

export function groupOf(toolName: string): ToolGroup | "core" | null {
  if (CORE_TOOLS.includes(toolName)) return "core";
  return TOOL_GROUP[toolName] ?? null;
}

/** Groups a message asks for (deterministic). */
export function groupsForMessage(message: string): ToolGroup[] {
  const text = message.toLowerCase();
  const out = new Set<ToolGroup>();
  for (const [g, re] of RULES) if (re.test(text)) for (const x of Array.isArray(g) ? g : [g]) out.add(x);
  return TOOL_GROUPS.filter((g) => out.has(g));
}

/**
 * Groups for a new turn: the message's groups plus the groups of tools the previous answer used; DEFAULT_GROUPS
 * when both are empty. Returned in TOOL_GROUPS order.
 */
export function routeGroups(message: string, previousTools: readonly string[] = []): ToolGroup[] {
  const set = new Set<ToolGroup>(groupsForMessage(message));
  for (const t of previousTools) {
    const g = groupOf(t);
    if (g && g !== "core") set.add(g);
  }
  if (!set.size) for (const g of DEFAULT_GROUPS) set.add(g);
  return TOOL_GROUPS.filter((g) => set.has(g));
}

export function isToolGroup(v: unknown): v is ToolGroup {
  return typeof v === "string" && (TOOL_GROUPS as readonly string[]).includes(v);
}

/** Tools of the active groups (plus core), in registry order. */
export function toolsForGroups(all: readonly ChatTool[], groups: Iterable<ToolGroup>): ChatTool[] {
  const active = new Set(groups);
  return all.filter((t) => {
    const g = groupOf(t.name);
    return g === "core" || (g !== null ? active.has(g) : active.has("work"));
  });
}

// ------------------------------------------------------------------ more_tools (meta tool handled by the loop)
export const MORE_TOOLS = "more_tools";

/** Short names of each group for the more_tools description (kept terse: it is sent every round). */
const GROUP_HINT: Record<ToolGroup, string> = {
  search_console: "",
  dataforseo: "competitors, volume",
  internal_links: "",
  backlinks: "",
  live: "Live view",
  geo: "AI answers",
  imports: "sheets, Maton, GA4",
  models: "models, keys",
  settings: "settings, usage, members",
  work: "recommendations, runs",
  seo_site: "pages, audit, checklists",
  export: "CSV",
};

export const MORE_TOOLS_SPEC: ToolSpec = {
  name: MORE_TOOLS,
  description: `Load more tool groups for this answer (once) when no tool fits: ${TOOL_GROUPS.map((g) => (GROUP_HINT[g] ? `${g} (${GROUP_HINT[g]})` : g)).join(", ")}.`,
  parameters: {
    type: "object",
    properties: { groups: { type: "array", items: { type: "string", enum: [...TOOL_GROUPS] }, minItems: 1, maxItems: 6 } },
    required: ["groups"],
  },
};

/** The model said it has no fitting tool (then the loop loads every group once). */
export const LACKS_TOOL_RE =
  /\b(?:i\s+(?:do\s+not|don't|cannot|can't|currently\s+don't)\s+have\s+(?:a\s+|the\s+|any\s+)?(?:[\w-]+\s+){0,3}tools?\b|no\s+(?:available\s+|suitable\s+)?tools?\s+(?:for|to|that)\b|tools?\s+(?:is|are)\s+not\s+available|not\s+among\s+my\s+tools|i\s+lack\s+(?:a\s+|the\s+)?tools?|(?:isn't|is\s+not)\s+one\s+of\s+my\s+tools)/i;
