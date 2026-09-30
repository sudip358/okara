/**
 * [A22] GEO coverage inputs: API-sampled observations of the LATEST cohort per provider (same selection
 * as the GEO results lanes: prompt-set version + model + grounding configuration), their citations and
 * the engine search queries the provider exposed. Manual imports are excluded (never API-sampled).
 *
 * Self detection is by parsed hostname only ([GEO AGENT] rules): a citation is "your site" when its host
 * (from the URL, or for Gemini redirect links the bare-domain title, via geo/detect.resolveCitationHost)
 * equals or is a subdomain of one of the project's own domains (geo/detect.selfDomains: site URL host,
 * verified host and its registrable domain, sc-domain property). Never a substring match.
 */
import type { SourceType } from "@shared/types";
import type { Db } from "../lib/db";
import type { ProjectRow } from "../platform/access";
import { hostMatchesDomain, resolveCitationHost, selfDomains } from "../geo/detect";
import { isSourceType } from "../geo/source-type";
import { normalizeQuery } from "../geo/analyze";
import { inChunks } from "./common";

export const OBSERVATION_LOAD_LIMIT = 2000;

export interface CovObservation {
  id: string;
  promptId: string | null;
  promptText: string;
  promptType: "discovery" | "reputation";
  provider: string;
  model: string;
  cohortKey: string;
  status: "ok" | "failed" | "incomplete";
  grounded: boolean;
  createdAt: string;
}

export interface CovCitation {
  observationId: string;
  url: string;
  /** Resolved, normalized host (null when unresolvable). */
  host: string | null;
  /** 'url' = page URL known; 'title' = provider redirect link, host from the bare-domain title. */
  via: "url" | "title" | "unresolved";
  self: boolean;
  sourceType: SourceType;
  position: number | null;
}

export interface GeoSample {
  domains: string[];
  /** Latest-cohort API observations per provider, newest first. */
  observations: CovObservation[];
  citations: Map<string, CovCitation[]>;
  /** Normalized engine search queries per observation (only those the provider exposed). */
  queries: Map<string, string[]>;
  /** All API observations stored for the project (any cohort). */
  apiObservationCount: number;
  manualObservationCount: number;
}

export function isSelfHost(host: string | null, domains: string[]): boolean {
  if (!host) return false;
  return domains.some((d) => hostMatchesDomain(host, d));
}

export function resolveCitation(
  row: { observation_id: string; url: string; title: string | null; position: number | null; source_type: string },
  domains: string[],
): CovCitation {
  const r = resolveCitationHost(row.url, row.title);
  return {
    observationId: row.observation_id,
    url: row.url,
    host: r.host,
    via: r.via,
    self: isSelfHost(r.host, domains),
    sourceType: isSourceType(row.source_type) ? row.source_type : "other",
    position: row.position,
  };
}

interface ObsRow {
  id: string;
  prompt_id: string | null;
  prompt_text: string;
  prompt_type: string;
  provider: string;
  model: string;
  cohort_key: string;
  status: "ok" | "failed" | "incomplete";
  grounded: number;
  created_at: string;
}

/** Latest cohort per provider; rows must be newest first. */
export function latestCohortPerProvider<T extends { provider: string; cohort_key: string }>(rows: T[]): T[] {
  const cohortOf = new Map<string, string>();
  for (const r of rows) if (!cohortOf.has(r.provider)) cohortOf.set(r.provider, r.cohort_key);
  return rows.filter((r) => cohortOf.get(r.provider) === r.cohort_key);
}

export async function loadGeoSample(db: Db, project: ProjectRow): Promise<GeoSample> {
  const ws = project.workspace_id;
  const pid = project.id;
  const domains = selfDomains(project);
  const rows = await db.all<ObsRow>(
    `SELECT id, prompt_id, prompt_text, prompt_type, provider, model, cohort_key, status, grounded, created_at
       FROM geo_observations WHERE workspace_id = ? AND project_id = ? AND measurement_type = 'api'
      ORDER BY created_at DESC, rowid DESC LIMIT ${OBSERVATION_LOAD_LIMIT}`,
    ws,
    pid,
  );
  const manual = await db.first<{ n: number }>(
    "SELECT COUNT(*) AS n FROM geo_observations WHERE workspace_id = ? AND project_id = ? AND measurement_type = 'manual_import'",
    ws,
    pid,
  );
  const latest = latestCohortPerProvider(rows);
  const observations: CovObservation[] = latest.map((r) => ({
    id: r.id,
    promptId: r.prompt_id,
    promptText: r.prompt_text,
    promptType: r.prompt_type === "reputation" ? "reputation" : "discovery",
    provider: r.provider,
    model: r.model,
    cohortKey: r.cohort_key,
    status: r.status,
    grounded: r.grounded === 1,
    createdAt: r.created_at,
  }));
  const ids = observations.filter((o) => o.status === "ok").map((o) => o.id);

  const citationRows = await inChunks(ids, (chunk, ph) =>
    db.all<{ observation_id: string; url: string; title: string | null; position: number | null; source_type: string }>(
      `SELECT observation_id, url, title, position, source_type FROM geo_citations
        WHERE workspace_id = ? AND project_id = ? AND observation_id IN (${ph}) ORDER BY position IS NULL, position, rowid`,
      ws,
      pid,
      ...chunk,
    ),
  );
  const citations = new Map<string, CovCitation[]>();
  for (const row of citationRows) {
    const c = resolveCitation(row, domains);
    if (!citations.has(c.observationId)) citations.set(c.observationId, []);
    citations.get(c.observationId)!.push(c);
  }

  const queryRows = await inChunks(ids, (chunk, ph) =>
    db.all<{ observation_id: string; query: string; normalized: string }>(
      `SELECT observation_id, query, normalized FROM geo_search_queries
        WHERE workspace_id = ? AND project_id = ? AND observation_id IN (${ph}) ORDER BY rowid`,
      ws,
      pid,
      ...chunk,
    ),
  );
  const queries = new Map<string, string[]>();
  for (const q of queryRows) {
    const n = normalizeQuery(q.normalized || q.query);
    if (!n) continue;
    const list = queries.get(q.observation_id) ?? [];
    if (!list.includes(n)) list.push(n);
    queries.set(q.observation_id, list);
  }

  return { domains, observations, citations, queries, apiObservationCount: rows.length, manualObservationCount: manual?.n ?? 0 };
}

/** Observations answering one prompt (by id; legacy rows without prompt_id match by exact text). */
export function observationsForPrompt(sample: GeoSample, prompt: { id: string; text: string }): CovObservation[] {
  return sample.observations.filter((o) => o.promptId === prompt.id || (o.promptId === null && o.promptText === prompt.text));
}

/** Most common source type among citations (ties: first seen). */
export function dominantSourceType(cits: CovCitation[]): SourceType {
  const counts = new Map<SourceType, number>();
  for (const c of cits) counts.set(c.sourceType, (counts.get(c.sourceType) ?? 0) + 1);
  let best: SourceType = "other";
  let n = 0;
  for (const [t, k] of counts) {
    if (k > n) {
      best = t;
      n = k;
    }
  }
  return best;
}
