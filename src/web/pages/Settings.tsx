/** Project settings: edit (PATCH), schedule, export, delete (typed-name confirmation). OWNED BY: web-shell. */
import { useId, useState } from "react";
import { useNavigate } from "react-router";
import type { Project, ProjectInput } from "@shared/types";
import { api } from "@web/lib/api";
import { useMutation } from "@web/lib/hooks";
import { useProject } from "@web/lib/project-context";
import { Button, Card, ErrorState, PageHeader, StateBanner, TextField, buttonClass } from "@web/components/ui";
import { ProjectForm } from "@web/components/ProjectForm";

function toInput(p: Project): ProjectInput {
  return {
    name: p.name,
    siteUrl: p.siteUrl,
    siteType: p.siteType,
    brandName: p.brandName,
    brandAliases: p.brandAliases,
    competitors: p.competitors,
    productDescription: p.productDescription,
    audience: p.audience,
    locale: p.locale,
    language: p.language,
    voice: p.voice,
  };
}

export function SettingsPage() {
  const { project, projectId, setProject } = useProject();
  const pid = encodeURIComponent(projectId);
  const navigate = useNavigate();
  const id = useId();
  const [saved, setSaved] = useState(false);
  const [formKey, setFormKey] = useState(0);
  const patch = useMutation((body: Partial<ProjectInput> & { scheduleEnabled?: boolean }) => api<Project>(`/projects/${pid}`, { method: "PATCH", body }));
  const schedule = useMutation((scheduleEnabled: boolean) => api<Project>(`/projects/${pid}`, { method: "PATCH", body: { scheduleEnabled } }));
  const del = useMutation(() => api<unknown>(`/projects/${pid}`, { method: "DELETE" }));
  const [confirmName, setConfirmName] = useState("");

  return (
    <div className="space-y-4">
      <PageHeader title="Settings" />

      <Card title="Schedule" description="When on, each agent runs once per day and delivers zero to two new recommendations.">
        <div className="flex flex-wrap items-center gap-3">
          <label htmlFor={`${id}-sched`} className="flex items-center gap-2 text-sm">
            <input
              id={`${id}-sched`}
              type="checkbox"
              role="switch"
              aria-checked={project.scheduleEnabled}
              className="h-4 w-4 accent-zinc-900 dark:accent-zinc-100"
              checked={project.scheduleEnabled}
              disabled={schedule.loading}
              onChange={async (e) => {
                const p = await schedule.run(e.target.checked);
                if (p) setProject(p);
              }}
            />
            Daily scheduled runs {project.scheduleEnabled ? "on" : "off"}
          </label>
          {schedule.error !== null && <ErrorState error={schedule.error} />}
        </div>
      </Card>

      <section aria-labelledby={`${id}-proj`}>
        <h2 id={`${id}-proj`} className="mb-2 text-sm font-semibold">
          Project details
        </h2>
        {project.verifiedAt && (
          <StateBanner
            className="mb-3"
            state="ready"
            title="Verified host"
            message={`${project.verifiedHost ?? ""}. Changing the website host may require verifying ownership again.`}
          />
        )}
        <ProjectForm
          key={formKey}
          initial={toInput(project)}
          submitLabel="Save changes"
          submitting={patch.loading}
          serverError={
            <>
              {patch.error !== null && <ErrorState error={patch.error} />}
              {saved && <StateBanner state="completed" title="Saved" message="Project updated." />}
            </>
          }
          onSubmit={async (input) => {
            setSaved(false);
            const p = await patch.run(input);
            if (p) {
              setProject(p);
              setSaved(true);
              setFormKey((k) => k + 1);
            }
          }}
        />
      </section>

      <Card title="Export" description="Download all project data as JSON. Secrets and tokens are never included.">
        <a href={`/api/projects/${pid}/export`} download className={buttonClass("secondary")}>
          Download export (JSON)
        </a>
      </Card>

      <Card title="Delete project" className="border-red-300 dark:border-red-900">
        <form
          className="space-y-3"
          onSubmit={async (e) => {
            e.preventDefault();
            if (confirmName !== project.name) return;
            const r = await del.run();
            if (r !== undefined) navigate("/projects", { replace: true });
          }}
        >
          <p className="text-sm text-zinc-700 dark:text-zinc-300">
            Permanently deletes this project's data (crawls, GSC data, GEO observations, recommendations, run history) and revokes its Search Console connection. This cannot be undone.
          </p>
          <div className="max-w-sm">
            <TextField
              id={`${id}-confirm`}
              label={`Type the project name to confirm: ${project.name}`}
              value={confirmName}
              onChange={(e) => setConfirmName(e.target.value)}
              autoComplete="off"
            />
          </div>
          {del.error !== null && <ErrorState error={del.error} />}
          <Button type="submit" variant="danger" disabled={confirmName !== project.name} loading={del.loading}>
            Delete project
          </Button>
        </form>
      </Card>
    </div>
  );
}
