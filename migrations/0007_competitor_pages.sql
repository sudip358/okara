-- [A7] Competitor pages read for why an AI engine cites them (docs/api.md "AI engine board").
-- One row per user approval of ONE third-party URL that a stored API-sampled answer cited
-- (geo_citations.url of the same project). Okara fetches that single URL once through the SSRF guard
-- (seo/ssrf.ts approvedExternalFetch), respecting robots.txt, and stores compact evidence only: no full
-- page text. Page text is untrusted evidence; it is never stored as instructions.
--   status          queued | fetching | assessed | blocked | failed
--   extraction_json compact observable facts (word count, JSON-LD types, byline present, last-updated
--                   date, outbound citation / table counts, question headings, numeric-fact count, opening
--                   of at most 400 characters, title); see geo/competitor-pages.ts CompetitorExtraction
--   checks_json     CompetitorCheck[] (measured checks + Jev Noul checks with tier; no confidence field)
--   verdict         adapt | skip | review, computed in code (verdict_version, e.g. competitor-verdict.v1);
--                   "adapt" means adapting structure, never copying text
-- Rows go with the project (ON DELETE CASCADE).

CREATE TABLE competitor_pages (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  url TEXT NOT NULL,                  -- canonical form of the approved geo_citations.url
  host TEXT NOT NULL,                 -- lowercase host of url
  approved_by TEXT NOT NULL,          -- users.id of the member who approved the read
  approved_at TEXT NOT NULL,
  fetched_at TEXT,
  status TEXT NOT NULL CHECK (status IN ('queued', 'fetching', 'assessed', 'blocked', 'failed')),
  status_detail TEXT,                 -- plain text, e.g. 'robots.txt disallows', '401 login wall'
  http_status INTEGER,
  final_url TEXT,
  partial INTEGER NOT NULL DEFAULT 0, -- 1 when the body was truncated or too complex to parse fully
  extraction_json TEXT NOT NULL DEFAULT '{}',
  checks_json TEXT NOT NULL DEFAULT '[]',
  reasons_json TEXT NOT NULL DEFAULT '[]',
  verdict TEXT CHECK (verdict IN ('adapt', 'skip', 'review')),
  verdict_version TEXT,
  jev_provider TEXT,                  -- provider that answered the Jev checks (NULL when not asked)
  jev_model TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_competitor_pages_project ON competitor_pages(workspace_id, project_id, approved_at);
CREATE INDEX idx_competitor_pages_url ON competitor_pages(project_id, url, approved_at);
CREATE INDEX idx_competitor_pages_host ON competitor_pages(project_id, host);
