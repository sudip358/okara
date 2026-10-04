/**
 * Maton.ai card (Integrations page): paste the workspace's Maton API key (password field, write-only: only the last 4
 * characters are ever shown), Test (lists the active Google Sheets / Search Console / Google Analytics connections,
 * nothing else), a connection picker per app when there are several, and Remove. Plus the project's "Search Console
 * source" panel (direct OAuth, the default, or Maton) shown inside the Search Console card.
 * All connection data is rendered as plain text.
 */
import { useId, useState } from "react";
import type { GscMatonStatus, MatonAppStatus, MatonSite, MatonStatus, MatonTestResult } from "@shared/maton";
import { MATON_WARNING } from "@shared/maton";
import { api, errorMessage } from "@web/lib/api";
import { useApi, useMutation } from "@web/lib/hooks";
import { formatDateTime } from "@web/lib/format";
import { Badge, Button, Card, ErrorState, LoadingState, SelectField, StateBadge, TextField } from "@web/components/ui";

export const MATON_NOTE =
  "Use your Maton.ai connections (managed Google OAuth) to read Google Sheets and Search Console without setting up a Google Cloud project. A direct Google connection always takes precedence. Get the key at maton.ai/settings.";

/** "connection 1a2b3c4d (added 2026-01-02)" — Maton documents no account label. */
export function connectionText(c: { connectionId: string; createdAt: string | null }): string {
  const date = c.createdAt && /^\d{4}-\d{2}-\d{2}/.test(c.createdAt) ? c.createdAt.slice(0, 10) : null;
  return `connection ${c.connectionId.slice(0, 8)}${date ? ` (added ${date})` : ""}`;
}

export function MatonCard({ workspaceId }: { workspaceId: string }) {
  const status = useApi<MatonStatus>(`/workspaces/${encodeURIComponent(workspaceId)}/maton`);
  return (
    <div id="maton">
      <Card title="Maton.ai" description={MATON_NOTE}>
        {status.loading && !status.data ? (
          <LoadingState />
        ) : !status.data ? (
          <ErrorState error={status.error} onRetry={status.reload} />
        ) : (
          <MatonRow workspaceId={workspaceId} s={status.data} onChange={(next) => (next ? status.setData(next) : status.reload())} />
        )}
      </Card>
    </div>
  );
}

export function MatonRow({ workspaceId, s, onChange }: { workspaceId: string; s: MatonStatus; onChange: (next?: MatonStatus) => void }) {
  const id = useId();
  const path = `/workspaces/${encodeURIComponent(workspaceId)}/maton`;
  const [key, setKey] = useState("");
  const [confirmDelete, setConfirmDelete] = useState(false);
  const save = useMutation((apiKey: string) => api<MatonStatus>(path, { method: "PUT", body: { apiKey } }));
  const test = useMutation((body: { apiKey?: string }) => api<MatonTestResult>(`${path}/test`, { method: "POST", body }));
  const del = useMutation(() => api<unknown>(path, { method: "DELETE" }));
  const typed = key.trim() !== "";

  return (
    <div className="space-y-3" data-testid="maton-card">
      <p role="note" className="rounded border border-amber-300 bg-amber-50 px-2 py-1.5 text-xs text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-100">
        {s.warning || MATON_WARNING}
      </p>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0 text-xs text-zinc-600 dark:text-zinc-400">
          <p className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">{s.label}</p>
          <p>
            {s.configured ? "Workspace key" : "No key"}
            {s.keyHint && (
              <>
                {" "}
                · ending <span className="font-mono">{s.keyHint}</span>
              </>
            )}
          </p>
          <p>
            Last test:{" "}
            {s.lastTestedAt ? (
              <>
                {formatDateTime(s.lastTestedAt)} — {s.lastTestOk === null ? "not confirmed" : s.lastTestOk ? "passed" : "failed"}
                {s.lastTestDetail && ` (${s.lastTestDetail})`}
              </>
            ) : (
              "never"
            )}
          </p>
        </div>
        <StateBadge state={s.state} />
      </div>
      {!s.storageReady && <p className="text-xs text-amber-800 dark:text-amber-300">Saving a Maton key needs database migration 0018 to be applied.</p>}
      <form
        className="flex flex-wrap items-end gap-2"
        onSubmit={async (e) => {
          e.preventDefault();
          if (!typed) return;
          const r = await save.run(key.trim());
          if (r) {
            setKey("");
            onChange(r);
            // List the connections right away so Sheets / Search Console can use them.
            const t = await test.run({});
            if (t) onChange();
          }
        }}
      >
        <div className="min-w-0 flex-1 sm:max-w-sm">
          <TextField
            id={`${id}-key`}
            label="Maton API key"
            type="password"
            autoComplete="off"
            spellCheck={false}
            value={key}
            onChange={(e) => setKey(e.target.value)}
            placeholder={s.keyHint ? `Replace …${s.keyHint}` : "Paste your Maton API key"}
          />
        </div>
        <Button type="submit" variant="primary" disabled={!typed} loading={save.loading}>
          Save key
        </Button>
        <Button
          loading={test.loading}
          disabled={!typed && !s.configured}
          onClick={async () => {
            const r = await test.run(typed ? { apiKey: key.trim() } : {});
            if (r && !typed) onChange();
          }}
        >
          {typed ? "Test typed key" : "Test"}
        </Button>
        {s.configured &&
          (!confirmDelete ? (
            <Button variant="ghost" onClick={() => setConfirmDelete(true)}>
              Remove
            </Button>
          ) : (
            <span className="flex items-center gap-1">
              <Button
                variant="danger"
                size="sm"
                loading={del.loading}
                onClick={async () => {
                  const r = await del.run();
                  setConfirmDelete(false);
                  if (r !== undefined) onChange();
                }}
              >
                Confirm remove
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setConfirmDelete(false)}>
                Cancel
              </Button>
            </span>
          ))}
      </form>
      <div aria-live="polite" className="text-xs">
        {test.data && (
          <span className={test.data.ok ? "text-emerald-800 dark:text-emerald-300" : "text-red-700 dark:text-red-400"}>
            Test {test.data.ok ? "passed" : test.data.ok === null ? "not confirmed" : "failed"}: {test.data.detail}
          </span>
        )}
        {[save.error, test.error, del.error].map((e, i) =>
          e !== null ? (
            <span key={i} className="block text-red-700 dark:text-red-400">
              {errorMessage(e)}
            </span>
          ) : null,
        )}
      </div>
      {s.configured && (
        <ul className="divide-y divide-zinc-100 rounded border border-zinc-200 dark:divide-zinc-800 dark:border-zinc-800" aria-label="Maton connections">
          {s.apps.map((a) => (
            <AppRow key={a.app} workspaceId={workspaceId} a={a} onChange={onChange} />
          ))}
        </ul>
      )}
      {s.configured && s.listedAt && <p className="text-xs text-zinc-500 dark:text-zinc-400">Connections as of {formatDateTime(s.listedAt)}. Press Test after connecting apps at maton.ai.</p>}
    </div>
  );
}

function AppRow({ workspaceId, a, onChange }: { workspaceId: string; a: MatonAppStatus; onChange: (next?: MatonStatus) => void }) {
  const id = useId();
  const pick = useMutation((connectionId: string | null) =>
    api<MatonStatus>(`/workspaces/${encodeURIComponent(workspaceId)}/maton/connections/${encodeURIComponent(a.app)}`, { method: "PUT", body: { connectionId } }),
  );
  return (
    <li className="space-y-1 px-3 py-2">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-medium">{a.label}</span>
        {a.connections.length === 0 ? (
          <Badge tone="neutral">Not connected in Maton</Badge>
        ) : a.usedByOkara ? (
          <Badge tone="success">
            {a.connections.length} active connection{a.connections.length === 1 ? "" : "s"}
          </Badge>
        ) : (
          <Badge tone="info">Available, not used yet</Badge>
        )}
      </div>
      <p className="text-xs text-zinc-600 dark:text-zinc-400">{a.note}</p>
      {a.connections.length === 1 && <p className="text-xs">Uses {connectionText(a.connections[0]!)}.</p>}
      {a.connections.length > 1 && (
        <div className="max-w-md">
          <SelectField
            id={`${id}-conn`}
            label="Connection to use"
            value={a.selectedConnectionId ?? ""}
            disabled={pick.loading}
            onChange={async (e) => {
              const r = await pick.run(e.target.value || null);
              if (r) onChange(r);
            }}
            hint="Sent as the Maton-Connection header. Default: Maton uses the oldest active connection."
          >
            <option value="">Maton default (oldest)</option>
            {a.connections.map((c) => (
              <option key={c.connectionId} value={c.connectionId}>
                {connectionText(c)}
              </option>
            ))}
          </SelectField>
        </div>
      )}
      {pick.error !== null && <p className="text-xs text-red-700 dark:text-red-400">{errorMessage(pick.error)}</p>}
    </li>
  );
}

/**
 * Search Console source (inside the Search Console card): when the project has no direct Google connection and the
 * workspace's Maton key has a Search Console connection, the owner can pick a property from Maton's sites list.
 */
export function GscMatonSource({ projectId, onChange }: { projectId: string; onChange: () => void }) {
  const pid = encodeURIComponent(projectId);
  const id = useId();
  const status = useApi<GscMatonStatus>(`/projects/${pid}/gsc/maton`);
  const [open, setOpen] = useState(false);
  const sites = useApi<MatonSite[]>(open ? `/projects/${pid}/gsc/maton/sites` : null, [open]);
  const [selected, setSelected] = useState("");
  const save = useMutation((body: { source: "direct" } | { source: "maton"; property: string }) => api<{ status: GscMatonStatus }>(`/projects/${pid}/gsc/source`, { method: "PUT", body }));
  const s = status.data;
  if (!s || s.directConnected) return null;
  if (!s.matonAvailable && s.source !== "maton") {
    return (
      <p className="text-xs text-zinc-600 dark:text-zinc-400">
        No Google Cloud setup? Add a Maton.ai key with a Search Console connection in the <a href="#maton">Maton.ai card</a> below, then use it here.
      </p>
    );
  }
  return (
    <div className="space-y-2 rounded border border-zinc-200 p-3 dark:border-zinc-800" data-testid="gsc-maton-source">
      <p className="text-sm font-medium">Search Console source</p>
      {s.effective === "maton" ? (
        <p className="text-sm">
          Connected via Maton ({s.matonConnectionLabel ?? "default connection"}) · property <span className="font-mono">{s.property ?? "none"}</span>
        </p>
      ) : s.source === "maton" ? (
        <p className="text-sm text-amber-800 dark:text-amber-300">Maton is selected, but the workspace's Maton key has no active Search Console connection. Test the key again.</p>
      ) : (
        <p className="text-sm">Direct Google connection (default). Not connected yet. You can read Search Console through Maton ({s.matonConnectionLabel}) instead.</p>
      )}
      {s.canManage && (
        <div className="flex flex-wrap items-end gap-2">
          {!open ? (
            <Button size="sm" variant={s.effective === "maton" ? "secondary" : "primary"} onClick={() => setOpen(true)}>
              {s.effective === "maton" ? "Change property" : "Use Maton"}
            </Button>
          ) : sites.loading && !sites.data ? (
            <LoadingState label="Loading Search Console properties from Maton…" className="py-1" />
          ) : sites.error ? (
            <ErrorState error={sites.error} onRetry={sites.reload} />
          ) : sites.data ? (
            <form
              className="flex flex-wrap items-end gap-2"
              onSubmit={async (e) => {
                e.preventDefault();
                if (!selected) return;
                const r = await save.run({ source: "maton", property: selected });
                if (r) {
                  setOpen(false);
                  status.reload();
                  onChange();
                }
              }}
            >
              <div className="min-w-0 flex-1 sm:max-w-md">
                <SelectField id={`${id}-prop`} label="Property (via Maton)" value={selected} onChange={(e) => setSelected(e.target.value)}>
                  <option value="">Select a property…</option>
                  {sites.data.map((p) => (
                    <option key={p.siteUrl} value={p.siteUrl}>
                      {p.siteUrl} ({p.permissionLevel})
                    </option>
                  ))}
                </SelectField>
              </div>
              <Button type="submit" size="sm" variant="primary" loading={save.loading} disabled={!selected}>
                Use this property
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setOpen(false)}>
                Cancel
              </Button>
            </form>
          ) : null}
          {s.source === "maton" && (
            <Button
              size="sm"
              variant="ghost"
              loading={save.loading}
              onClick={async () => {
                const r = await save.run({ source: "direct" });
                if (r) {
                  status.reload();
                  onChange();
                }
              }}
            >
              Stop using Maton
            </Button>
          )}
        </div>
      )}
      {save.error !== null && <p className="text-xs text-red-700 dark:text-red-400">{errorMessage(save.error)}</p>}
    </div>
  );
}
