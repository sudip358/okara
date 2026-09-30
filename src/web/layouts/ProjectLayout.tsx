/** Layout for /projects/:projectId/*: loads the project, nav, persistent demo banner. OWNED BY: web-shell. */
import { useEffect } from "react";
import { Link, NavLink, Outlet, useParams } from "react-router";
import { ApiError } from "@web/lib/api";
import { ProjectProvider, projectPath, useProjectLoader } from "@web/lib/project-context";
import { useSession } from "@web/lib/session";
import { Badge, DemoBanner, EmptyState, ErrorState, LoadingState, buttonClass, cx } from "@web/components/ui";

const NAV: Array<{ to: string; label: string; end?: boolean; group?: string }> = [
  { to: "", label: "Overview", end: true },
  { to: "checklists", label: "Checklists" },
  { to: "seo", label: "SEO audit", group: "SEO" },
  { to: "internal-links", label: "Internal links" },
  { to: "draft-check", label: "Draft check" },
  { to: "redirects", label: "Redirects" },
  { to: "recommendations", label: "Recommendations" },
  { to: "geo/prompts", label: "GEO prompts", group: "GEO" },
  { to: "geo/results", label: "GEO results" },
  { to: "competitors", label: "Competitors" },
  { to: "runs", label: "Runs", group: "Project" },
  { to: "integrations", label: "Integrations" },
  { to: "usage", label: "Usage" },
  { to: "settings", label: "Settings" },
];

export function ProjectLayout() {
  const { projectId } = useParams();
  const { project, error, loading, reload, setProject } = useProjectLoader(projectId);
  const { workspaceId, setWorkspaceId } = useSession();

  useEffect(() => {
    if (project && project.workspaceId !== workspaceId) setWorkspaceId(project.workspaceId);
  }, [project, workspaceId, setWorkspaceId]);

  if (!projectId) return null;
  if (!project) {
    return (
      <main id="main" className="mx-auto max-w-screen-2xl px-4 py-6">
        {loading ? (
          <LoadingState label="Loading project…" />
        ) : error instanceof ApiError && (error.status === 404 || error.status === 403) ? (
          <EmptyState title="Project not found" action={<Link className={buttonClass("secondary")} to="/projects">All projects</Link>}>
            It may have been deleted, or it belongs to a workspace you are not a member of.
          </EmptyState>
        ) : (
          <ErrorState error={error} onRetry={reload} />
        )}
      </main>
    );
  }

  return (
    <ProjectProvider value={{ project, projectId, reload, setProject }}>
      {project.isDemo && <DemoBanner />}
      <div className="mx-auto max-w-screen-2xl px-4 lg:flex lg:gap-6">
        <aside className="min-w-0 border-b border-zinc-200 py-3 lg:sticky lg:top-8 lg:w-52 lg:shrink-0 lg:self-start lg:border-b-0 lg:py-6 dark:border-zinc-800">
          <div className="mb-3 min-w-0">
            <p className="truncate text-sm font-semibold text-zinc-900 dark:text-zinc-50" title={project.name}>
              {project.name}
            </p>
            <p className="truncate text-xs text-zinc-600 dark:text-zinc-400" title={project.siteUrl}>
              {project.siteUrl}
            </p>
            <div className="mt-1.5 flex flex-wrap gap-1">
              {project.isDemo && <Badge tone="demo">Demo</Badge>}
              {project.verifiedAt ? <Badge tone="success">Verified</Badge> : <Badge tone="warning">Unverified</Badge>}
            </div>
          </div>
          <nav aria-label="Project">
            <ul className="-mx-1 flex gap-1 overflow-x-auto pb-1 lg:mx-0 lg:flex-col lg:overflow-visible lg:pb-0">
              {NAV.map((item) => (
                <li key={item.to} className="shrink-0">
                  {item.group && (
                    <p className="mt-3 hidden px-2 pb-1 text-[11px] font-semibold uppercase tracking-wide text-zinc-500 lg:block dark:text-zinc-400">
                      {item.group}
                    </p>
                  )}
                  <NavLink
                    to={item.to ? projectPath(projectId, item.to) : projectPath(projectId)}
                    end={item.end}
                    className={({ isActive }) =>
                      cx(
                        "block whitespace-nowrap rounded-md px-2 py-1.5 text-sm focus-visible:outline-2 focus-visible:outline-sky-600",
                        isActive
                          ? "bg-zinc-900 font-medium text-white dark:bg-zinc-100 dark:text-zinc-900"
                          : "text-zinc-700 hover:bg-zinc-100 dark:text-zinc-300 dark:hover:bg-zinc-800",
                      )
                    }
                  >
                    {item.label}
                  </NavLink>
                </li>
              ))}
            </ul>
          </nav>
        </aside>
        <main id="main" className="min-w-0 flex-1 py-6">
          <Outlet />
        </main>
      </div>
    </ProjectProvider>
  );
}
