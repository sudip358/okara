/**
 * [A7] Competitor pages read for why an AI engine cites them (docs/api.md "POST/GET
 * /projects/:pid/geo/competitor-pages"). Okara never crawls competitor domains on its own: a member
 * approves reading ONE URL that a stored API-sampled answer of this project cited, and that single URL is
 * fetched once:
 *   - the canonical URL must equal a geo_citations.url of the project (workspace_id + project_id);
 *     approval is per URL, never per domain; our own hosts and provider redirect wrappers are refused;
 *   - robots.txt of the host is fetched first and respected for our crawler token (OkaraBot); when a redirect
 *     moves to the www. twin, that host's robots.txt (RFC 9309: per host) is checked before the hop is requested;
 *   - the page is fetched through seo/ssrf.ts approvedExternalFetch (public hostname, no IP literals,
 *     manual redirects re-checked per hop and limited to the host or its www. twin, crawler size/time caps);
 *   - only compact evidence is stored (counts, types, dates, a 400-character opening); never the full text.
 * Page text is untrusted evidence: it is screened with evidence.injection_risk and then handed to Jev as
 * `state` for two Noul questions (answer_first, entity); everything else is measured in code.
 *
 * Verdict (VERDICT_VERSION, computed in code, never by a model):
 *   review  the injection screen flagged the page or was unavailable (fails closed: a screen error or budget
 *           stop treats the evidence as untrusted), any Jev check is tier 'flag', or the fetch was partial;
 *   adapt   2+ checks are present on their page and missing on our matched page (adapt the structure; never
 *           copy their text). With no matched page of ours every check of ours is 'unknown', so there are
 *           no gaps and the verdict is never 'adapt';
 *   skip    otherwise.
 * Only API-sampled answers authorise a fetch: manual imports (pasted text) never make a URL approvable.
 * Budget: 1 crawl_pages unit reserved before any fetch (released when the page itself is not requested);
 * Jev calls reserve provider_calls + jev_calls per call inside the DecisionProvider (at most 2 calls:
 * injection screen, then answer_first + entity together).
 */
import type {
  CompetitorCheck,
  CompetitorCheckKey,
  CompetitorPageAssessment,
  FactorStatus,
  SkipFactorKey,
  SourceType,
  Tier,
} from "@shared/types";
import type { Env } from "../env";
import type { Db } from "../lib/db";
import { parseJson } from "../lib/db";
import { badRequest, BudgetExceededError, HttpError } from "../lib/errors";
import { hashJson } from "../lib/hash";
import { newId } from "../lib/ids";
import { iso } from "../lib/time";
import type { ProjectRow } from "../platform/access";
import type { DecisionAnswer, DecisionProvider, DecisionResult } from "../providers/types";
import type { Budget } from "../runs/context";
import { DEFAULT_NOUL_BANDS, POLICY_VERSION, QUESTION_POLICY, tierFor } from "../runs/policy";
import { computeAnswerCoverage } from "../coverage/answer-coverage";
import { brandTokenSet } from "../coverage/answer-coverage";
import { sanitizeForState } from "../draftcheck/jev";
import { CRAWLER_UA_TOKEN, crawlerUserAgent, parseRobots, robotsAllows, ROBOTS_MAX_BYTES, type ParsedRobots, type RobotsState } from "../seo/crawl/robots";
import { extractPage } from "../seo/crawl/extract";
import { approvedExternalFetch, assertApprovedExternalUrl, CrawlFetchError } from "../seo/ssrf";
import { GEMINI_REDIRECT_HOST, hostMatchesDomain, normalizeDomain, selfDomains } from "./detect";
import { COMPETITOR_QUESTION_IDS, GEO_QUESTION_IDS, competitorQuestion, competitorQuestionVersion, geoQuestion, geoQuestionVersion } from "./questions";
import { evaluateFactors, FACTOR_THRESHOLDS, isQuestionHeading, countNumericFacts, loadOurPageEvidence, type CitedPageLookup, type PageEvidence } from "./skip-factors";
import { isSourceType } from "./source-type";

export const COMPETITOR_PAGE_RATE_LIMIT = { limit: 10, windowSeconds: 3600 } as const;
export const REAPPROVE_WINDOW_DAYS = 7;
/** An in-flight row (queued/fetching) younger than this is returned instead of starting a second fetch. */
export const IN_FLIGHT_MINUTES = 10;
export const VERDICT_VERSION = "competitor-verdict.v1";
export const COMPETITOR_PURPOSE = "geo.competitor_page";
export const COMPETITOR_FETCH = { maxBytes: 2 * 1024 * 1024, timeoutMs: 12_000, maxRedirects: 5, robotsTimeoutMs: 10_000 } as const;
/** Engineering default: a page at or above this many words counts as in-depth. */
export const DEPTH_WORDS = 600;
export const MAX_URL_LENGTH = 2048;
export const LIST_LIMIT = 100;
const CITED_IN_LIMIT = 20;
const STATE_CAPS = { question: 300, title: 300, heading: 120, headings: 30, opening: 600, text: 6000 } as const;
const PAGE_REF = "cited_page";
type CheckTier = NonNullable<CompetitorCheck["tier"]>;
const DAY_MS = 86_400_000;

export const CHECK_LABELS: Record<CompetitorCheckKey, string> = {
  answer_first: "Answer first",
  depth: "Depth",
  proof: "Sources cited",
  schema: "Structured data",
  freshness: "Freshness",
  author: "Author byline",
  entity: "Entity facts",
  faq: "FAQ",
};
const CHECK_ORDER: readonly CompetitorCheckKey[] = ["answer_first", "depth", "proof", "schema", "freshness", "author", "entity", "faq"];
const JEV_CHECKS: ReadonlySet<CompetitorCheckKey> = new Set(["answer_first", "entity"]);

/** Compact evidence stored per assessment (extraction_json). No full page text. */
export interface CompetitorExtraction {
  title: string | null;
  wordCount: number | null;
  opening: string | null;
  headings: Array<{ level: number; text: string }>;
  jsonldTypes: string[];
  author: string | null;
  lastUpdated: string | null;
  outboundCitations: number | null;
  tableCount: number | null;
  questionHeadings: number;
  numericFacts: number;
  /** Prompt text the page was compared against (first prompt whose answers cited it). */
  question: string | null;
  /** Their page's factors (same definitions as our skip factors; internal links not measurable). */
  factors: Partial<Record<SkipFactorKey, { status: FactorStatus; measured: string; value: number | null }>>;
  /** Presence per check used by the verdict. */
  presence: Partial<Record<CompetitorCheckKey, FactorStatus>>;
  ourPage: { pageId: string; url: string } | null;
  /** Checks present on their page and missing on ours (the adapt rule). */
  gaps: CompetitorCheckKey[];
  /** not_run: Jev not configured or no question; unavailable: the screen call failed (treated like flagged). */
  injectionScreen: "clean" | "flagged" | "unavailable" | "not_run";
}

// ------------------------------------------------------------------ URL helpers
/** Canonical form for per-URL approval: http(s), lowercase host without trailing dot, no fragment. */
export function canonicalExternalUrl(raw: string): string | null {
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    return null;
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") return null;
  if (u.username || u.password) return null;
  u.hash = "";
  u.hostname = u.hostname.toLowerCase().replace(/\.+$/, "");
  return u.toString();
}

// ------------------------------------------------------------------ rows
interface CompetitorRow {
  id: string;
  workspace_id: string;
  project_id: string;
  url: string;
  host: string;
  approved_by: string;
  approved_at: string;
  fetched_at: string | null;
  status: CompetitorPageAssessment["state"];
  status_detail: string | null;
  http_status: number | null;
  final_url: string | null;
  partial: number;
  extraction_json: string;
  checks_json: string;
  reasons_json: string;
  verdict: CompetitorPageAssessment["verdict"];
  verdict_version: string | null;
  created_at: string;
}

export interface CitationUse {
  url: string;
  source_type: string;
  observation_id: string;
  prompt_id: string | null;
  prompt_text: string;
  provider: string;
  host: string;
}

/**
 * Stored citations of API-sampled answers (measurement_type 'api'; manual imports never qualify) of this
 * project whose canonical URL equals one of `urls`, newest first. Hosts are queried in chunks of 90
 * (+2 tenancy params, under the D1 100-parameter limit).
 */
export async function citationUses(db: Db, ws: string, pid: string, urls: string[]): Promise<Map<string, CitationUse[]>> {
  const byUrl = new Map<string, CitationUse[]>();
  const hosts = [
    ...new Set(
      urls
        .map((u) => {
          try {
            return normalizeDomain(new URL(u).hostname);
          } catch {
            return null;
          }
        })
        .filter((h): h is string => !!h),
    ),
  ];
  const wanted = new Set(urls);
  for (let i = 0; i < hosts.length; i += 90) {
    const chunk = hosts.slice(i, i + 90);
    const rows = await db.all<CitationUse>(
      // Newest uses per stored URL (not per chunk), so a busy host such as reddit.com cannot crowd the
      // requested URLs out of a fixed-size result.
      `SELECT url, source_type, observation_id, host, prompt_id, prompt_text, provider FROM (
         SELECT c.url, c.source_type, c.observation_id, c.host, o.prompt_id, o.prompt_text, o.provider,
                ROW_NUMBER() OVER (PARTITION BY c.url ORDER BY o.created_at DESC, c.rowid DESC) AS rn
           FROM geo_citations c JOIN geo_observations o ON o.id = c.observation_id AND o.workspace_id = c.workspace_id AND o.project_id = c.project_id
          WHERE c.workspace_id = ? AND c.project_id = ? AND o.measurement_type = 'api' AND c.host IN (${chunk.map(() => "?").join(",")})
       ) WHERE rn <= 20`,
      ws,
      pid,
      ...chunk,
    );
    for (const r of rows) {
      const k = canonicalExternalUrl(r.url);
      if (!k || !wanted.has(k)) continue;
      if (!byUrl.has(k)) byUrl.set(k, []);
      byUrl.get(k)!.push(r);
    }
  }
  return byUrl;
}

function dominantType(uses: CitationUse[]): SourceType {
  const counts = new Map<SourceType, number>();
  for (const u of uses) {
    const t: SourceType = isSourceType(u.source_type) ? u.source_type : "other";
    counts.set(t, (counts.get(t) ?? 0) + 1);
  }
  let best: SourceType = "other";
  let n = 0;
  for (const [t, k] of counts) if (k > n) [best, n] = [t, k];
  return best;
}

function toAssessment(row: CompetitorRow, uses: CitationUse[]): CompetitorPageAssessment {
  const seen = new Set<string>();
  const citedIn: CompetitorPageAssessment["citedIn"] = [];
  for (const u of uses) {
    const k = `${u.prompt_id ?? u.prompt_text}\u0000${u.provider}`;
    if (seen.has(k)) continue;
    seen.add(k);
    citedIn.push({ promptId: u.prompt_id, promptText: u.prompt_text, provider: u.provider, observationId: u.observation_id });
    if (citedIn.length >= CITED_IN_LIMIT) break;
  }
  let host = row.host;
  try {
    host = new URL(row.url).hostname;
  } catch {
    /* keep stored */
  }
  return {
    id: row.id,
    url: row.url,
    host,
    approvedAt: row.approved_at,
    approvedBy: row.approved_by,
    fetchedAt: row.fetched_at,
    sourceType: dominantType(uses),
    citedIn,
    checks: parseJson<CompetitorCheck[]>(row.checks_json, []),
    reasons: parseJson<unknown[]>(row.reasons_json, []).filter((r): r is string => typeof r === "string"),
    verdict: row.verdict,
    state: row.status,
    stateDetail: row.status_detail,
  };
}

export async function listCompetitorPages(db: Db, project: Pick<ProjectRow, "id" | "workspace_id">): Promise<CompetitorPageAssessment[]> {
  const rows = await db.all<CompetitorRow>(
    `SELECT * FROM competitor_pages WHERE workspace_id = ? AND project_id = ? ORDER BY approved_at DESC, rowid DESC LIMIT ${LIST_LIMIT}`,
    project.workspace_id,
    project.id,
  );
  const uses = await citationUses(db, project.workspace_id, project.id, [...new Set(rows.map((r) => r.url))]);
  return rows.map((r) => toAssessment(r, uses.get(r.url) ?? []));
}

export async function getCompetitorPage(db: Db, project: Pick<ProjectRow, "id" | "workspace_id">, id: string): Promise<CompetitorPageAssessment | null> {
  const row = await db.first<CompetitorRow>("SELECT * FROM competitor_pages WHERE workspace_id = ? AND project_id = ? AND id = ?", project.workspace_id, project.id, id);
  if (!row) return null;
  const uses = await citationUses(db, project.workspace_id, project.id, [row.url]);
  return toAssessment(row, uses.get(row.url) ?? []);
}

/**
 * CitedPageLookup for skip factors: the latest assessed approval on `host` (www-less), preferring one
 * compared against the same question.
 */
export const citedPageFactors: CitedPageLookup = async (db, project, host, question) => {
  const h = normalizeDomain(host);
  if (!h) return null;
  const rows = await db.all<{ id: string; extraction_json: string }>(
    "SELECT id, extraction_json FROM competitor_pages WHERE workspace_id = ? AND project_id = ? AND host = ? AND status = 'assessed' ORDER BY approved_at DESC, rowid DESC LIMIT 20",
    project.workspace_id,
    project.id,
    h,
  );
  if (rows.length === 0) return null;
  const parsed = rows.map((r) => ({ id: r.id, x: parseJson<Partial<CompetitorExtraction>>(r.extraction_json, {}) }));
  const pick = (question ? parsed.find((p) => p.x.question === question) : undefined) ?? parsed[0]!;
  const factors = new Map<SkipFactorKey, { status: FactorStatus; measured: string; value: number | null }>();
  for (const [k, v] of Object.entries(pick.x.factors ?? {})) if (v) factors.set(k as SkipFactorKey, v);
  return { id: pick.id, factors };
};

// ------------------------------------------------------------------ approval
export interface CompetitorDeps {
  env: Env;
  db: Db;
  project: ProjectRow;
  userId: string;
  now: Date;
  /** Platform fetch for the single approved URL (wrapped by approvedExternalFetch); tests inject a fake. */
  fetchImpl: typeof fetch;
  /** Jev; null = not configured (measured checks only). */
  decisions: DecisionProvider | null;
  /** Project budget (crawl_pages). */
  budget: Budget;
  /** Rate limiter (hitRateLimit-compatible). */
  rateLimit: (key: string, limit: number, windowSeconds: number) => Promise<{ allowed: boolean; retryAfterSeconds: number }>;
}

export class RateLimitedError extends HttpError {
  constructor(public readonly retryAfterSeconds: number) {
    super(429, "rate_limited", "Too many competitor-page approvals for this project. Try again later.");
  }
}

/** Validate the URL and find the stored citations that make it approvable. Throws 400 with details.reason. */
export async function resolveApprovableUrl(db: Db, project: ProjectRow, raw: string): Promise<{ url: string; host: string; uses: CitationUse[] }> {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > MAX_URL_LENGTH) throw badRequest("url must be an http(s) URL of at most 2,048 characters.", { reason: "invalid_url" });
  const url = canonicalExternalUrl(raw);
  if (!url) throw badRequest("url must be an http(s) URL without credentials.", { reason: "invalid_url" });
  const parsedHost = new URL(url).hostname;
  const host = normalizeDomain(parsedHost);
  if (!host) throw badRequest("url must have a public hostname.", { reason: "invalid_url" });
  if (host === GEMINI_REDIRECT_HOST) throw badRequest("This is a provider redirect link, not the cited page; its destination is unknown.", { reason: "redirect_wrapper" });
  if (selfDomains(project).some((d) => hostMatchesDomain(host, d))) {
    throw badRequest("This URL is on your own site; your pages are read by the crawl.", { reason: "own_site" });
  }
  try {
    assertApprovedExternalUrl(url, parsedHost);
  } catch {
    throw badRequest("url must be on a public hostname (no IP addresses, local names, or non-default ports).", { reason: "blocked_url" });
  }
  const uses = (await citationUses(db, project.workspace_id, project.id, [url])).get(url) ?? [];
  if (uses.length === 0) throw badRequest("Only a URL that a stored AI answer of this project cited can be approved.", { reason: "url_not_cited" });
  return { url, host, uses };
}

async function fetchRobotsFor(fetchImpl: typeof fetch, origin: URL, userAgent: string): Promise<RobotsState> {
  const empty: ParsedRobots = { groups: [], sitemaps: [] };
  try {
    const res = await approvedExternalFetch(fetchImpl, `${origin.protocol}//${origin.host}/robots.txt`, {
      approvedHost: origin.hostname,
      maxBytes: ROBOTS_MAX_BYTES,
      timeoutMs: COMPETITOR_FETCH.robotsTimeoutMs,
      maxRedirects: 5,
      kind: "robots",
      lenientContentType: true,
      truncateAtCap: true,
      userAgent,
    });
    if (res.status >= 200 && res.status < 300) return { status: "ok", httpStatus: res.status, parsed: parseRobots(res.body), note: `robots.txt fetched (${res.status}).` };
    if (res.status >= 400 && res.status < 500 && res.status !== 429) return { status: "not_found", httpStatus: res.status, parsed: empty, note: `robots.txt returned ${res.status}; allow-all (RFC 9309).` };
    return { status: "unreachable", httpStatus: res.status, parsed: empty, note: `robots.txt returned ${res.status}; treated as disallow-all (RFC 9309).` };
  } catch (e) {
    const code = e instanceof CrawlFetchError ? e.code : "error";
    return { status: "unreachable", httpStatus: null, parsed: empty, note: `robots.txt unreachable (${code}); treated as disallow-all (RFC 9309).` };
  }
}

class RobotsBlockedError extends Error {
  constructor(
    public readonly host: string,
    public readonly unreachable: boolean,
  ) {
    super(`robots.txt of ${host} disallows`);
    this.name = "RobotsBlockedError";
  }
}

const LOGIN_PATH = /\/(login|log-in|signin|sign-in|sign_in|auth|account\/login|users\/sign_in)(\/|$|\?)/i;

function fmt(n: number): string {
  return n.toLocaleString("en-US");
}

const noulOf = (a: DecisionAnswer | undefined): number | null => (a && a.type === "noul" && Number.isFinite(a.noul) ? a.noul : null);

interface JevOutcome {
  status: "answered" | "not_configured" | "budget" | "error" | "flagged";
  screen: CompetitorExtraction["injectionScreen"];
  answers: Partial<Record<"answer_first" | "entity", { noul: number | null; tier: CheckTier | null }>>;
  provider: string | null;
  model: string | null;
}

async function askJev(deps: CompetitorDeps, assessmentId: string, state: { question: string; cited_page: Record<string, unknown> }, screenText: string): Promise<JevOutcome> {
  const { decisions, db, project } = deps;
  if (!decisions) return { status: "not_configured", screen: "not_run", answers: {}, provider: null, model: null };
  const ws = project.workspace_id;
  const pid = project.id;
  const now = iso(deps.now);
  const stmts: Array<[string, ...unknown[]]> = [];
  const record = async (
    questionId: string,
    version: string,
    key: string,
    stateHash: string,
    res: DecisionResult | null,
    answer: DecisionAnswer | undefined,
    tier: Tier | null,
    outcome: "selected" | "rejected",
    reason: string | null,
  ) => {
    stmts.push([
      `INSERT INTO decision_records (id, workspace_id, project_id, run_id, agent, candidate_key, question_id, question_version, policy_version, provider, model, state_hash, answer_json, tier, outcome, reason_code, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      newId("dec"), ws, pid, null, "geo", `competitor:${assessmentId}:${key}`, questionId, version, POLICY_VERSION,
      res?.provider ?? decisions.name, res?.model ?? null, stateHash, JSON.stringify({ answer: answer ?? null, question: key }), tier, outcome, reason, now,
    ]);
  };
  const out: JevOutcome = { status: "answered", screen: "not_run", answers: {}, provider: null, model: null };
  const flushRecords = async () => {
    if (stmts.length) await db.batch(stmts);
  };
  const failStatus = (e: unknown): JevOutcome["status"] => (e instanceof BudgetExceededError ? "budget" : "error");

  // 1. injection screen over the untrusted page text.
  const screenState = { text: screenText };
  const screenHash = await hashJson(screenState);
  const screenVersion = await geoQuestionVersion(GEO_QUESTION_IDS.injectionRisk);
  let screen: DecisionResult | null = null;
  try {
    screen = await decisions.decide({ purpose: COMPETITOR_PURPOSE, state: screenState, questions: { injection_risk: geoQuestion(GEO_QUESTION_IDS.injectionRisk, "text") } });
  } catch (e) {
    // Fail closed [A14]: an unreachable screen means the text was never cleared.
    out.status = failStatus(e);
    out.screen = "unavailable";
    await record(GEO_QUESTION_IDS.injectionRisk, screenVersion, "injection_risk", screenHash, null, undefined, null, "rejected", out.status === "budget" ? "budget" : "decision_unavailable");
    await flushRecords();
    return out;
  }
  out.provider = screen.provider;
  out.model = screen.model;
  const sa = screen.answers["injection_risk"];
  const noBand = QUESTION_POLICY[GEO_QUESTION_IDS.injectionRisk]?.noul?.no ?? DEFAULT_NOUL_BANDS.no;
  const sn = noulOf(sa);
  const clean = sn !== null && sn <= noBand;
  out.screen = clean ? "clean" : "flagged";
  await record(GEO_QUESTION_IDS.injectionRisk, screenVersion, "injection_risk", screenHash, screen, sa, tierFor(GEO_QUESTION_IDS.injectionRisk, sa), clean ? "selected" : "rejected", clean ? null : "injection_risk");
  if (!clean) {
    out.status = "flagged";
    await flushRecords();
    return out;
  }

  // 2. the two Noul checks, asked together against the page state.
  const stateHash = await hashJson(state);
  const qs = {
    answer_first: { id: COMPETITOR_QUESTION_IDS.answerFirst, q: competitorQuestion(COMPETITOR_QUESTION_IDS.answerFirst, PAGE_REF) },
    entity: { id: COMPETITOR_QUESTION_IDS.entity, q: competitorQuestion(COMPETITOR_QUESTION_IDS.entity, PAGE_REF) },
  } as const;
  let res: DecisionResult | null = null;
  try {
    res = await decisions.decide({ purpose: COMPETITOR_PURPOSE, state, questions: { answer_first: qs.answer_first.q, entity: qs.entity.q } });
    out.provider = res.provider;
    out.model = res.model;
  } catch (e) {
    out.status = failStatus(e);
  }
  for (const key of ["answer_first", "entity"] as const) {
    const version = await competitorQuestionVersion(qs[key].id);
    const a = res?.answers[key];
    const noul = noulOf(a);
    if (!res || noul === null) {
      out.answers[key] = { noul: null, tier: null };
      await record(qs[key].id, version, key, stateHash, res, a, res ? "drop" : null, "rejected", res ? "decision_unavailable" : out.status === "budget" ? "budget" : "decision_unavailable");
      continue;
    }
    const tier = tierFor(qs[key].id, a);
    out.answers[key] = { noul, tier: tier === "n/a" ? null : tier };
    await record(qs[key].id, version, key, stateHash, res, a, tier, tier === "drop" ? "rejected" : "selected", tier === "drop" ? "insufficient_evidence" : null);
  }
  await flushRecords();
  return out;
}

function jevPresence(a: { noul: number | null; tier: CheckTier | null } | undefined): FactorStatus {
  if (!a || a.noul === null || a.tier === null || a.tier === "drop") return "unknown";
  if (a.tier === "flag") return "unknown";
  return a.noul >= 0.5 ? "present" : "missing";
}

const ALL_UNKNOWN: Record<CompetitorCheckKey, FactorStatus> = { answer_first: "unknown", depth: "unknown", proof: "unknown", schema: "unknown", freshness: "unknown", author: "unknown", entity: "unknown", faq: "unknown" };

/**
 * Our matched page's status per check (from our skip factors). "unknown" everywhere when no page matched
 * or it has no usable crawl: nothing is compared, so there are no gaps and the verdict cannot be 'adapt'.
 */
function ourPresence(ourFactors: Map<SkipFactorKey, FactorStatus> | null, ourWordCount: number | null, ourJsonld: string[] | null): Record<CompetitorCheckKey, FactorStatus> {
  if (!ourFactors) return { ...ALL_UNKNOWN };
  return {
    answer_first: ourFactors.get("answer_first") ?? "unknown",
    depth: ourWordCount === null ? "unknown" : ourWordCount >= DEPTH_WORDS ? "present" : "missing",
    proof: ourFactors.get("sources_cited") ?? "unknown",
    schema: ourJsonld === null ? "unknown" : ourJsonld.length > 0 ? "present" : "missing",
    freshness: ourFactors.get("freshness") ?? "unknown",
    author: ourFactors.get("author") ?? "unknown",
    entity: ourFactors.get("entity_facts") ?? "unknown",
    faq: ourFactors.get("faq_schema") ?? "unknown",
  };
}

/** competitor-verdict.v1 (pure). */
export function computeVerdict(input: { checks: CompetitorCheck[]; partial: boolean; screenFlagged: boolean; theirs: Partial<Record<CompetitorCheckKey, FactorStatus>>; ours: Record<CompetitorCheckKey, FactorStatus> }): {
  verdict: "adapt" | "skip" | "review";
  gaps: CompetitorCheckKey[];
} {
  const gaps = CHECK_ORDER.filter((k) => input.theirs[k] === "present" && input.ours[k] === "missing");
  if (input.partial || input.screenFlagged || input.checks.some((c) => c.method === "jev" && c.tier === "flag")) return { verdict: "review", gaps };
  return { verdict: gaps.length >= 2 ? "adapt" : "skip", gaps };
}

/**
 * Approve reading one cited URL. Returns the existing assessment (200) when the URL was assessed in the
 * last REAPPROVE_WINDOW_DAYS days or is in flight; otherwise fetches it once and returns 202.
 */
export async function approveCompetitorPage(deps: CompetitorDeps, rawUrl: string): Promise<{ status: 200 | 202; assessment: CompetitorPageAssessment }> {
  const { db, project, now } = deps;
  const ws = project.workspace_id;
  const pid = project.id;
  const { url, host, uses } = await resolveApprovableUrl(db, project, rawUrl);

  const recent = await db.first<CompetitorRow>(
    `SELECT * FROM competitor_pages WHERE workspace_id = ? AND project_id = ? AND url = ?
        AND ((status = 'assessed' AND approved_at >= ?) OR (status IN ('queued', 'fetching') AND approved_at >= ?))
      ORDER BY approved_at DESC, rowid DESC LIMIT 1`,
    ws,
    pid,
    url,
    iso(new Date(now.getTime() - REAPPROVE_WINDOW_DAYS * DAY_MS)),
    iso(new Date(now.getTime() - IN_FLIGHT_MINUTES * 60_000)),
  );
  if (recent) return { status: 200, assessment: toAssessment(recent, uses) };

  const rl = await deps.rateLimit(`competitor_page:${pid}`, COMPETITOR_PAGE_RATE_LIMIT.limit, COMPETITOR_PAGE_RATE_LIMIT.windowSeconds);
  if (!rl.allowed) throw new RateLimitedError(rl.retryAfterSeconds);

  let reservation: string;
  try {
    reservation = await deps.budget.reserve("crawl_pages", 1);
  } catch (e) {
    if (e instanceof BudgetExceededError) throw new HttpError(429, "budget_exceeded", "Daily usage limit reached for this project; try again tomorrow.");
    throw e;
  }

  const id = newId("cmp");
  const stamp = iso(now);
  await db.insert("competitor_pages", {
    id,
    workspace_id: ws,
    project_id: pid,
    url,
    host,
    approved_by: deps.userId,
    approved_at: stamp,
    status: "queued",
    created_at: stamp,
    updated_at: stamp,
  });
  const finish = async (fields: Record<string, unknown>) => {
    const keys = Object.keys(fields);
    await db.run(
      `UPDATE competitor_pages SET ${keys.map((k) => `${k} = ?`).join(", ")}, updated_at = ? WHERE id = ? AND workspace_id = ? AND project_id = ?`,
      ...keys.map((k) => fields[k]),
      iso(deps.now),
      id,
      ws,
      pid,
    );
  };

  let pageRequested = false;
  try {
    await finish({ status: "fetching" });
    const result = await fetchAndAssess(deps, id, url, uses, () => {
      pageRequested = true;
    });
    await finish(result);
  } catch (e) {
    await finish({ status: "failed", status_detail: "Unexpected error while reading the page." }).catch(() => undefined);
    if (pageRequested) await deps.budget.settle(reservation, 1).catch(() => undefined);
    else await deps.budget.release(reservation).catch(() => undefined);
    if (e instanceof HttpError) throw e;
    const row = await db.first<CompetitorRow>("SELECT * FROM competitor_pages WHERE id = ? AND workspace_id = ? AND project_id = ?", id, ws, pid);
    return { status: 202, assessment: toAssessment(row!, uses) };
  }
  if (pageRequested) await deps.budget.settle(reservation, 1);
  else await deps.budget.release(reservation);

  const row = await db.first<CompetitorRow>("SELECT * FROM competitor_pages WHERE id = ? AND workspace_id = ? AND project_id = ?", id, ws, pid);
  return { status: 202, assessment: toAssessment(row!, uses) };
}

/** Robots, one guarded GET, extraction, measured + Jev checks, verdict. Returns the columns to store. */
async function fetchAndAssess(deps: CompetitorDeps, id: string, url: string, uses: CitationUse[], onRequest: () => void): Promise<Record<string, unknown>> {
  const { env, db, project, now } = deps;
  const ua = crawlerUserAgent(env.APP_ORIGIN);
  const target = new URL(url);
  const fetchedAt = iso(now);

  const robots = await fetchRobotsFor(deps.fetchImpl, target, ua);
  if (!robotsAllows(robots, CRAWLER_UA_TOKEN, target)) {
    return { status: "blocked", status_detail: robots.status === "unreachable" ? `robots.txt unreachable; treated as disallow-all` : "robots.txt disallows", fetched_at: fetchedAt };
  }

  // RFC 9309: robots.txt is per host. Each redirect hop (same host or its www. twin) is checked against the
  // robots.txt of the hop's host before it is requested; the twin's file is fetched once.
  const robotsByHost = new Map<string, RobotsState>([[target.hostname, robots]]);
  const beforeRedirect = async (next: URL) => {
    let r = robotsByHost.get(next.hostname);
    if (!r) {
      r = await fetchRobotsFor(deps.fetchImpl, next, ua);
      robotsByHost.set(next.hostname, r);
    }
    if (!robotsAllows(r, CRAWLER_UA_TOKEN, next)) throw new RobotsBlockedError(next.hostname, r.status === "unreachable");
  };

  onRequest();
  let res;
  try {
    res = await approvedExternalFetch(deps.fetchImpl, url, {
      approvedHost: target.hostname,
      maxBytes: COMPETITOR_FETCH.maxBytes,
      timeoutMs: COMPETITOR_FETCH.timeoutMs,
      maxRedirects: COMPETITOR_FETCH.maxRedirects,
      kind: "html",
      userAgent: ua,
      beforeRedirect,
    });
  } catch (e) {
    if (e instanceof RobotsBlockedError) {
      const where = e.host === target.hostname ? "robots.txt" : `robots.txt of ${e.host}`;
      return { status: "blocked", status_detail: e.unreachable ? `${where} unreachable; treated as disallow-all` : `${where} disallows the redirect target`, fetched_at: fetchedAt };
    }
    const code = e instanceof CrawlFetchError ? e.code : "error";
    const blocked: Record<string, string> = { non_html: "Not an HTML page", redirect_offsite: "Redirects to another host", blocked_url: "URL refused by the fetch guard" };
    const failed: Record<string, string> = { timeout: "Timed out", too_large: "Page larger than the 2 MB cap", too_many_redirects: "Too many redirects", error: "Network error" };
    if (blocked[code]) return { status: "blocked", status_detail: blocked[code], fetched_at: fetchedAt };
    return { status: "failed", status_detail: failed[code] ?? "Fetch failed", fetched_at: fetchedAt };
  }
  const base = { fetched_at: fetchedAt, http_status: res.status, final_url: res.finalUrl };
  if (res.status === 401 || res.status === 403) return { ...base, status: "blocked", status_detail: `${res.status} login wall or access denied` };
  if (res.status < 200 || res.status >= 300) return { ...base, status: "failed", status_detail: `HTTP ${res.status}` };
  if (res.redirects.length > 0 && LOGIN_PATH.test(new URL(res.finalUrl).pathname + "/")) return { ...base, status: "blocked", status_detail: "Redirects to a login page" };

  const x = extractPage(res.body, res.finalUrl);
  const partial = res.truncated || x.tooComplex === true;
  const question = uses.find((u) => u.prompt_text)?.prompt_text ?? null;
  const promptId = uses.find((u) => u.prompt_id)?.prompt_id ?? null;
  const brand = brandTokenSet(project);
  const fullText = [x.excerpt, ...x.linkContext].join(" ").slice(0, 20_000);
  const theirEvidence: PageEvidence = {
    wordCount: x.wordCount,
    firstParagraph: x.firstParagraph,
    excerpt: fullText || null,
    headings: x.headings,
    jsonldTypes: x.jsonLdTypes,
    author: x.author,
    lastUpdated: x.lastUpdated,
    outboundCitations: x.outboundCitations,
    tableCount: x.tableCount,
    inlinks: null,
  };
  const theirFactors = evaluateFactors(theirEvidence, question, brand, now, null);
  const tf = new Map(theirFactors.map((f) => [f.key, f]));
  const questionHeadings = x.headings.filter((h) => h.level >= 2 && isQuestionHeading(h.text)).length;
  const numericFacts = countNumericFacts(fullText);

  // Jev (after the untrusted text is screened).
  const state = {
    question: sanitizeForState(question, STATE_CAPS.question) ?? "",
    [PAGE_REF]: {
      title: sanitizeForState(x.title, STATE_CAPS.title),
      headings: x.headings.slice(0, STATE_CAPS.headings).map((h) => `h${h.level}: ${sanitizeForState(h.text, STATE_CAPS.heading) ?? ""}`),
      opening: sanitizeForState(x.firstParagraph ?? x.excerpt, STATE_CAPS.opening),
      text: sanitizeForState(fullText, STATE_CAPS.text) ?? "",
    },
  };
  const screenText = [state[PAGE_REF].title ?? "", ...state[PAGE_REF].headings, state[PAGE_REF].text].join("\n").slice(0, STATE_CAPS.text + 2000);
  const jev = question ? await askJev(deps, id, state as { question: string; cited_page: Record<string, unknown> }, screenText) : ({ status: "not_configured", screen: "not_run", answers: {}, provider: null, model: null } as JevOutcome);
  const jevRan = jev.status === "answered";

  // Checks.
  const days = tf.get("freshness")?.value ?? null;
  const theirs: Partial<Record<CompetitorCheckKey, FactorStatus>> = {
    answer_first: jevRan ? jevPresence(jev.answers.answer_first) : "unknown",
    depth: x.wordCount >= DEPTH_WORDS ? "present" : "missing",
    proof: tf.get("sources_cited")?.status ?? "unknown",
    schema: x.jsonLdTypes.length > 0 ? "present" : "missing",
    freshness: tf.get("freshness")?.status ?? "unknown",
    author: tf.get("author")?.status ?? "unknown",
    entity: jevRan ? jevPresence(jev.answers.entity) : "unknown",
    faq: tf.get("faq_schema")?.status ?? "unknown",
  };
  const detail: Record<CompetitorCheckKey, string | null> = {
    answer_first: tf.get("answer_first")?.measured ?? null,
    depth: `${fmt(x.wordCount)} words`,
    proof: tf.get("sources_cited")?.measured ?? null,
    schema: x.jsonLdTypes.length > 0 ? x.jsonLdTypes.slice(0, 6).join(", ") : "No JSON-LD",
    freshness: tf.get("freshness")?.measured ?? null,
    author: x.author ? "Author byline present" : "No author or byline markup found",
    entity: tf.get("entity_facts")?.measured ?? null,
    faq: tf.get("faq_schema")?.measured ?? null,
  };
  const checks: CompetitorCheck[] = CHECK_ORDER.map((key) => {
    if (JEV_CHECKS.has(key)) {
      const a = jevRan ? jev.answers[key as "answer_first" | "entity"] : undefined;
      return { key, label: CHECK_LABELS[key], noul: a?.noul ?? null, tier: a?.tier ?? null, method: "jev", detail: detail[key], status: theirs[key] ?? "unknown" };
    }
    return { key, label: CHECK_LABELS[key], noul: null, tier: null, method: "measured", detail: detail[key], status: theirs[key] ?? "unknown" };
  });

  // Our matched page (answer coverage match for the prompt that cited this URL).
  let ourPage: CompetitorExtraction["ourPage"] = null;
  let ours = ourPresence(null, null, null);
  if (promptId) {
    const cov = await computeAnswerCoverage(db, project, now);
    const m = cov.matches.find((r) => r.promptId === promptId);
    if (m?.pageId) {
      const ev = await loadOurPageEvidence(db, project, m.pageId);
      if (ev) {
        ourPage = { pageId: ev.pageId, url: ev.url };
        if (ev.evidence) {
          const of = evaluateFactors(ev.evidence, question, brand, now, ev.snapshotAt);
          ours = ourPresence(new Map(of.map((f) => [f.key, f.status])), ev.evidence.wordCount, ev.evidence.jsonldTypes);
        } else {
          ours = { ...ALL_UNKNOWN };
        }
      }
    }
  }
  const { verdict, gaps } = computeVerdict({ checks, partial, screenFlagged: jev.screen === "flagged" || jev.screen === "unavailable", theirs, ours });

  // Reasons: short observable facts about their page (plain text).
  const reasons: string[] = [];
  const af = jev.answers.answer_first;
  if (jevRan && af && theirs.answer_first === "present") reasons.push(`Answers the question in the opening (Jev yes-probability ${af.noul!.toFixed(2)})`);
  else if (tf.get("answer_first")?.status === "present" && tf.get("answer_first")?.value) reasons.push(`Answer in first ${fmt(tf.get("answer_first")!.value!)} words`);
  if (theirs.depth === "present") reasons.push(`${fmt(x.wordCount)} words`);
  if (theirs.faq === "present") reasons.push(tf.get("faq_schema")!.measured);
  if (x.tableCount > 0) reasons.push(`${fmt(x.tableCount)} HTML table${x.tableCount === 1 ? "" : "s"}`);
  if (theirs.freshness === "present" && days !== null) reasons.push(`Updated ${fmt(days)} days ago`);
  if (theirs.author === "present") reasons.push("Author byline");
  if (theirs.proof === "present") reasons.push(`${fmt(x.outboundCitations)} outbound source links`);
  if (theirs.entity === "present") reasons.push("Specific, checkable product facts (Jev judgment)");
  else if (numericFacts >= FACTOR_THRESHOLDS.entityPresent) reasons.push(`${fmt(numericFacts)} numeric/spec facts`);
  if (theirs.schema === "present" && theirs.faq !== "present") reasons.push(`Structured data: ${x.jsonLdTypes.slice(0, 3).join(", ")}`);

  const notes: string[] = [];
  if (!question) notes.push("No prompt text linked to this citation: Jev checks not run");
  else if (jev.screen === "unavailable") notes.push("Injection screen unavailable; evidence treated as untrusted: 2 checks not run");
  else if (jev.status === "not_configured") notes.push("Jev not configured: 2 checks not run");
  else if (jev.status === "budget") notes.push("Daily Jev budget reached: 2 checks not run");
  else if (jev.status === "error") notes.push("Jev unavailable: 2 checks not run");
  else if (jev.status === "flagged") notes.push("Page text appears to address AI systems; Jev checks not run");
  if (!ourPage) notes.push("No page on your site matches this question; compared against no page");
  else if (CHECK_ORDER.every((k) => ours[k] === "unknown")) notes.push("Your matched page has no usable crawl yet; nothing was compared");
  if (partial) notes.push(res.truncated ? "Page truncated at the size cap; partial evidence" : "Page too complex to parse fully; partial evidence");

  const extraction: CompetitorExtraction = {
    title: x.title ? x.title.slice(0, 300) : null,
    wordCount: x.wordCount,
    opening: x.firstParagraph ? x.firstParagraph.slice(0, 400) : null,
    headings: x.headings.slice(0, 20).map((h) => ({ level: h.level, text: h.text.slice(0, 120) })),
    jsonldTypes: x.jsonLdTypes.slice(0, 30),
    author: x.author ? x.author.slice(0, 80) : null,
    lastUpdated: x.lastUpdated ? x.lastUpdated.slice(0, 64) : null,
    outboundCitations: x.outboundCitations,
    tableCount: x.tableCount,
    questionHeadings,
    numericFacts,
    question,
    factors: Object.fromEntries(theirFactors.map((f) => [f.key, { status: f.status, measured: f.measured, value: f.value }])),
    presence: theirs,
    ourPage,
    gaps,
    injectionScreen: jev.screen,
  };
  return {
    ...base,
    status: "assessed",
    status_detail: notes.length ? notes.join("; ") : null,
    partial: partial ? 1 : 0,
    extraction_json: JSON.stringify(extraction),
    checks_json: JSON.stringify(checks),
    reasons_json: JSON.stringify(reasons.slice(0, 8)),
    verdict,
    verdict_version: VERDICT_VERSION,
    jev_provider: jevRan ? jev.provider : null,
    jev_model: jevRan ? jev.model : null,
  };
}
