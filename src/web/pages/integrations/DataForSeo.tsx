/**
 * DataForSEO credentials card (Integrations page): API login + API password (HTTP Basic), save / test /
 * delete, and the account balance from the free user_data test. Credentials are write-only: never shown after
 * saving (only the last 4 characters of the password). Competitor data itself lives on the Competitors page.
 */
import { useId, useState } from "react";
import type { DataForSeoCredentialStatus, DataForSeoTestResult } from "@shared/competitor-data";
import { api, errorMessage } from "@web/lib/api";
import { useApi, useMutation } from "@web/lib/hooks";
import { formatDateTime, formatUsd } from "@web/lib/format";
import { Button, Card, ErrorState, LoadingState, StateBadge, TextField } from "@web/components/ui";

export const DATAFORSEO_NOTE =
  "Third-party SEO estimates for competitor domains (DataForSEO Labs: ranked keywords, keyword gap, top pages). Paid per request on your DataForSEO account; tests use the free user_data endpoint. Get the API login and API password at app.dataforseo.com/api-access (the API password is not your account password).";

export const SOURCE_TEXT: Record<DataForSeoCredentialStatus["source"], string> = {
  workspace_key: "Workspace credentials",
  operator_key: "Operator credentials (shared, global daily caps apply)",
  none: "Not configured",
};

export function DataForSeoCard({ workspaceId }: { workspaceId: string }) {
  const status = useApi<DataForSeoCredentialStatus>(`/workspaces/${encodeURIComponent(workspaceId)}/dataforseo`);
  return (
    <Card title="DataForSEO" description={DATAFORSEO_NOTE}>
      {status.loading && !status.data ? (
        <LoadingState />
      ) : !status.data ? (
        <ErrorState error={status.error} onRetry={status.reload} />
      ) : (
        <DataForSeoRow workspaceId={workspaceId} s={status.data} onChange={(next) => (next ? status.setData(next) : status.reload())} />
      )}
    </Card>
  );
}

export function DataForSeoRow({ workspaceId, s, onChange }: { workspaceId: string; s: DataForSeoCredentialStatus; onChange: (next?: DataForSeoCredentialStatus) => void }) {
  const id = useId();
  const path = `/workspaces/${encodeURIComponent(workspaceId)}/dataforseo`;
  const [login, setLogin] = useState("");
  const [password, setPassword] = useState("");
  const [confirmDelete, setConfirmDelete] = useState(false);
  const save = useMutation((body: { login: string; password: string }) => api<DataForSeoCredentialStatus>(path, { method: "PUT", body }));
  const test = useMutation((body: { login?: string; password?: string }) => api<DataForSeoTestResult>(`${path}/test`, { method: "POST", body }));
  const del = useMutation(() => api<unknown>(path, { method: "DELETE" }));
  const typed = login.trim() !== "" && password.trim() !== "";
  const balance = test.data?.balanceUsd ?? s.lastBalanceUsd;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0 text-xs text-zinc-600 dark:text-zinc-400">
          <p className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">{s.label}</p>
          <p>
            {SOURCE_TEXT[s.source]}
            {s.keyHint && (
              <>
                {" "}
                · password ending <span className="font-mono">{s.keyHint}</span>
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
          {balance !== null && balance !== undefined && (
            <p>
              Remaining balance: <span className="font-medium tabular-nums text-zinc-900 dark:text-zinc-100">{formatUsd(balance)}</span> (DataForSEO account, at test time)
            </p>
          )}
        </div>
        <StateBadge state={s.state} />
      </div>
      <p className="rounded bg-zinc-50 px-2 py-1.5 text-xs text-zinc-700 dark:bg-zinc-950 dark:text-zinc-300">
        <span className="font-medium">Data sent:</span> {s.dataSent}
      </p>
      {!s.storageReady && (
        <p className="text-xs text-amber-800 dark:text-amber-300">Saving workspace credentials needs database migration 0014 to be applied.</p>
      )}
      <form
        className="flex flex-wrap items-end gap-2"
        onSubmit={async (e) => {
          e.preventDefault();
          if (!typed) return;
          const r = await save.run({ login: login.trim(), password: password.trim() });
          if (r) {
            setLogin("");
            setPassword("");
            test.reset();
            onChange(r);
          }
        }}
      >
        <div className="min-w-0 flex-1 sm:max-w-xs">
          <TextField id={`${id}-login`} label="API login" autoComplete="off" spellCheck={false} value={login} onChange={(e) => setLogin(e.target.value)} placeholder="you@example.com" />
        </div>
        <div className="min-w-0 flex-1 sm:max-w-xs">
          <TextField
            id={`${id}-password`}
            label="API password"
            type="password"
            autoComplete="off"
            spellCheck={false}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder={s.keyHint ? `Replace …${s.keyHint}` : "API password"}
          />
        </div>
        <Button type="submit" variant="primary" disabled={!typed} loading={save.loading}>
          Save credentials
        </Button>
        <Button
          loading={test.loading}
          disabled={!typed && s.source !== "workspace_key"}
          onClick={async () => {
            const r = await test.run(typed ? { login: login.trim(), password: password.trim() } : {});
            if (r && !typed) onChange();
          }}
        >
          {typed ? "Test typed credentials" : "Test saved credentials"}
        </Button>
        {s.source === "workspace_key" &&
          (!confirmDelete ? (
            <Button variant="ghost" onClick={() => setConfirmDelete(true)}>
              Delete credentials
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
                Confirm delete
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
    </div>
  );
}
