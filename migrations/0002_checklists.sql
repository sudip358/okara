-- [A21] SEO, GEO, and per-page readiness checklists.
-- Manual checklist items (the ones that cannot be measured) are confirmed by a user with an optional
-- note; who and when are stored with the answer. Measured items are never stored: they are recomputed
-- from the latest crawl, GSC sync, GEO observations, and decisions on every request.
--   * kind 'seo' | 'geo': item_id is the registry id (e.g. 'geo.content.original_research').
--   * kind 'page': item_id is '<page id>:<registry id>' (keeps the primary key unique per page) and
--     page_id references the page so rows disappear with it.

CREATE TABLE checklist_manual (
  workspace_id TEXT NOT NULL,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('seo', 'geo', 'page')),
  item_id TEXT NOT NULL,
  page_id TEXT REFERENCES pages(id) ON DELETE CASCADE,
  checked INTEGER NOT NULL DEFAULT 0,
  note TEXT,
  updated_by TEXT,                    -- users.id of the member who last changed it
  updated_at TEXT NOT NULL,
  PRIMARY KEY (project_id, kind, item_id)
);
CREATE INDEX idx_checklist_manual_ws ON checklist_manual(workspace_id, project_id, kind);

-- Extra compact evidence extracted from crawled HTML (NULL on snapshots taken before this migration).
ALTER TABLE page_snapshots ADD COLUMN images_total INTEGER;          -- <img> elements in the body (outside noscript/svg)
ALTER TABLE page_snapshots ADD COLUMN images_missing_alt INTEGER;    -- of those, without an alt attribute (decorative role/aria-hidden excluded)
ALTER TABLE page_snapshots ADD COLUMN viewport_meta TEXT;            -- <meta name="viewport"> content, capped; NULL when absent
ALTER TABLE page_snapshots ADD COLUMN breadcrumb_nav INTEGER;        -- 1 when breadcrumb navigation markup was found in the HTML
ALTER TABLE page_snapshots ADD COLUMN generic_anchors_json TEXT;     -- up to 10 internal links with generic anchor text [{href, text}]
