-- Internal links workbench (owner request 2026-10-03: "all eight improvements"). See docs/api.md "Internal links
-- workbench", docs/architecture.md "Internal links", docs/build-kit.md amendment 2026-10-03,
-- src/worker/links/*, src/worker/seo/crawl/rolling.ts.
--
-- Plain ADD COLUMN / CREATE TABLE only: no CHECK change on an existing table, so no rebuild.

-- 1. Snapshot columns.
--    link_anchors_json:   [[href, text, kind]] internal links with anchor text, kind "c" content, "i" content image alt,
--                         "b" breadcrumb (navigation/header/footer/sidebar links are not listed; they stay in
--                         internal_links_json). At most 150 entries, text at most 80 characters, plain text.
--                         NULL = taken before this migration (anchors unknown).
--    redirect_chain_json: [{status, to}] every hop of a redirecting URL (at most 5); NULL when not a redirect.
--    compacted_at:        set by snapshot retention when the heavy evidence columns of a superseded snapshot were
--                         cleared (the row keeps status, hashes, title and dates for change history).
ALTER TABLE page_snapshots ADD COLUMN link_anchors_json TEXT;
ALTER TABLE page_snapshots ADD COLUMN redirect_chain_json TEXT;
ALTER TABLE page_snapshots ADD COLUMN compacted_at TEXT;
-- No new page_snapshots index: the latest snapshot per page uses idx_snap_page (page_id, fetched_at) and retention
-- scans go crawl_runs (idx_crawl_project) -> page_snapshots (idx_snap_crawl). An index led by project_id would change
-- the query plans, and so the implicit row order, of existing per-crawl snapshot queries.

-- 2. Crawl inventory: every URL the rolling crawl knows (sitemap URLs, URLs discovered as internal link targets,
--    the home page). ord is the insertion order (sitemap order at first sight) and the round-robin order; the
--    cursor lives in crawl_inventory_state. last_crawled_at is the last time a crawl recorded the URL (fetched,
--    redirected, errored or skipped). Bounded: at most 10,000 URLs per project (rolling.ts INVENTORY_MAX_URLS).
CREATE TABLE crawl_inventory (
  workspace_id TEXT NOT NULL,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  url_key TEXT NOT NULL,              -- normalized key (seo/rules/registry normalizeUrlKey)
  url TEXT NOT NULL,
  ord INTEGER NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('sitemap', 'link', 'home')),
  in_sitemap INTEGER NOT NULL DEFAULT 0,
  sitemap_file TEXT,
  lastmod TEXT,
  first_seen_at TEXT NOT NULL,
  removed_from_sitemap_at TEXT,
  last_crawled_at TEXT,
  last_crawl_run_id TEXT,
  PRIMARY KEY (project_id, url_key)
);
CREATE INDEX idx_crawl_inventory_ord ON crawl_inventory(workspace_id, project_id, ord);

CREATE TABLE crawl_inventory_state (
  project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
  workspace_id TEXT NOT NULL,
  sitemap_hash TEXT,                  -- hash of the sorted sitemap URL keys of the last read
  sitemap_urls INTEGER NOT NULL DEFAULT 0,
  sitemap_truncated INTEGER NOT NULL DEFAULT 0,
  sitemap_read_at TEXT,
  next_ord INTEGER NOT NULL DEFAULT 0,
  cursor_ord INTEGER,                 -- ord of the last inventory URL dispatched (round-robin cursor)
  passes INTEGER NOT NULL DEFAULT 0,  -- times the cursor wrapped around the inventory
  updated_at TEXT NOT NULL
);

-- 3. Link graph: the latest snapshot of every page across crawls, rebuilt after each crawl (and on demand).
--    One row per URL known to the graph (inventory URLs, crawled pages, link targets). Only the latest ready graph
--    and a graph being built are kept (older ones are deleted with their URL rows).
--    inbound_json:  [[source_key, anchor|null, kind]] sources linking here (kind c/i/b content, n navigation/other),
--                   capped (50; 200 for redirect/error targets); links_in/content_links_in are exact counts.
--    outbound_json: [target_key] content + breadcrumb link targets of this page (capped at 200).
--    anchors_json:  the anchor audit for this URL as a target (links/anchor-audit.ts): counts, keyword, top anchors.
CREATE TABLE link_graphs (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK (status IN ('building', 'ready', 'failed')),
  trigger TEXT NOT NULL CHECK (trigger IN ('crawl', 'manual', 'run', 'demo')),
  crawl_run_id TEXT,
  method_version TEXT NOT NULL,
  summary_json TEXT NOT NULL DEFAULT '{}',
  created_by TEXT,
  created_at TEXT NOT NULL,
  finished_at TEXT
);
CREATE INDEX idx_link_graphs_project ON link_graphs(workspace_id, project_id, created_at);

CREATE TABLE link_graph_urls (
  graph_id TEXT NOT NULL REFERENCES link_graphs(id) ON DELETE CASCADE,
  workspace_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  url_key TEXT NOT NULL,
  url TEXT NOT NULL,
  page_id TEXT,
  page_type TEXT,
  title TEXT,
  in_sitemap INTEGER NOT NULL DEFAULT 0,
  status_code INTEGER,
  final_url TEXT,
  redirect_hops INTEGER,
  chain_json TEXT,                    -- [{status, to}] redirect hops of this URL's latest snapshot
  skipped_reason TEXT,
  fetched_at TEXT,                    -- latest snapshot; NULL = never crawled
  indexable INTEGER NOT NULL DEFAULT 0,
  noindex INTEGER NOT NULL DEFAULT 0,
  canonical_url TEXT,
  links_in INTEGER NOT NULL DEFAULT 0,
  content_links_in INTEGER NOT NULL DEFAULT 0,
  links_out INTEGER NOT NULL DEFAULT 0,
  content_links_out INTEGER NOT NULL DEFAULT 0,
  orphan INTEGER NOT NULL DEFAULT 0,
  issue TEXT,                         -- redirect | client_error | server_error | NULL
  is_hub INTEGER NOT NULL DEFAULT 0,
  hub_source TEXT,                    -- collection | owner | sheet
  hub_key TEXT,                       -- assigned hub (spokes)
  hub_method TEXT,                    -- owner | sheet | collection_membership | existing_links | tfidf
  hub_score REAL,                     -- term similarity with the hub (cosine of TF-IDF weights)
  hub_to_spoke INTEGER,               -- the hub links to this spoke (1/0; NULL = not a spoke with a hub)
  spoke_to_hub INTEGER,               -- this spoke links to its hub (content or breadcrumb link)
  gsc_impressions INTEGER,
  gsc_clicks INTEGER,
  gsc_position REAL,
  anchor_flags TEXT,                  -- comma-separated anchor-audit flags (links/anchor-audit.ts)
  inbound_json TEXT NOT NULL DEFAULT '[]',
  outbound_json TEXT NOT NULL DEFAULT '[]',
  anchors_json TEXT NOT NULL DEFAULT '[]',
  PRIMARY KEY (graph_id, url_key)
);
CREATE INDEX idx_link_graph_urls_project ON link_graph_urls(workspace_id, project_id, graph_id);

-- 4. Owner overrides for hubs and clusters. kind 'hub': value 'yes' (mark as hub) or 'no' (not a hub);
--    kind 'assign': value = the hub's url_key for this spoke, or '' (no hub).
CREATE TABLE link_cluster_overrides (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('hub', 'assign')),
  page_key TEXT NOT NULL,
  value TEXT NOT NULL,
  created_by TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (project_id, kind, page_key)
);
CREATE INDEX idx_link_cluster_overrides_ws ON link_cluster_overrides(workspace_id, project_id);

-- 5. Auto-verification of links the owner accepted, implemented, or placed per the imported sheet: checked against
--    the latest snapshot of the source page taken after expected_since.
CREATE TABLE link_verifications (
  workspace_id TEXT NOT NULL,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  source_key TEXT NOT NULL,
  target_key TEXT NOT NULL,
  expected_since TEXT NOT NULL,
  origins TEXT NOT NULL,              -- comma-separated: implemented | accepted | sheet
  status TEXT NOT NULL CHECK (status IN ('pending', 'verified', 'not_found', 'source_unavailable')),
  checked_at TEXT,                    -- fetched_at of the source snapshot used
  matched_via TEXT,                   -- target | final_url | canonical | redirecting_url
  detail TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (project_id, source_key, target_key)
);
CREATE INDEX idx_link_verifications_ws ON link_verifications(workspace_id, project_id, status);

-- 6. link_suggestions: versioned priority and the numbers behind it, placement (existing sentence or a drafted
--    sentence), the draft and its validation, cluster assignment and gap, the source snapshot date, and when the
--    owner last changed the status (verification baseline; carried over to later runs).
ALTER TABLE link_suggestions ADD COLUMN priority REAL;
ALTER TABLE link_suggestions ADD COLUMN priority_json TEXT;
ALTER TABLE link_suggestions ADD COLUMN placement TEXT NOT NULL DEFAULT 'existing_sentence';
ALTER TABLE link_suggestions ADD COLUMN draft_json TEXT;
ALTER TABLE link_suggestions ADD COLUMN hub_key TEXT;
ALTER TABLE link_suggestions ADD COLUMN cluster_gap TEXT;
ALTER TABLE link_suggestions ADD COLUMN source_fetched_at TEXT;
ALTER TABLE link_suggestions ADD COLUMN status_changed_at TEXT;
