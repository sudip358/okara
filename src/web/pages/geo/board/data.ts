/**
 * Data hooks for the AI engines board. All requests go through the typed `api()` client (via useApi /
 * useMutation); endpoints are exactly those in docs/api.md "AI engine board". Board, competitor pages and
 * rewrite plans are read-only; the only write is the explicit, confirmed competitor-page approval.
 */
import { useCallback, useEffect, useState } from "react";
import type {
  AnswerCoverageRow,
  CompetitorPageApprovalRequest,
  CompetitorPageAssessment,
  CoverageResponse,
  EngineBoardResponse,
  PageRow,
  PageSkipFactors,
  RewritePlansResponse,
  RunSummary,
} from "@shared/types";
import { ApiError, api } from "@web/lib/api";
import { useApi, useMutation, usePolling } from "@web/lib/hooks";
import { ASSESSMENT_STATE, skipFactorsPath } from "./lib";

const p = (projectId: string) => `/projects/${encodeURIComponent(projectId)}`;

export const boardPaths = {
  board: (pid: string) => `${p(pid)}/geo/board`,
  competitorPages: (pid: string) => `${p(pid)}/geo/competitor-pages`,
  rewritePlans: (pid: string) => `${p(pid)}/geo/rewrite-plans`,
  answerCoverage: (pid: string) => `${p(pid)}/geo/answer-coverage`,
  pages: (pid: string) => `${p(pid)}/pages`,
  runs: (pid: string) => `${p(pid)}/runs`,
};

export function useEngineBoard(projectId: string) {
  return useApi<EngineBoardResponse>(projectId ? boardPaths.board(projectId) : null);
}

export function useGeoRuns(projectId: string) {
  return useApi<RunSummary[]>(projectId ? boardPaths.runs(projectId) : null);
}

/** Approved competitor assessments; polls while any is queued/fetching. */
export function useCompetitorPages(projectId: string) {
  const state = useApi<CompetitorPageAssessment[]>(projectId ? boardPaths.competitorPages(projectId) : null);
  const pending = (state.data ?? []).some((a) => ASSESSMENT_STATE[a.state]?.pending);
  usePolling(state.reload, pending, 5_000);
  return state;
}

export function useRewritePlans(projectId: string) {
  return useApi<RewritePlansResponse>(projectId ? boardPaths.rewritePlans(projectId) : null);
}

/** Inputs for the "our pages" section, fetched only once some lane opens it (lazy). */
export function useSkipInputs(projectId: string, enabled: boolean) {
  const coverage = useApi<CoverageResponse<AnswerCoverageRow>>(enabled && projectId ? boardPaths.answerCoverage(projectId) : null);
  const pages = useApi<PageRow[]>(enabled && projectId ? boardPaths.pages(projectId) : null);
  return {
    coverage: coverage.data?.rows ?? null,
    pages: pages.data ?? null,
    loading: coverage.loading || pages.loading,
    error: coverage.error ?? pages.error ?? null,
    reload: () => {
      coverage.reload();
      pages.reload();
    },
  };
}

export function useSkipFactors(projectId: string, sel: { pageId: string; promptId: string | null } | null, engine: string) {
  return useApi<PageSkipFactors>(projectId && sel ? skipFactorsPath(projectId, sel, engine) : null);
}

/** POST one cited URL for a single, user-approved read. Returns the assessment (202, or 200 if recent). */
export function useApproveCompetitorPage(projectId: string) {
  return useMutation((body: CompetitorPageApprovalRequest) =>
    api<CompetitorPageAssessment>(boardPaths.competitorPages(projectId), { method: "POST", body }),
  );
}

/** Human message for an approval error (rate limit, budget, URL not cited). Plain text. */
export function approvalErrorMessage(err: unknown): string {
  if (err instanceof ApiError) {
    const reason = (err.body.details as { reason?: string } | undefined)?.reason;
    if (err.status === 400 && reason === "url_not_cited") return "This URL is not among the citations stored for this project, so it cannot be read.";
    if (err.status === 429 && err.code === "budget_exceeded") return "Daily budget reached; no page was fetched. Try again tomorrow or raise the limit in Usage.";
    if (err.status === 429) return "Approval limit reached (10 pages per project per hour). Try again later.";
    return err.message;
  }
  return err instanceof Error ? err.message : "Request failed.";
}

/** True at or above the breakpoint; SSR/tests default to desktop. */
export function useMinWidth(px: number): boolean {
  const query = `(min-width: ${px}px)`;
  const get = useCallback(() => (typeof window === "undefined" || !window.matchMedia ? true : window.matchMedia(query).matches), [query]);
  const [ok, setOk] = useState(get);
  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return;
    const mq = window.matchMedia(query);
    const on = () => setOk(mq.matches);
    on();
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, [query]);
  return ok;
}
