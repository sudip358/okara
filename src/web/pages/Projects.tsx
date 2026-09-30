/** Workspace switcher + project list + demo seed. OWNED BY: web-shell. */
import { Link, Navigate, useNavigate } from "react-router";
import type { Project } from "@shared/types";
import { api, errorMessage } from "@web/lib/api";
import { useApi, useMutation } from "@web/lib/hooks";
import { formatDate } from "@web/lib/format";
import { projectPath } from "@web/lib/project-context";
import { useSession } from "@web/lib/session";
import { Badge, EmptyState, ErrorState, LoadingState, PageHeader, StateBanner, Button, buttonClass } from "@web/components/ui";
import { WorkspaceSwitcher } from "@web/components/WorkspaceSwitcher";

function useWorkspaceProjects() {
  const { workspaceId } = useSession();
  return useApi<Project[]>(workspaceId ? `/workspaces/${encodeURIComponent(workspaceId)}/projects` : null);
}

/** "/" → first project, or /projects when there are none. */
export function HomeRedirect() {
  const { workspaceId } = useSession();
  const { data, error, loading } = useWorkspaceProjects();
  if (!workspaceId) return <Navigate to="/projects" replace />;
  if (loading || (!data && !error)) {
    return (
      <main id="main" className="mx-auto max-w-screen-lg px-4 py-6">
        <LoadingState />
      </main>
    );
  }
  const first = data?.[0];
  return <Navigate to={first ? projectPath(first.id) : "/projects"} replace />;
}

export function ProjectsPage() {
  const { me, workspaceId } = useSession();
  const navigate = useNavigate();
  const { data, error, loading, reload } = useWorkspaceProjects();
  const seed = useMutation(() => api<Project | { projectId?: string; id?: string }>("/demo/seed", { method: "POST" }));
  const workspace = me?.workspaces.find((w) => w.id === workspaceId);

  const loadDemo = async () => {
    const res = await seed.run();
    if (!res) return;
    const id = (res as { id?: string; projectId?: string }).id ?? (res as { projectId?: string }).projectId;
    if (id) navigate(projectPath(id));
    else reload();
  };

  return (
    <main id="main" className="mx-auto max-w-screen-lg px-4 py-6">
      <PageHeader
        title="Projects"
        description={workspace ? `Workspace: ${workspace.name}` : undefined}
        actions={
          <>
            {me?.demoModeAvailable && (
              <Button onClick={() => void loadDemo()} loading={seed.loading}>
                Load demo project
              </Button>
            )}
            <Link to="/projects/new" className={buttonClass("primary")}>
              New project
            </Link>
          </>
        }
      />
      {me && me.workspaces.length > 1 && (
        <div className="mb-4 flex items-center gap-2 text-sm">
          <span className="text-zinc-600 dark:text-zinc-400">Switch workspace:</span>
          <WorkspaceSwitcher />
        </div>
      )}
      {seed.error !== null && <StateBanner className="mb-4" state="failed" message={errorMessage(seed.error)} />}
      {me?.demoModeAvailable && (
        <p className="mb-4 text-xs text-zinc-600 dark:text-zinc-400">
          The demo project uses labelled test fixtures (simulated runs). It is available only in demo mode, never in production.
        </p>
      )}
      {!workspaceId ? (
        <EmptyState title="No workspace">Your account has no workspace yet. Sign out and sign in again to create one.</EmptyState>
      ) : loading && !data ? (
        <LoadingState label="Loading projects…" />
      ) : error ? (
        <ErrorState error={error} onRetry={reload} />
      ) : !data || data.length === 0 ? (
        <EmptyState
          title="No projects yet"
          action={
            <Link to="/projects/new" className={buttonClass("primary")}>
              Create your first project
            </Link>
          }
        >
          A project is one website: brand details, competitors, and the two agents that watch it.
        </EmptyState>
      ) : (
        <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {data.map((p) => (
            <li key={p.id}>
              <Link
                to={projectPath(p.id)}
                className="block h-full rounded-xl border border-zinc-200 bg-white p-4 text-inherit no-underline shadow-sm hover:border-zinc-400 hover:no-underline focus-visible:outline-2 focus-visible:outline-sky-600 dark:border-zinc-800 dark:bg-zinc-900 dark:hover:border-zinc-600"
              >
                <div className="flex items-start justify-between gap-2">
                  <p className="min-w-0 truncate font-semibold text-zinc-900 dark:text-zinc-50">{p.name}</p>
                  {p.isDemo && <Badge tone="demo">Demo</Badge>}
                </div>
                <p className="truncate text-sm text-zinc-600 dark:text-zinc-400">{p.siteUrl}</p>
                <div className="mt-3 flex flex-wrap gap-1.5">
                  {p.verifiedAt ? <Badge tone="success">Verified ({p.verificationMethod ?? "—"})</Badge> : <Badge tone="warning">Unverified</Badge>}
                  {p.gscProperty ? <Badge tone="info">GSC connected</Badge> : <Badge>GSC not connected</Badge>}
                  <Badge>{p.scheduleEnabled ? "Daily schedule on" : "Schedule off"}</Badge>
                </div>
                <p className="mt-3 text-xs text-zinc-500 dark:text-zinc-400">Created {formatDate(p.createdAt)}</p>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
