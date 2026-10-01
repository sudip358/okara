/**
 * Integrations: ownership verification, Google Search Console, workspace provider keys, and the writer's
 * provider type (default writer or a custom OpenAI-compatible provider; see integrations/CustomWriter.tsx).
 * Keys are write-only: never displayed after save (only the server-provided hint). OWNED BY: web-shell.
 */
import { useId, useState } from "react";
import { Link, useSearchParams } from "react-router";
import type { GeoPromptSet, IntegrationsStatus, VerificationStatus } from "@shared/types";
import { api, errorMessage } from "@web/lib/api";
import { useApi, useMutation, type ApiState } from "@web/lib/hooks";
import { formatDateTime } from "@web/lib/format";
import { projectPath, useProject } from "@web/lib/project-context";
import {
  Badge,
  Button,
  Card,
  Definition,
  ErrorState,
  LoadingState,
  PageHeader,
  SelectField,
  StateBadge,
  StateBanner,
  TextField,
  buttonClass,
  cx,
} from "@web/components/ui";
import { WriterProviderRow } from "./integrations/CustomWriter";

type ProviderStatus = IntegrationsStatus["providers"][number];

export function IntegrationsPage() {
  const { project, projectId, reload: reloadProject } = useProject();
  const pid = encodeURIComponent(projectId);
  const [params] = useSearchParams();
  const onboarding = params.get("onboarding") === "1";
  const gscError = params.get("gscError") ?? params.get("error");
  const integrations = useApi<IntegrationsStatus>(`/projects/${pid}/integrations`);
  const verification = useApi<VerificationStatus>(`/projects/${pid}/verification`);
  const prompts = useApi<GeoPromptSet>(`/projects/${pid}/geo/prompts`);

  const approvedPrompts = prompts.data?.prompts.filter((p) => p.approved).length ?? 0;
  const providersReady = (integrations.data?.providers ?? []).filter((p) => p.state === "ready" && p.provider !== "typesafe" && p.provider !== "writer");
  const steps: Array<{ label: string; done: boolean | null; to?: string; href?: string; detail: string }> = [
    {
      label: "Verify site ownership",
      done: verification.data ? verification.data.verified : null,
      detail: "Required before any crawl. Use Search Console, a DNS TXT record, or a verification file.",
    },
    {
      label: "Connect Google Search Console",
      done: integrations.data ? integrations.data.gsc.state === "ready" && !!integrations.data.gsc.property : null,
      detail: "Read-only access to impressions, clicks, and CTR.",
    },
    {
      label: "Add provider keys",
      done: integrations.data ? providersReady.length > 0 : null,
      detail: "At least one web-grounded GEO provider, plus Jev and a writing provider for recommendations.",
    },
    {
      label: "Approve GEO prompts",
      done: prompts.data ? approvedPrompts > 0 : prompts.error ? null : null,
      to: projectPath(projectId, "geo/prompts"),
      detail: prompts.data ? `${approvedPrompts} of ${prompts.data.prompts.length} prompts approved.` : "Review the brand-blind discovery prompts before any GEO batch runs.",
    },
  ];

  return (
    <div className="space-y-4">
      <PageHeader title="Integrations" description="Ownership verification, Search Console, and the API keys this workspace uses." />
      {onboarding && <StateBanner state="completed" title="Project created" message="Complete these steps to start the agents. You can come back to this page any time." />}
      {gscError && <StateBanner state="failed" title="Search Console connection did not complete" message={`Reason: ${gscError}. Please try again.`} />}

      <Card title="Setup checklist">
        <ol className="space-y-2">
          {steps.map((s, i) => (
            <li key={s.label} className="flex items-start gap-3">
              <span
                aria-hidden="true"
                className={cx(
                  "mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-xs font-semibold",
                  s.done ? "bg-emerald-600 text-white" : "bg-zinc-200 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300",
                )}
              >
                {s.done ? "✓" : i + 1}
              </span>
              <div className="min-w-0">
                <p className="text-sm font-medium">
                  {s.to ? <Link to={s.to}>{s.label}</Link> : s.label}{" "}
                  <span className="sr-only">{s.done ? "(done)" : s.done === false ? "(to do)" : "(status unknown)"}</span>
                  {s.done === true && <Badge tone="success">Done</Badge>}
                  {s.done === false && <Badge tone="warning">To do</Badge>}
                </p>
                <p className="text-xs text-zinc-600 dark:text-zinc-400">{s.detail}</p>
              </div>
            </li>
          ))}
        </ol>
      </Card>

      <VerificationCard
        projectId={projectId}
        state={verification}
        onVerified={() => {
          reloadProject();
        }}
        hasGsc={!!integrations.data?.gsc.property}
      />

      {integrations.loading && !integrations.data ? (
        <LoadingState />
      ) : integrations.error ? (
        <ErrorState error={integrations.error} onRetry={integrations.reload} />
      ) : integrations.data ? (
        <>
          <GscCard
            projectId={projectId}
            gsc={integrations.data.gsc}
            siteUrl={project.siteUrl}
            onChange={() => {
              integrations.reload();
              verification.reload();
              reloadProject();
            }}
          />
          <ProviderKeysCard workspaceId={project.workspaceId} fallback={integrations.data.providers} onChange={integrations.reload} />
        </>
      ) : null}
    </div>
  );
}

// ------------------------------------------------------------------ verification
function VerificationCard({
  projectId,
  state,
  onVerified,
  hasGsc,
}: {
  projectId: string;
  state: ApiState<VerificationStatus>;
  onVerified: () => void;
  hasGsc: boolean;
}) {
  const check = useMutation((method: "dns" | "file" | "gsc") =>
    api<VerificationStatus>(`/projects/${encodeURIComponent(projectId)}/verification/check`, { method: "POST", body: { method } }),
  );
  const [lastMethod, setLastMethod] = useState<string | null>(null);
  const run = async (method: "dns" | "file" | "gsc") => {
    setLastMethod(method);
    const res = await check.run(method);
    if (res) {
      state.setData(res);
      if (res.verified) onVerified();
    }
  };
  const v = state.data;

  return (
    <Card title="Site ownership" description="Crawling is limited to verified hosts. Possession of a URL is not proof of ownership.">
      {state.loading && !v ? (
        <LoadingState />
      ) : state.error ? (
        <ErrorState error={state.error} onRetry={state.reload} />
      ) : !v ? null : v.verified ? (
        <dl className="space-y-1">
          <Definition term="Status">
            <Badge tone="success">Verified</Badge>
          </Definition>
          <Definition term="Host">{v.verifiedHost ?? "—"}</Definition>
          <Definition term="Method">{v.method === "gsc" ? "Search Console property" : v.method === "dns" ? "DNS TXT record" : v.method === "file" ? "Verification file" : "—"}</Definition>
        </dl>
      ) : (
        <div className="space-y-4">
          <StateBanner state="setup_required" title="Not verified" message="Choose one method below, then press Check." />
          <div className="grid gap-4 lg:grid-cols-3">
            <div className="min-w-0 rounded-lg border border-zinc-200 p-3 dark:border-zinc-800">
              <p className="text-sm font-medium">Search Console</p>
              <p className="mt-1 text-xs text-zinc-600 dark:text-zinc-400">
                Connect Search Console below and select a property that covers this site; ownership is confirmed from your GSC permission level.
              </p>
              <Button className="mt-2" size="sm" disabled={!hasGsc} loading={check.loading && lastMethod === "gsc"} onClick={() => void run("gsc")}>
                Check via Search Console
              </Button>
            </div>
            <div className="min-w-0 rounded-lg border border-zinc-200 p-3 dark:border-zinc-800">
              <p className="text-sm font-medium">DNS TXT record</p>
              {v.dnsRecord ? (
                <dl className="mt-1 space-y-1 text-xs">
                  <CopyRow term="Name" value={v.dnsRecord.name} />
                  <CopyRow term="Type" value={v.dnsRecord.type} />
                  <CopyRow term="Value" value={v.dnsRecord.value} />
                </dl>
              ) : (
                <p className="mt-1 text-xs text-zinc-600 dark:text-zinc-400">DNS instructions are not available.</p>
              )}
              <Button className="mt-2" size="sm" disabled={!v.dnsRecord} loading={check.loading && lastMethod === "dns"} onClick={() => void run("dns")}>
                Check DNS
              </Button>
            </div>
            <div className="min-w-0 rounded-lg border border-zinc-200 p-3 dark:border-zinc-800">
              <p className="text-sm font-medium">Verification file</p>
              {v.fileCheck ? (
                <dl className="mt-1 space-y-1 text-xs">
                  <CopyRow term="Publish at" value={v.fileCheck.url} />
                  <CopyRow term="Exact content" value={v.fileCheck.content} />
                </dl>
              ) : (
                <p className="mt-1 text-xs text-zinc-600 dark:text-zinc-400">File instructions are not available.</p>
              )}
              <Button className="mt-2" size="sm" disabled={!v.fileCheck} loading={check.loading && lastMethod === "file"} onClick={() => void run("file")}>
                Check file
              </Button>
            </div>
          </div>
          <div aria-live="polite">
            {check.error !== null && <ErrorState error={check.error} />}
            {check.data && !check.data.verified && (
              <StateBanner state="failed" title="Not verified yet" message={`The ${lastMethod ?? ""} check did not find the expected value. DNS changes can take a while to propagate.`} />
            )}
          </div>
        </div>
      )}
    </Card>
  );
}

function CopyRow({ term, value }: { term: string; value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div>
      <dt className="text-zinc-600 dark:text-zinc-400">{term}</dt>
      <dd className="flex items-start gap-1">
        <code className="min-w-0 flex-1 break-all rounded bg-zinc-100 px-1.5 py-0.5 dark:bg-zinc-800">{value}</code>
        <Button
          size="sm"
          variant="ghost"
          aria-label={`Copy ${term}`}
          onClick={() => {
            void navigator.clipboard?.writeText(value).then(() => {
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            });
          }}
        >
          {copied ? "Copied" : "Copy"}
        </Button>
      </dd>
    </div>
  );
}

// ------------------------------------------------------------------ GSC
function GscCard({
  projectId,
  gsc,
  siteUrl,
  onChange,
}: {
  projectId: string;
  gsc: IntegrationsStatus["gsc"];
  siteUrl: string;
  onChange: () => void;
}) {
  const pid = encodeURIComponent(projectId);
  const id = useId();
  const connected = gsc.connectedAt !== null;
  const properties = useApi<Array<{ siteUrl: string; permissionLevel: string }>>(connected ? `/projects/${pid}/gsc/properties` : null, [gsc.connectedAt]);
  const [selected, setSelected] = useState<string>(gsc.property ?? "");
  const save = useMutation((property: string) => api<unknown>(`/projects/${pid}/gsc/property`, { method: "PUT", body: { property } }));
  const disconnect = useMutation(() => api<unknown>(`/projects/${pid}/gsc`, { method: "DELETE" }));
  const [confirmDisconnect, setConfirmDisconnect] = useState(false);

  return (
    <Card
      title="Google Search Console"
      description="Read-only (webmasters.readonly). Requested separately from sign-in."
      actions={<StateBadge state={connected ? gsc.state : "not_connected"} />}
    >
      <div className="space-y-3">
        {gsc.lastError && <StateBanner state="error" message={gsc.lastError} />}
        {!connected ? (
          <>
            <p className="text-sm text-zinc-700 dark:text-zinc-300">
              Connect to import finalized impressions, clicks, and CTR for the latest 28-day window and the previous 28 days.
            </p>
            <a href={`/api/projects/${pid}/gsc/connect`} className={buttonClass("primary")}>
              Connect Google Search Console
            </a>
          </>
        ) : (
          <>
            <dl className="space-y-1">
              <Definition term="Connected">{formatDateTime(gsc.connectedAt)}</Definition>
              <Definition term="Property">{gsc.property ? <span className="font-mono">{gsc.property}</span> : "None selected"}</Definition>
            </dl>
            {properties.loading && !properties.data ? (
              <LoadingState label="Loading your Search Console properties…" className="py-2" />
            ) : properties.error ? (
              <ErrorState error={properties.error} onRetry={properties.reload} />
            ) : properties.data && properties.data.length === 0 ? (
              <StateBanner state="no_data" message="This Google account has no Search Console properties." />
            ) : properties.data ? (
              <form
                className="flex flex-wrap items-end gap-2"
                onSubmit={async (e) => {
                  e.preventDefault();
                  if (!selected) return;
                  const ok = await save.run(selected);
                  if (ok !== undefined) onChange();
                }}
              >
                <div className="min-w-0 flex-1 sm:max-w-md">
                  <SelectField id={`${id}-prop`} label="Property" value={selected} onChange={(e) => setSelected(e.target.value)} hint={`Pick the property that covers ${siteUrl} (URL-prefix or sc-domain).`}>
                    <option value="">Select a property…</option>
                    {properties.data.map((p) => (
                      <option key={p.siteUrl} value={p.siteUrl}>
                        {p.siteUrl} ({p.permissionLevel})
                      </option>
                    ))}
                  </SelectField>
                </div>
                <Button type="submit" variant="primary" loading={save.loading} disabled={!selected || selected === gsc.property}>
                  Use this property
                </Button>
              </form>
            ) : null}
            {save.error !== null && <ErrorState error={save.error} />}
            <div className="flex flex-wrap items-center gap-2 border-t border-zinc-100 pt-3 dark:border-zinc-800">
              {!confirmDisconnect ? (
                <Button variant="secondary" size="sm" onClick={() => setConfirmDisconnect(true)}>
                  Disconnect
                </Button>
              ) : (
                <>
                  <span className="text-sm">
                    Delete this project's stored Google token? Other projects connected with the same Google account keep
                    working. To revoke access entirely, use myaccount.google.com; that affects every project using that account.
                  </span>
                  <Button
                    variant="danger"
                    size="sm"
                    loading={disconnect.loading}
                    onClick={async () => {
                      const ok = await disconnect.run();
                      setConfirmDisconnect(false);
                      if (ok !== undefined) onChange();
                    }}
                  >
                    Disconnect
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => setConfirmDisconnect(false)}>
                    Cancel
                  </Button>
                </>
              )}
              <a href={`/api/projects/${pid}/gsc/connect`} className="text-sm">
                Reconnect
              </a>
              {disconnect.error !== null && <span className="text-xs text-red-700 dark:text-red-400">{errorMessage(disconnect.error)}</span>}
            </div>
          </>
        )}
      </div>
    </Card>
  );
}

// ------------------------------------------------------------------ provider keys
const SOURCE_LABEL: Record<ProviderStatus["source"], string> = {
  workspace_key: "Workspace key",
  operator_key: "Operator key (private beta)",
  none: "No key",
};

function ProviderKeysCard({ workspaceId, fallback, onChange }: { workspaceId: string; fallback: ProviderStatus[]; onChange: () => void }) {
  const wid = encodeURIComponent(workspaceId);
  const list = useApi<ProviderStatus[]>(`/workspaces/${wid}/credentials`);
  const providers = list.data ?? (list.error ? fallback : null);

  return (
    <Card
      title="Provider keys"
      description="Keys are stored encrypted on the server for this workspace, never in your browser, and are never shown again after saving."
    >
      {list.loading && !providers ? (
        <LoadingState />
      ) : !providers ? (
        <ErrorState error={list.error} onRetry={list.reload} />
      ) : (
        <div className="space-y-3">
          {list.error !== null && <ErrorState error={list.error} onRetry={list.reload} title="Could not load workspace keys" />}
          <ul className="space-y-3">
            {providers.map((p) => {
              const row = (
                <ProviderRow
                  workspaceId={workspaceId}
                  p={p}
                  onChange={(next) => {
                    if (next && list.data) list.setData(list.data.map((x) => (x.provider === next.provider ? next : x)));
                    else list.reload();
                    onChange();
                  }}
                />
              );
              return (
                <li key={p.provider}>
                  {/* The writer row adds the provider type choice: default writer or a custom OpenAI-compatible provider. */}
                  {p.provider === "writer" ? <WriterProviderRow workspaceId={workspaceId} writer={p} defaultPanel={row} onChange={onChange} /> : row}
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </Card>
  );
}

function ProviderRow({ workspaceId, p, onChange }: { workspaceId: string; p: ProviderStatus; onChange: (next?: ProviderStatus) => void }) {
  const id = useId();
  const base = `/workspaces/${encodeURIComponent(workspaceId)}/credentials/${encodeURIComponent(p.provider)}`;
  const [key, setKey] = useState("");
  const save = useMutation((apiKey: string) => api<ProviderStatus>(base, { method: "PUT", body: { apiKey } }));
  const test = useMutation((apiKey?: string) => api<{ ok: boolean; detail: string }>(`${base}/test`, { method: "POST", body: apiKey ? { apiKey } : {} }));
  const del = useMutation(() => api<unknown>(base, { method: "DELETE" }));
  const [confirmDelete, setConfirmDelete] = useState(false);

  return (
    <div className="rounded-lg border border-zinc-200 p-3 dark:border-zinc-800">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="text-sm font-semibold">{p.label}</p>
          <p className="text-xs text-zinc-600 dark:text-zinc-400">
            {SOURCE_LABEL[p.source]}
            {p.keyHint && <> · key <span className="font-mono">{p.keyHint}</span></>}
            {p.model && <> · model <span className="font-mono">{p.model}</span></>}
          </p>
          <p className="text-xs text-zinc-600 dark:text-zinc-400">
            Last test:{" "}
            {p.lastTestedAt ? (
              <>
                {formatDateTime(p.lastTestedAt)} — {p.lastTestOk ? "passed" : "failed"}
                {p.lastTestDetail && ` (${p.lastTestDetail})`}
              </>
            ) : (
              "never"
            )}
          </p>
        </div>
        <StateBadge state={p.state} />
      </div>
      <p className="mt-2 rounded bg-zinc-50 px-2 py-1.5 text-xs text-zinc-700 dark:bg-zinc-950 dark:text-zinc-300">
        <span className="font-medium">Data sent:</span> {p.dataSent}
      </p>
      <form
        className="mt-3 flex flex-wrap items-end gap-2"
        onSubmit={async (e) => {
          e.preventDefault();
          if (!key.trim()) return;
          const res = await save.run(key.trim());
          if (res) {
            setKey("");
            test.reset();
            onChange(res);
          }
        }}
      >
        <div className="min-w-0 flex-1 sm:max-w-sm">
          <TextField
            id={`${id}-key`}
            label={`${p.label} API key`}
            type="password"
            autoComplete="off"
            spellCheck={false}
            value={key}
            onChange={(e) => setKey(e.target.value)}
            placeholder={p.keyHint ? `Replace ${p.keyHint}` : "Paste key"}
          />
        </div>
        <Button type="submit" variant="primary" disabled={!key.trim()} loading={save.loading}>
          Save key
        </Button>
        <Button
          loading={test.loading}
          disabled={!key.trim() && p.source === "none"}
          onClick={async () => {
            const r = await test.run(key.trim() || undefined);
            if (r && !key.trim()) onChange();
          }}
        >
          {key.trim() ? "Test typed key" : "Test saved key"}
        </Button>
        {p.source === "workspace_key" &&
          (!confirmDelete ? (
            <Button variant="ghost" onClick={() => setConfirmDelete(true)}>
              Delete key
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
      <div aria-live="polite" className="mt-2 text-xs">
        {test.data && (
          <span className={test.data.ok ? "text-emerald-800 dark:text-emerald-300" : "text-red-700 dark:text-red-400"}>
            Test {test.data.ok ? "passed" : "failed"}: {test.data.detail}
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
