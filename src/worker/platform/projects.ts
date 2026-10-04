/**
 * Projects, shared context documents, and per-project limits (platform-projects module).
 * All queries filter by workspace_id; callers resolve access first with requireProject()/requireWorkspaceMember().
 */
import { z } from "zod";
import type { Competitor, ContextDocument, ContextFact, ContextKind, Project, ProjectInput, UsageSummary } from "@shared/types";
import type { Db } from "../lib/db";
import { parseJson } from "../lib/db";
import { HttpError, badRequest, conflict } from "../lib/errors";
import { newId, randomToken } from "../lib/ids";
import { iso } from "../lib/time";
import type { ProjectRow } from "./access";
import { MAX_COMPETITORS, MAX_COMPETITOR_ALIASES, MAX_COMPETITOR_DOMAINS, cleanCompetitorDomain, isPublicHostname } from "@shared/competitors";

export { MAX_COMPETITORS, isPublicHostname };

/**
 * Outbound fetch used by platform routes (Google OAuth/Search Console, DNS-over-HTTPS, file verification).
 * Tests replace `outbound.fetch` with a fake; production uses the global fetch.
 */
export const outbound: { fetch: typeof fetch } = {
  fetch: (input, init) => fetch(input, init),
};

export const MAX_PROJECTS_PER_WORKSPACE = 25;
export const CONTEXT_KINDS: readonly ContextKind[] = ["product", "positioning", "competitors", "voice", "pillars"];

// ------------------------------------------------------------------ site URL and domains

/** Validate a user-entered site URL: https only, no credentials, no port, a public-looking DNS host. Returns the origin. */
export function normalizeSiteUrl(input: string): { origin: string; host: string } {
  let u: URL;
  try {
    u = new URL(input.trim());
  } catch {
    throw badRequest("siteUrl must be a full https URL, for example https://www.example.com.");
  }
  if (u.protocol !== "https:") throw badRequest("siteUrl must use https.");
  if (u.username || u.password) throw badRequest("siteUrl must not contain credentials.");
  if (u.port) throw badRequest("siteUrl must not specify a port.");
  const host = u.hostname.toLowerCase().replace(/\.$/, "");
  if (!isPublicHostname(host)) throw badRequest("siteUrl must use a public domain name (no IP addresses or local hostnames).");
  return { origin: `https://${host}`, host };
}

/**
 * Accepts "brand.com", "https://www.brand.com/x" or "www.Brand.com"; returns the cleaned lowercase hostname without
 * "www." (shared rules, src/shared/competitors.ts). A likely "ww."/"wwww." typo is kept as entered (never corrected
 * silently; the web form and the import preview ask the owner).
 */
export function normalizeDomain(input: string): string {
  const r = cleanCompetitorDomain(input);
  if (!r.ok) throw badRequest(`Invalid competitor domain: ${input.slice(0, 100)}`);
  return r.domain;
}

const normTerm = (s: string) => s.normalize("NFKC").trim().toLowerCase().replace(/\s+/g, " ");

function dedupeTerms(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const v of values) {
    const t = v.trim().replace(/\s+/g, " ");
    const k = normTerm(t);
    if (!t || seen.has(k)) continue;
    seen.add(k);
    out.push(t);
  }
  return out;
}

export interface AliasCollision {
  kind: "brand_vs_competitor" | "competitor_vs_competitor" | "domain";
  term: string;
  a: string;
  b: string;
}

/**
 * Brand aliases and competitor aliases must be disjoint so detection never attributes a mention to the
 * wrong entity. Collisions are resolved manually by the user (we reject and list them).
 */
export function findAliasCollisions(input: { brandName: string; brandAliases: string[]; competitors: Competitor[]; host: string }): AliasCollision[] {
  const collisions: AliasCollision[] = [];
  const brandTerms = new Map<string, string>();
  for (const t of [input.brandName, ...input.brandAliases]) brandTerms.set(normTerm(t), t);
  const seenCompetitorTerms = new Map<string, string>(); // term -> competitor name
  for (const c of input.competitors) {
    const terms = new Set([c.name, ...c.aliases].map(normTerm));
    for (const t of terms) {
      if (!t) continue;
      if (brandTerms.has(t)) collisions.push({ kind: "brand_vs_competitor", term: brandTerms.get(t)!, a: input.brandName, b: c.name });
      const other = seenCompetitorTerms.get(t);
      if (other !== undefined && other !== c.name) collisions.push({ kind: "competitor_vs_competitor", term: t, a: other, b: c.name });
      seenCompetitorTerms.set(t, c.name);
    }
    for (const d of c.domains) {
      if (d === input.host || input.host.endsWith(`.${d}`) || d.endsWith(`.${input.host}`)) {
        collisions.push({ kind: "domain", term: d, a: input.brandName, b: c.name });
      }
    }
  }
  return collisions;
}

// ------------------------------------------------------------------ validation schemas

const text = (max: number) => z.string().max(max);
const term = z.string().trim().min(1).max(80);

export const competitorSchema = z.object({
  name: z.string().trim().min(1).max(120),
  domains: z.array(z.string().trim().min(1).max(253)).max(MAX_COMPETITOR_DOMAINS).default([]),
  aliases: z.array(term).max(MAX_COMPETITOR_ALIASES).default([]),
});

export const siteTypeSchema = z.enum(["ecommerce", "saas", "publisher", "local", "other"]);

const projectFields = {
  name: z.string().trim().min(1).max(120),
  siteUrl: z.string().trim().min(1).max(2048),
  siteType: siteTypeSchema,
  brandName: z.string().trim().min(1).max(120),
  brandAliases: z.array(term).max(20),
  competitors: z.array(competitorSchema).max(MAX_COMPETITORS, `At most ${MAX_COMPETITORS} competitors.`),
  productDescription: text(5000),
  audience: text(2000),
  locale: z.string().trim().regex(/^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/, "Invalid locale (e.g. en-US)."),
  language: z.string().trim().regex(/^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/, "Invalid language (e.g. en)."),
  voice: text(2000),
};

export const projectInputSchema = z
  .object({
    ...projectFields,
    brandAliases: projectFields.brandAliases.default([]),
    competitors: projectFields.competitors.default([]),
    productDescription: projectFields.productDescription.default(""),
    audience: projectFields.audience.default(""),
    locale: projectFields.locale.default("en-US"),
    language: projectFields.language.default("en"),
    voice: projectFields.voice.default(""),
  })
  .strict();

export const projectPatchSchema = z
  .object({
    name: projectFields.name,
    siteUrl: projectFields.siteUrl,
    siteType: projectFields.siteType,
    brandName: projectFields.brandName,
    brandAliases: projectFields.brandAliases,
    competitors: projectFields.competitors,
    productDescription: projectFields.productDescription,
    audience: projectFields.audience,
    locale: projectFields.locale,
    language: projectFields.language,
    voice: projectFields.voice,
    scheduleEnabled: z.boolean(),
  })
  .partial()
  .strict();

export const contextPutSchema = z
  .object({
    content: z.string().max(20000),
    facts: z
      .array(
        z.object({
          id: z.string().trim().min(1).max(64).optional(),
          text: z.string().trim().min(1).max(1000),
          confirmed: z.boolean(),
          source: z.string().trim().min(1).max(200).optional(),
        }),
      )
      .max(100)
      .default([]),
  })
  .strict();

export const contextKindSchema = z.enum(["product", "positioning", "competitors", "voice", "pillars"]);

export const LIMIT_BOUNDS = {
  crawlPages: [1, 200],
  gscRows: [100, 25000],
  geoPromptsPerRun: [1, 25],
  providerCallsPerDay: [1, 500],
  usdPerDay: [0, 20],
} as const;

export const limitsPutSchema = z
  .object({
    crawlPages: z.number().int().min(LIMIT_BOUNDS.crawlPages[0]).max(LIMIT_BOUNDS.crawlPages[1]),
    gscRows: z.number().int().min(LIMIT_BOUNDS.gscRows[0]).max(LIMIT_BOUNDS.gscRows[1]),
    geoPromptsPerRun: z.number().int().min(LIMIT_BOUNDS.geoPromptsPerRun[0]).max(LIMIT_BOUNDS.geoPromptsPerRun[1]),
    providerCallsPerDay: z.number().int().min(LIMIT_BOUNDS.providerCallsPerDay[0]).max(LIMIT_BOUNDS.providerCallsPerDay[1]),
    usdPerDay: z.number().finite().min(LIMIT_BOUNDS.usdPerDay[0]).max(LIMIT_BOUNDS.usdPerDay[1]),
  })
  .partial()
  .strict();

// ------------------------------------------------------------------ mapping

export function toProject(r: ProjectRow): Project {
  return {
    id: r.id,
    workspaceId: r.workspace_id,
    name: r.name,
    siteUrl: r.site_url,
    siteType: r.site_type as Project["siteType"],
    brandName: r.brand_name,
    brandAliases: parseJson<string[]>(r.brand_aliases_json, []),
    competitors: parseJson<Competitor[]>(r.competitors_json, []),
    productDescription: r.product_description,
    audience: r.audience,
    locale: r.locale,
    language: r.language,
    voice: r.voice,
    verifiedHost: r.verified_host,
    verificationMethod: (r.verification_method as Project["verificationMethod"]) ?? null,
    verifiedAt: r.verified_at,
    gscProperty: r.gsc_property,
    scheduleEnabled: r.schedule_enabled === 1,
    isDemo: r.is_demo === 1,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export const siteHost = (siteUrl: string) => new URL(siteUrl).hostname.toLowerCase();

/** Validate, normalize, and check collisions for a full project input. */
export function prepareProjectInput(input: ProjectInput): ProjectInput & { host: string } {
  const { origin, host } = normalizeSiteUrl(input.siteUrl);
  const competitors: Competitor[] = input.competitors.map((c) => ({
    name: c.name.trim(),
    domains: [...new Set(c.domains.map(normalizeDomain))],
    aliases: dedupeTerms(c.aliases),
  }));
  const names = new Set<string>();
  for (const c of competitors) {
    const k = normTerm(c.name);
    if (names.has(k)) throw badRequest(`Competitor listed twice: ${c.name}`);
    names.add(k);
  }
  const brandAliases = dedupeTerms(input.brandAliases).filter((a) => normTerm(a) !== normTerm(input.brandName));
  const prepared = { ...input, siteUrl: origin, brandName: input.brandName.trim(), brandAliases, competitors, host };
  const collisions = findAliasCollisions(prepared);
  if (collisions.length > 0) {
    throw new HttpError(
      400,
      "alias_collision",
      `Brand and competitor names/aliases/domains overlap: ${collisions.map((c) => c.term).join(", ")}. Remove or rename them so each term belongs to one entity.`,
      { collisions },
    );
  }
  return prepared;
}

// ------------------------------------------------------------------ context documents

const factId = () => newId("fact");

export function initialContextDocs(input: ProjectInput): Array<{ kind: ContextKind; content: string; facts: ContextFact[] }> {
  const userFact = (t: string): ContextFact[] => (t.trim() ? [{ id: factId(), text: t.trim().slice(0, 1000), confirmed: true, source: "user" }] : []);
  const competitorLine = (c: Competitor) =>
    `${c.name}${c.domains.length ? ` (${c.domains.join(", ")})` : ""}${c.aliases.length ? `; aliases: ${c.aliases.join(", ")}` : ""}`;
  return [
    { kind: "product", content: input.productDescription, facts: userFact(input.productDescription) },
    { kind: "positioning", content: input.audience, facts: userFact(input.audience) },
    {
      kind: "competitors",
      content: input.competitors.map(competitorLine).join("\n"),
      facts: input.competitors.map((c) => ({ id: factId(), text: competitorLine(c), confirmed: true, source: "user" })),
    },
    { kind: "voice", content: input.voice, facts: userFact(input.voice) },
    { kind: "pillars", content: "", facts: [] },
  ];
}

export interface ContextDocRow {
  id: string;
  kind: ContextKind;
  doc_key?: string;
  title?: string | null;
  version: number;
  content: string;
  facts_json: string;
  created_at: string;
}

/** Insert a new version (max+1) atomically; old versions are never mutated. Returns the new row id. */
export function contextInsertStatement(
  id: string,
  workspaceId: string,
  projectId: string,
  kind: ContextKind,
  content: string,
  facts: ContextFact[],
  userId: string | null,
  now: string,
): [string, ...unknown[]] {
  return [
    `INSERT INTO context_documents (id, workspace_id, project_id, kind, version, content, facts_json, created_by, created_at)
     SELECT ?, ?, ?, ?, COALESCE(MAX(version), 0) + 1, ?, ?, ?, ?
       FROM context_documents WHERE workspace_id = ? AND project_id = ? AND kind = ? AND doc_key = ''`,
    id, workspaceId, projectId, kind, content, JSON.stringify(facts), userId, now, workspaceId, projectId, kind,
  ];
}

export async function listLatestContext(db: Db, workspaceId: string, projectId: string): Promise<ContextDocument[]> {
  const rows = await db.all<ContextDocRow>(
    `SELECT d.id, d.kind, d.doc_key, d.title, d.version, d.content, d.facts_json, d.created_at FROM context_documents d
      WHERE d.workspace_id = ? AND d.project_id = ?
        AND d.version = (SELECT MAX(d2.version) FROM context_documents d2
                          WHERE d2.workspace_id = d.workspace_id AND d2.project_id = d.project_id AND d2.kind = d.kind
                            AND d2.doc_key = d.doc_key)`,
    workspaceId,
    projectId,
  );
  const usage = await contextUsage(db, workspaceId, projectId, rows.map((r) => r.id));
  const order = new Map(CONTEXT_KINDS.map((k, i) => [k, i]));
  return rows
    .map((r) => toContextDocument(r, usage.get(r.id) ?? 0))
    .sort((a, b) => (order.get(a.kind) ?? 9) - (order.get(b.kind) ?? 9) || (a.title ?? "").localeCompare(b.title ?? ""));
}

export async function getContextDoc(db: Db, workspaceId: string, projectId: string, id: string): Promise<ContextDocument | null> {
  const row = await db.first<ContextDocRow>(
    "SELECT id, kind, doc_key, title, version, content, facts_json, created_at FROM context_documents WHERE workspace_id = ? AND project_id = ? AND id = ?",
    workspaceId,
    projectId,
    id,
  );
  if (!row) return null;
  const usage = await contextUsage(db, workspaceId, projectId, [id]);
  return toContextDocument(row, usage.get(id) ?? 0);
}

function toContextDocument(r: ContextDocRow, used: number): ContextDocument {
  const facts = parseJson<ContextFact[]>(r.facts_json, []);
  return {
    id: r.id,
    kind: r.kind,
    ...(r.kind === "imported" ? { docKey: r.doc_key ?? "", title: r.title ?? null } : {}),
    version: r.version,
    content: r.content,
    facts,
    unconfirmedCount: facts.filter((f) => !f.confirmed).length,
    createdAt: r.created_at,
    usedByRecommendationCount: used,
  };
}

/** Recommendations citing evidence rows (source context_doc) that point at each document version. */
async function contextUsage(db: Db, workspaceId: string, projectId: string, docIds: string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (docIds.length === 0) return out;
  const rows = await db.all<{ ref_id: string; n: number }>(
    `SELECT e.ref_id AS ref_id, COUNT(DISTINCT r.id) AS n
       FROM evidence e
       JOIN recommendations r
         ON r.workspace_id = e.workspace_id AND r.project_id = e.project_id
        AND r.evidence_ids_json LIKE '%"' || e.id || '"%'
      WHERE e.workspace_id = ? AND e.project_id = ? AND e.source = 'context_doc'
        AND e.ref_id IN (${docIds.map(() => "?").join(",")})
      GROUP BY e.ref_id`,
    workspaceId,
    projectId,
    ...docIds,
  );
  for (const r of rows) out.set(r.ref_id, Number(r.n));
  return out;
}

export async function putContextDoc(
  db: Db,
  project: ProjectRow,
  kind: ContextKind,
  body: z.infer<typeof contextPutSchema>,
  userId: string,
  now: Date,
): Promise<ContextDocument> {
  const facts: ContextFact[] = body.facts.map((f) => ({ id: f.id ?? factId(), text: f.text, confirmed: f.confirmed, source: f.source ?? "user" }));
  const id = newId("ctx");
  try {
    await db.run(...contextInsertStatement(id, project.workspace_id, project.id, kind, body.content, facts, userId, iso(now)));
  } catch (e) {
    if (e instanceof Error && /UNIQUE/i.test(e.message)) throw conflict("Another edit to this document was saved at the same time. Reload and retry.");
    throw e;
  }
  const doc = await getContextDoc(db, project.workspace_id, project.id, id);
  return doc!;
}

// ------------------------------------------------------------------ project lifecycle

export interface CreateProjectOptions {
  isDemo?: boolean;
  scheduleEnabled?: boolean;
}

export async function createProject(
  db: Db,
  workspaceId: string,
  userId: string,
  rawInput: ProjectInput,
  now: Date,
  opts: CreateProjectOptions = {},
): Promise<ProjectRow> {
  const input = prepareProjectInput(rawInput);
  const count = await db.first<{ n: number }>("SELECT COUNT(*) AS n FROM projects WHERE workspace_id = ?", workspaceId);
  if ((count?.n ?? 0) >= MAX_PROJECTS_PER_WORKSPACE) throw badRequest(`A workspace can have at most ${MAX_PROJECTS_PER_WORKSPACE} projects.`);
  const id = newId("prj");
  const ts = iso(now);
  const statements: Array<[string, ...unknown[]]> = [
    [
      `INSERT INTO projects (id, workspace_id, name, site_url, site_type, brand_name, brand_aliases_json, competitors_json,
         product_description, audience, locale, language, voice, verification_token, schedule_enabled, is_demo, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      id, workspaceId, input.name, input.siteUrl, input.siteType, input.brandName, JSON.stringify(input.brandAliases),
      JSON.stringify(input.competitors), input.productDescription, input.audience, input.locale, input.language, input.voice,
      randomToken(24), (opts.scheduleEnabled ?? !opts.isDemo) ? 1 : 0, opts.isDemo ? 1 : 0, ts, ts,
    ],
    ["INSERT INTO project_limits (project_id, workspace_id, updated_at) VALUES (?, ?, ?)", id, workspaceId, ts],
  ];
  for (const doc of initialContextDocs(input)) {
    statements.push(contextInsertStatement(newId("ctx"), workspaceId, id, doc.kind, doc.content, doc.facts, userId, ts));
  }
  await db.batch(statements);
  return (await loadProjectRow(db, workspaceId, id))!;
}

export async function loadProjectRow(db: Db, workspaceId: string, projectId: string): Promise<ProjectRow | null> {
  return db.first<ProjectRow>("SELECT * FROM projects WHERE workspace_id = ? AND id = ?", workspaceId, projectId);
}

export async function listProjects(db: Db, workspaceId: string): Promise<Project[]> {
  const rows = await db.all<ProjectRow>("SELECT * FROM projects WHERE workspace_id = ? ORDER BY created_at DESC, id", workspaceId);
  return rows.map(toProject);
}

export async function updateProject(db: Db, project: ProjectRow, patch: z.infer<typeof projectPatchSchema>, now: Date): Promise<ProjectRow> {
  const current = toProject(project);
  const merged: ProjectInput = {
    name: patch.name ?? current.name,
    siteUrl: patch.siteUrl ?? current.siteUrl,
    siteType: patch.siteType ?? current.siteType,
    brandName: patch.brandName ?? current.brandName,
    brandAliases: patch.brandAliases ?? current.brandAliases,
    competitors: patch.competitors ?? current.competitors,
    productDescription: patch.productDescription ?? current.productDescription,
    audience: patch.audience ?? current.audience,
    locale: patch.locale ?? current.locale,
    language: patch.language ?? current.language,
    voice: patch.voice ?? current.voice,
  };
  const input = prepareProjectInput(merged);
  const hostChanged = input.host !== siteHost(project.site_url);
  const sets: Array<[string, unknown]> = [
    ["name", input.name],
    ["site_url", input.siteUrl],
    ["site_type", input.siteType],
    ["brand_name", input.brandName],
    ["brand_aliases_json", JSON.stringify(input.brandAliases)],
    ["competitors_json", JSON.stringify(input.competitors)],
    ["product_description", input.productDescription],
    ["audience", input.audience],
    ["locale", input.locale],
    ["language", input.language],
    ["voice", input.voice],
    ["updated_at", iso(now)],
  ];
  if (patch.scheduleEnabled !== undefined) sets.push(["schedule_enabled", patch.scheduleEnabled ? 1 : 0]);
  if (hostChanged) {
    // Ownership was proven for the old host only; the new host must be verified again.
    sets.push(["verified_host", null], ["verification_method", null], ["verified_at", null]);
  }
  await db.run(
    `UPDATE projects SET ${sets.map(([k]) => `${k} = ?`).join(", ")} WHERE workspace_id = ? AND id = ?`,
    ...sets.map(([, v]) => v),
    project.workspace_id,
    project.id,
  );
  return (await loadProjectRow(db, project.workspace_id, project.id))!;
}

/**
 * Remove all tenant data for a project. Tables with a project FK cascade; tables without one
 * (run locks, usage reservations/counters, provider call log, pending OAuth states) are deleted explicitly.
 * Integration revocation is the caller's job (see gsc-oauth.ts) and happens before this.
 */
export async function deleteProjectData(db: Db, workspaceId: string, projectId: string): Promise<void> {
  await db.batch([
    ["DELETE FROM oauth_states WHERE workspace_id = ? AND project_id = ?", workspaceId, projectId],
    // run_locks has no workspace column; the caller has already resolved projectId within workspaceId.
    ["DELETE FROM run_locks WHERE project_id = ?", projectId],
    ["DELETE FROM usage_reservations WHERE workspace_id = ? AND project_id = ?", workspaceId, projectId],
    ["DELETE FROM usage_counters WHERE scope_key = ?", `project:${projectId}`],
    ["DELETE FROM provider_calls WHERE workspace_id = ? AND project_id = ?", workspaceId, projectId],
    ["DELETE FROM projects WHERE workspace_id = ? AND id = ?", workspaceId, projectId],
  ]);
}

// ------------------------------------------------------------------ limits

interface LimitsRow {
  crawl_pages: number;
  gsc_rows: number;
  geo_prompts_per_run: number;
  provider_calls_per_day: number;
  usd_micros_per_day: number;
}

async function ensureLimitsRow(db: Db, workspaceId: string, projectId: string, now: Date): Promise<LimitsRow> {
  await db.run("INSERT OR IGNORE INTO project_limits (project_id, workspace_id, updated_at) VALUES (?, ?, ?)", projectId, workspaceId, iso(now));
  return (await db.first<LimitsRow>(
    "SELECT crawl_pages, gsc_rows, geo_prompts_per_run, provider_calls_per_day, usd_micros_per_day FROM project_limits WHERE workspace_id = ? AND project_id = ?",
    workspaceId,
    projectId,
  ))!;
}

const toLimits = (r: LimitsRow): UsageSummary["limits"] => ({
  crawlPages: r.crawl_pages,
  gscRows: r.gsc_rows,
  geoPromptsPerRun: r.geo_prompts_per_run,
  providerCallsPerDay: r.provider_calls_per_day,
  usdPerDay: r.usd_micros_per_day / 1_000_000,
});

export async function getLimits(db: Db, workspaceId: string, projectId: string, now: Date): Promise<UsageSummary["limits"]> {
  return toLimits(await ensureLimitsRow(db, workspaceId, projectId, now));
}

export async function putLimits(
  db: Db,
  workspaceId: string,
  projectId: string,
  patch: z.infer<typeof limitsPutSchema>,
  now: Date,
): Promise<UsageSummary["limits"]> {
  await ensureLimitsRow(db, workspaceId, projectId, now);
  const sets: Array<[string, unknown]> = [];
  if (patch.crawlPages !== undefined) sets.push(["crawl_pages", patch.crawlPages]);
  if (patch.gscRows !== undefined) sets.push(["gsc_rows", patch.gscRows]);
  if (patch.geoPromptsPerRun !== undefined) sets.push(["geo_prompts_per_run", patch.geoPromptsPerRun]);
  if (patch.providerCallsPerDay !== undefined) sets.push(["provider_calls_per_day", patch.providerCallsPerDay]);
  if (patch.usdPerDay !== undefined) sets.push(["usd_micros_per_day", Math.round(patch.usdPerDay * 1_000_000)]);
  sets.push(["updated_at", iso(now)]);
  await db.run(
    `UPDATE project_limits SET ${sets.map(([k]) => `${k} = ?`).join(", ")} WHERE workspace_id = ? AND project_id = ?`,
    ...sets.map(([, v]) => v),
    workspaceId,
    projectId,
  );
  return getLimits(db, workspaceId, projectId, now);
}

// ------------------------------------------------------------------ route helpers

export const MAX_BODY_BYTES = 128 * 1024;

/** Read and zod-validate a JSON body with a size cap. Errors are 400 with issue paths (no echo of input). */
export async function parseBody<S extends z.ZodType>(c: { req: { text(): Promise<string> } }, schema: S): Promise<z.infer<S>> {
  const raw = await c.req.text();
  if (raw.length > MAX_BODY_BYTES) throw new HttpError(413, "payload_too_large", "Request body is too large.");
  let json: unknown;
  try {
    json = raw ? JSON.parse(raw) : {};
  } catch {
    throw badRequest("Request body must be JSON.");
  }
  const parsed = schema.safeParse(json);
  if (!parsed.success) {
    throw badRequest(
      "Invalid request body.",
      parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
    );
  }
  return parsed.data;
}
