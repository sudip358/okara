/**
 * Run buttons of the Live view internal-link containers (docs/live-view-design.md section 18): the mapping in
 * run-actions.ts (16 rebuild or crawl depending on the stored state, 17/19 crawl, 18/20 link analysis), the section 16
 * disabled reasons and confirm text, the rate limits stated against the route constants, and how the confirm dialog
 * shows the rebuild's 409 (busy) and 429 (limit) answers.
 */
import { createElement as h, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  DEMO_REASON,
  GRAPH_REBUILDS_PER_HOUR,
  QUOTA_REASON,
  UNVERIFIED_GRAPH_REASON,
  linkContainerActions,
  linkGraphActionKey,
  seoPanelActions,
  type ActionEnv,
  type SectionAction,
} from "../src/web/pages/live/run-actions";
import { GRAPH_REBUILD_RATE_LIMIT, LINK_RUN_RATE_LIMIT } from "../src/worker/routes/links";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type FC = (props: any) => ReactElement | null;
const load = async <T,>(rel: string): Promise<T> => (await import(/* @vite-ignore */ rel)) as T;
const ra = await load<{ ConfirmDialog: FC; dialogError: (e: unknown) => { prefix: string; tone: string } }>("../src/web/pages/live/RunActions.tsx");
// The web API client is loaded at run time (it needs DOM types the worker typecheck of the tests does not include).
const { ApiError } = await load<{ ApiError: new (status: number, body: { code: string; message: string }) => Error }>("../src/web/lib/api.ts");
const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/\s+/g, " ");

function env(over: Partial<ActionEnv> = {}): ActionEnv {
  return {
    projectId: "p1", demo: false, verifiedHost: "shop.example", gscProperty: "sc-domain:shop.example", running: { seo: false, geo: false }, manualToday: 0,
    engines: null, promptCount: null, buyer: { state: "ready", labels: [] }, links: { state: "ready", labels: [] },
    path: (sub) => `/projects/p1/${sub}`,
    ...over,
  };
}
const runOf = (a: SectionAction | undefined) => (a && a.kind === "run" ? a : null);
const callOf = (a: SectionAction | undefined) => (a && a.kind === "call" ? a : null);

describe("link container actions (section 18 mapping)", () => {
  it("16 rebuild or crawl, 17/19 crawl, 18/20 link analysis, each with its own key", () => {
    const m = linkContainerActions(env());
    expect(Object.keys(m).sort()).toEqual(["anchor-flags", "broken-links", "cluster-gaps", "link-graph:crawl", "link-graph:rebuild", "placed-links"]);
    expect(new Set(Object.values(m).map((a) => a.key)).size).toBe(6);
    const rebuild = callOf(m["link-graph:rebuild"])!;
    expect(rebuild).toMatchObject({ kind: "call", key: "link-graph-rebuild", label: "Rebuild link graph", path: "/projects/p1/seo/internal-links/graph/rebuild", reload: "link-graph", disabled: null });
    expect(rebuild.body).toBeUndefined();
    for (const k of ["link-graph:crawl", "broken-links", "anchor-flags"]) {
      expect(runOf(m[k])?.runs, k).toEqual([{ agent: "seo", steps: ["crawl"] }]);
      expect(m[k]!.label).toBe("Run crawl");
    }
    for (const k of ["cluster-gaps", "placed-links"]) {
      expect(callOf(m[k]), k).toMatchObject({ kind: "call", label: "Run link analysis", path: "/projects/p1/seo/internal-links/run", reload: "links" });
    }
    expect(m["broken-links"]!.key).toBe("crawl-broken-links");
    expect(m["cluster-gaps"]!.key).toBe("links-cluster-gaps");
  });
  it("reuses the section 16 crawl and link-analysis actions (same confirm text and reasons)", () => {
    const m = linkContainerActions(env());
    const s = seoPanelActions(env());
    expect({ ...m["broken-links"]!, key: "x" }).toEqual({ ...s.pages!, key: "x" });
    expect({ ...m["placed-links"]!, key: "x" }).toEqual({ ...s.links!, key: "x" });
  });
  it("16 picks crawl while no crawl is stored (the rebuild route then rebuilds nothing), rebuild otherwise", () => {
    expect(linkGraphActionKey(null)).toBeNull();
    expect(linkGraphActionKey(undefined)).toBeNull();
    expect(linkGraphActionKey({ state: "setup_required" })).toBe("link-graph:crawl");
    expect(linkGraphActionKey({ state: "ready" })).toBe("link-graph:rebuild");
    expect(linkGraphActionKey({ state: "demo" })).toBe("link-graph:rebuild");
  });
  it("confirm text states what it calls, that it is free, and the route's real limits", () => {
    expect(GRAPH_REBUILDS_PER_HOUR).toBe(GRAPH_REBUILD_RATE_LIMIT.limit);
    const rebuild = callOf(linkContainerActions(env())["link-graph:rebuild"])!;
    expect(rebuild.confirm.title).toBe("Rebuild the link graph now?");
    const lines = rebuild.confirm.lines.join(" ");
    expect(lines).toContain("latest stored snapshot of every crawled page (no new crawl)");
    expect(lines).toContain("no provider call and no budget used");
    expect(lines).toContain(`Limited to ${GRAPH_REBUILD_RATE_LIMIT.limit} per hour per project`);
    expect(lines).toContain("refused while another build runs");
    expect(lines).toContain("no manual run is used");
    expect(callOf(linkContainerActions(env())["cluster-gaps"])!.confirm.lines.join(" ")).toContain(`Limited to ${LINK_RUN_RATE_LIMIT.limit} per hour per project`);
    expect(runOf(linkContainerActions(env({ manualToday: 1 }))["anchor-flags"])!.confirm.lines.join(" ")).toContain("(2 left today; a partial run counts as one)");
  });
  it("disabled reasons follow section 16: demo, running, quota, setup known on the client", () => {
    const demo = linkContainerActions(env({ demo: true }));
    for (const a of Object.values(demo)) expect(a.disabled, a.key).toBe(DEMO_REASON);
    const running = linkContainerActions(env({ running: { seo: true, geo: false } }));
    expect(running["broken-links"]!.disabled).toMatch(/^Running…/);
    expect(running["broken-links"]!.busyLabel).toBe("Running…");
    expect(running["link-graph:rebuild"]!.disabled).toBeNull(); // a tool call, not an agent run
    const quota = linkContainerActions(env({ manualToday: 3 }));
    expect(quota["anchor-flags"]!.disabled).toBe(QUOTA_REASON);
    expect(quota["link-graph:rebuild"]!.disabled).toBeNull();
    expect(quota["placed-links"]!.disabled).toBeNull();
    const unverified = linkContainerActions(env({ verifiedHost: null, links: { state: "setup_required", labels: ["Verify site ownership first."] } }));
    expect(unverified["link-graph:rebuild"]!.disabled).toBe(UNVERIFIED_GRAPH_REASON);
    expect(unverified["link-graph:crawl"]!.disabled).toMatch(/Verify site ownership first/);
    expect(unverified["cluster-gaps"]!.disabled).toBe("Verify site ownership first.");
  });
});

describe("confirm dialog answers of the rebuild", () => {
  const rebuild = linkContainerActions(env())["link-graph:rebuild"] as Exclude<SectionAction, { kind: "link" }>;
  const dlg = (error: unknown) => renderToStaticMarkup(h(ra.ConfirmDialog, { action: rebuild, busy: false, error, onCancel: () => {}, onConfirm: () => {} }));
  it("names the work and starts with Start (a tool call, not a run)", () => {
    const t = text(dlg(null));
    expect(t).toContain("Rebuild the link graph now?");
    expect(t).toContain("Start");
    expect(t).not.toContain("Start run");
  });
  it("a 409 (another build in progress) is a refusal in amber, a 429 a limit; other errors are failures", () => {
    const busy = new ApiError(409, { code: "conflict", message: "The link graph is already being rebuilt for this project. Try again in a few minutes." });
    expect(ra.dialogError(busy)).toEqual({ prefix: "Not started: ", tone: "warn" });
    const html = dlg(busy);
    expect(text(html)).toContain("Not started: The link graph is already being rebuilt for this project.");
    expect(html).toMatch(/role="alert" class="[^"]*text-amber-800/);
    const limit = new ApiError(429, { code: "rate_limited", message: "Link graph rebuilds are limited to 6 per hour per project. Try again later." });
    expect(text(dlg(limit))).toContain("Limit reached: Link graph rebuilds are limited to 6 per hour per project.");
    expect(ra.dialogError(new ApiError(412, { code: "setup_required", message: "x" }))).toEqual({ prefix: "Setup required: ", tone: "warn" });
    expect(ra.dialogError(new Error("network"))).toEqual({ prefix: "", tone: "error" });
  });
});
