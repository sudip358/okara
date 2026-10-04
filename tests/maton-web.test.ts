/**
 * Maton.ai UI: server-rendered markup (no DOM, no live calls) of the Integrations card and the Import page's Sheets
 * connection. The key field is a password field, the warning is shown, the key is never rendered (hint only),
 * the per-app connection picker appears only with several connections, and the Import page says "Connected via Maton".
 */
import { createElement as h, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";
import type { MatonStatus } from "@shared/maton";
import type { SheetsConnectionStatus } from "@shared/import";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type FC = (props: any) => ReactElement | null;
const load = async <T,>(rel: string): Promise<T> => (await import(/* @vite-ignore */ rel)) as T;
const cardMod = await load<Record<"MatonRow", FC> & { connectionText: (c: { connectionId: string; createdAt: string | null }) => string }>("../src/web/pages/integrations/Maton.tsx");
const importMod = await load<Record<"SheetsConnection", FC>>("../src/web/pages/import/ImportPage.tsx");

const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/\s+/g, " ");
const render = (el: ReactElement) => renderToStaticMarkup(h(MemoryRouter, null, el));
const noop = () => {};

const status = (over: Partial<MatonStatus> = {}): MatonStatus => ({
  provider: "maton",
  label: "Maton.ai (API gateway)",
  state: "ready",
  configured: true,
  keyHint: "CRET",
  lastTestedAt: "2026-10-03T10:00:00.000Z",
  lastTestOk: true,
  lastTestDetail: "Key accepted.",
  listedAt: "2026-10-03T10:00:00.000Z",
  warning: "This key can reach every app you connected in Maton. Okara only makes read-only Google Sheets, Search Console and Google Analytics report requests and refuses everything else.",
  storageReady: true,
  apps: [
    {
      app: "google-sheets",
      label: "Google Sheets",
      usedByOkara: true,
      connections: [
        { connectionId: "11111111-aaaa", status: "ACTIVE", createdAt: "2025-12-08T07:20:53Z", selected: false },
        { connectionId: "22222222-bbbb", status: "ACTIVE", createdAt: "2026-02-01T10:00:00Z", selected: true },
      ],
      selectedConnectionId: "22222222-bbbb",
      note: "Used for Import.",
    },
    { app: "google-search-console", label: "Google Search Console", usedByOkara: true, connections: [{ connectionId: "33333333-cccc", status: "ACTIVE", createdAt: null, selected: false }], selectedConnectionId: null, note: "GSC." },
    { app: "google-analytics-data", label: "Google Analytics Data", usedByOkara: false, connections: [{ connectionId: "44444444-dddd", status: "ACTIVE", createdAt: null, selected: false }], selectedConnectionId: null, note: "GA." },
    { app: "google-analytics-admin", label: "Google Analytics Admin", usedByOkara: false, connections: [], selectedConnectionId: null, note: "GA admin." },
  ],
  ...over,
});

describe("Maton Integrations card", () => {
  it("shows the warning, a password key field, the hint only, and a picker only for apps with several connections", () => {
    const html = render(h(cardMod.MatonRow, { workspaceId: "ws1", s: status(), onChange: noop }));
    const t = text(html);
    expect(t).toContain("This key can reach every app you connected in Maton.");
    expect(html).toMatch(/<input[^>]*type="password"/);
    expect(t).toContain("ending CRET");
    expect(t).toContain("Available, not used yet");
    expect(t).toContain("Not connected in Maton");
    expect((html.match(/<select/g) ?? []).length).toBe(1);
    expect(html).toMatch(/<option value="22222222-bbbb" selected="">connection 22222222 \(added 2026-02-01\)<\/option>/);
    expect(t).toContain("Uses connection 33333333.");
    expect(t).toContain("Remove");
  });

  it("without a key: no connection list, no Remove", () => {
    const t = text(render(h(cardMod.MatonRow, { workspaceId: "ws1", s: status({ configured: false, keyHint: null, state: "setup_required" }), onChange: noop })));
    expect(t).not.toContain("Remove");
    expect(t).not.toContain("Connection to use");
    expect(cardMod.connectionText({ connectionId: "abcdef1234567", createdAt: "bad" })).toBe("connection abcdef12");
  });
});

describe("Import page Sheets connection", () => {
  const base: SheetsConnectionStatus = { state: "setup_required", connectedAt: null, lastError: null, scope: "s", notes: ["n"] };
  it("offers Connect Google Sheets and Use Maton when neither is available", () => {
    const t = text(render(h(importMod.SheetsConnection, { projectId: "p1", status: { ...base, maton: { available: false, label: null } } })));
    expect(t).toContain("Connect Google Sheets");
    expect(t).toContain("Use Maton");
  });
  it("says Connected via Maton (label) and still offers a direct connection", () => {
    const t = text(render(h(importMod.SheetsConnection, { projectId: "p1", status: { ...base, state: "ready", via: "maton", maton: { available: true, label: "connection 22222222 (added 2026-02-01)" } }, onDisconnect: noop })));
    expect(t).toContain("Connected via Maton (connection 22222222 (added 2026-02-01))");
    expect(t).toContain("Connect Google Sheets");
    expect(t).not.toContain("Disconnect");
    expect(t).not.toContain("Use Maton");
  });
});
