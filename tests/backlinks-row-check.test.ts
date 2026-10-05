/** Change column: per-row Check / Recheck button state (pending → result; queued during a full check). */
import { describe, expect, it } from "vitest";
import type { BacklinkJobView, BacklinkRow } from "@shared/backlinks";
import { rowCheckState } from "@web/pages/backlinks/BacklinksPage";

const row = (over: Partial<BacklinkRow> = {}): BacklinkRow =>
  ({ id: "bl1", liveUrl: "https://blog.example/a", liveHost: "blog.example", targetUrl: "https://shop.example/c", active: true, lastCheckedAt: null, ...over }) as BacklinkRow;
const job = (over: Partial<BacklinkJobView> = {}): BacklinkJobView =>
  ({ id: "j1", trigger: "manual", scope: "all", status: "running", total: 250, done: 10, failed: 0, robotsBlocked: 0, changes: 0, fetches: 0, batches: 1, note: null, createdAt: "2026-10-05T10:00:00.000Z", startedAt: "2026-10-05T10:00:01.000Z", finishedAt: null, ...over }) as BacklinkJobView;

describe("rowCheckState", () => {
  it("is pending after a click until a newer check lands", () => {
    const since = "2026-10-05T11:00:00.000Z";
    expect(rowCheckState(row(), since, null)).toBe("pending");
    expect(rowCheckState(row({ lastCheckedAt: "2026-10-05T10:59:00.000Z" }), since, null)).toBe("pending");
    expect(rowCheckState(row({ lastCheckedAt: "2026-10-05T11:00:05.000Z" }), since, null)).toBe("idle");
  });
  it("is queued during a full check until the job reaches the row", () => {
    expect(rowCheckState(row(), undefined, job())).toBe("queued");
    expect(rowCheckState(row({ lastCheckedAt: "2026-10-04T09:00:00.000Z" }), undefined, job())).toBe("queued");
    expect(rowCheckState(row({ lastCheckedAt: "2026-10-05T10:02:00.000Z" }), undefined, job())).toBe("idle");
  });
  it("ignores finished jobs, recheck-only jobs and inactive rows", () => {
    expect(rowCheckState(row(), undefined, job({ status: "completed" }))).toBe("idle");
    expect(rowCheckState(row(), undefined, job({ scope: "ids" }))).toBe("idle");
    expect(rowCheckState(row({ active: false }), undefined, job())).toBe("idle");
  });
});
