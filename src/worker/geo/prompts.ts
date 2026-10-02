/**
 * GEO prompt sets: versioned, user-approved buyer prompts.
 *
 * - Discovery prompts are brand-blind: they may not contain the brand name, its aliases, competitor
 *   names/aliases, or any tracked domain (same Unicode-aware word-boundary matching as detection).
 *   Reputation prompts may name the brand and are labelled separately; they never enter the default
 *   visibility metrics.
 * - Every save creates a NEW prompt-set version (a new cohort for trends); the previous set is
 *   deactivated. Approval is explicit per prompt; unapproved prompts never run.
 * - Generated suggestions (writer + PROMPT_GENERATOR_SYSTEM from writing/prompts.ts, verbatim from
 *   build-kit 2.2) are returned unapproved and NOT persisted; the UI adds them through PUT.
 */
import type { GeoPrompt, GeoPromptSet } from "@shared/types";
import type { Db } from "../lib/db";
import { parseJson } from "../lib/db";
import { newId } from "../lib/ids";
import { iso } from "../lib/time";
import { badRequest } from "../lib/errors";
import type { WritingProvider } from "../providers/types";
import { PROMPT_GENERATOR_SYSTEM, GEO_WRITER_SYSTEM, WRITER_PROMPTS_VERSION } from "../writing/prompts";
import { DISCOVERY_PROMPTS_JSON_SCHEMA, discoveryPromptsOutputSchema, toProviderSchema } from "../writing/schemas";
import { containsTerm, projectBrands, type ProjectBrandSource } from "./detect";

export { PROMPT_GENERATOR_SYSTEM, GEO_WRITER_SYSTEM, WRITER_PROMPTS_VERSION };

export const MAX_PROMPTS_PER_SET = 25;
export const MAX_PROMPT_LENGTH = 500;

export interface PromptInput {
  text: string;
  promptType: "discovery" | "reputation";
  stage: string | null;
  approved: boolean;
}

export interface BrandBlindViolation {
  term: string;
  brandKey: string;
  kind: "name_or_alias" | "domain";
  matched: string;
}

/** Terms a discovery prompt may not contain: every brand's name/aliases and tracked domains. */
export function brandBlindViolations(text: string, project: ProjectBrandSource): BrandBlindViolation[] {
  const out: BrandBlindViolation[] = [];
  for (const b of projectBrands(project)) {
    for (const term of [b.name, ...b.aliases]) {
      const hit = containsTerm(text, term);
      if (hit) out.push({ term, brandKey: b.key, kind: "name_or_alias", matched: hit.text });
    }
    for (const d of b.domains) {
      const hit = containsTerm(text, d);
      if (hit) out.push({ term: d, brandKey: b.key, kind: "domain", matched: hit.text });
    }
  }
  const seen = new Set<string>();
  return out.filter((v) => {
    const k = `${v.brandKey}|${v.term.toLowerCase()}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

interface PromptRow {
  id: string;
  text: string;
  prompt_type: "discovery" | "reputation";
  stage: string | null;
  locale: string;
  language: string;
  approved: number;
  position: number;
}

export async function getActivePromptSet(db: Db, workspaceId: string, projectId: string): Promise<GeoPromptSet | null> {
  const set = await db.first<{ id: string; version: number; created_at: string; label: string | null }>(
    "SELECT id, version, created_at, label FROM geo_prompt_sets WHERE workspace_id = ? AND project_id = ? AND active = 1 ORDER BY version DESC LIMIT 1",
    workspaceId,
    projectId,
  );
  if (!set) return null;
  const rows = await db.all<PromptRow>(
    "SELECT id, text, prompt_type, stage, locale, language, approved, position FROM geo_prompts WHERE workspace_id = ? AND project_id = ? AND prompt_set_id = ? ORDER BY position",
    workspaceId,
    projectId,
    set.id,
  );
  return {
    id: set.id,
    version: set.version,
    createdAt: set.created_at,
    label: set.label ?? null,
    prompts: rows.map(
      (r): GeoPrompt => ({
        id: r.id,
        text: r.text,
        promptType: r.prompt_type,
        stage: r.stage,
        locale: r.locale,
        language: r.language,
        approved: r.approved === 1,
        position: r.position,
      }),
    ),
  };
}

export interface ProjectForPrompts extends ProjectBrandSource {
  id: string;
  workspace_id: string;
  locale: string;
  language: string;
}

/**
 * Validate and save a new prompt-set version. Throws 400 when a discovery prompt breaks the
 * brand-blind rule (details list each offending prompt and term).
 */
export async function savePromptSet(db: Db, project: ProjectForPrompts, prompts: PromptInput[], now: Date, opts: { label?: string | null } = {}): Promise<GeoPromptSet> {
  if (prompts.length > MAX_PROMPTS_PER_SET) throw badRequest(`At most ${MAX_PROMPTS_PER_SET} prompts per set.`);
  const violations = prompts
    .map((p, index) => ({ index, text: p.text, matched: p.promptType === "discovery" ? [...new Set(brandBlindViolations(p.text, project).map((v) => v.matched))] : [] }))
    .filter((v) => v.matched.length > 0);
  if (violations.length > 0) {
    // Pinned error shape: details = { violations: [{ index, text, matched: string[] }] }.
    throw badRequest(
      "Discovery prompts must be brand-blind: remove the brand name, aliases, competitor names, and tracked domains, or mark the prompt as a reputation prompt (reported separately).",
      { violations },
    );
  }
  const seen = new Set<string>();
  for (const p of prompts) {
    const k = p.text.trim().toLowerCase();
    if (seen.has(k)) throw badRequest("Duplicate prompt text in the set.", { text: p.text });
    seen.add(k);
  }
  const prev = await db.first<{ v: number | null }>(
    "SELECT MAX(version) AS v FROM geo_prompt_sets WHERE workspace_id = ? AND project_id = ?",
    project.workspace_id,
    project.id,
  );
  const version = (prev?.v ?? 0) + 1;
  const setId = newId("gps");
  const created = iso(now);
  const stmts: Array<[string, ...unknown[]]> = [
    ["UPDATE geo_prompt_sets SET active = 0 WHERE workspace_id = ? AND project_id = ?", project.workspace_id, project.id],
    [
      "INSERT INTO geo_prompt_sets (id, workspace_id, project_id, version, active, created_at, label) VALUES (?,?,?,?,1,?,?)",
      setId, project.workspace_id, project.id, version, created, opts.label ?? null,
    ],
  ];
  prompts.forEach((p, position) => {
    stmts.push([
      "INSERT INTO geo_prompts (id, workspace_id, project_id, prompt_set_id, text, prompt_type, stage, locale, language, approved, position) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
      newId("gpr"), project.workspace_id, project.id, setId, p.text.trim(), p.promptType, p.stage, project.locale, project.language, p.approved ? 1 : 0, position,
    ]);
  });
  await db.batch(stmts);
  const set = await getActivePromptSet(db, project.workspace_id, project.id);
  if (!set) throw new Error("Prompt set was not saved.");
  return set;
}

export interface PromptSuggestion {
  text: string;
  promptType: "discovery";
  stage: string;
  rationale: string;
  approved: false;
}

export interface SuggestionResult {
  suggestions: PromptSuggestion[];
  dropped: Array<{ text: string; reason: string }>;
  writer: { provider: string; model: string; promptsVersion: string };
}

/**
 * Ask the writer for brand-blind discovery prompt suggestions. Suggestions that name a tracked brand
 * or domain are dropped (reported in `dropped`), never silently rewritten.
 */
export async function generatePromptSuggestions(
  writer: WritingProvider,
  project: ProjectForPrompts & { product_description: string; audience: string; site_type: string },
  contentPillars: string[],
): Promise<SuggestionResult> {
  const res = await writer.write({
    purpose: "geo_prompt_generation",
    system: PROMPT_GENERATOR_SYSTEM,
    input: {
      product_description: project.product_description.slice(0, 1500),
      audience: project.audience.slice(0, 500),
      locale: project.locale,
      site_type: project.site_type,
      content_pillars: contentPillars.slice(0, 20),
    },
    jsonSchema: toProviderSchema(DISCOVERY_PROMPTS_JSON_SCHEMA),
    maxOutputTokens: 1200,
  });
  const parsed = discoveryPromptsOutputSchema.safeParse(res.output);
  if (!parsed.success) throw badRequest("The writer returned suggestions in an unexpected format; nothing was saved.");
  const suggestions: PromptSuggestion[] = [];
  const dropped: SuggestionResult["dropped"] = [];
  for (const item of parsed.data.slice(0, 10)) {
    const text = item.prompt.trim();
    const v = brandBlindViolations(text, project);
    if (v.length > 0) {
      dropped.push({ text, reason: `names ${v.map((x) => x.term).join(", ")} (brand-blind rule)` });
      continue;
    }
    suggestions.push({ text, promptType: "discovery", stage: item.stage, rationale: item.rationale, approved: false });
  }
  return { suggestions, dropped, writer: { provider: res.provider, model: res.model, promptsVersion: WRITER_PROMPTS_VERSION } };
}

/** Content pillars from the latest 'pillars' context document (facts first, else content lines). */
export async function contentPillars(db: Db, workspaceId: string, projectId: string): Promise<string[]> {
  const doc = await db.first<{ content: string; facts_json: string }>(
    "SELECT content, facts_json FROM context_documents WHERE workspace_id = ? AND project_id = ? AND kind = 'pillars' ORDER BY version DESC LIMIT 1",
    workspaceId,
    projectId,
  );
  if (!doc) return [];
  const facts = parseJson<Array<{ text?: unknown }>>(doc.facts_json, []).map((f) => (typeof f.text === "string" ? f.text : "")).filter(Boolean);
  if (facts.length) return facts;
  return doc.content.split("\n").map((l) => l.replace(/^[-*\s]+/, "").trim()).filter(Boolean);
}
