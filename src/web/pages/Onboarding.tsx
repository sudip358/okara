/** New project onboarding (ProjectInput). OWNED BY: web-shell. */
import { Link, useNavigate } from "react-router";
import type { Project, ProjectInput } from "@shared/types";
import { api } from "@web/lib/api";
import { useMutation } from "@web/lib/hooks";
import { projectPath } from "@web/lib/project-context";
import { useSession } from "@web/lib/session";
import { EmptyState, ErrorState, PageHeader } from "@web/components/ui";
import { ProjectForm, emptyProjectInput } from "@web/components/ProjectForm";

export function OnboardingPage() {
  const { workspaceId } = useSession();
  const navigate = useNavigate();
  const create = useMutation((input: ProjectInput) =>
    api<Project>(`/workspaces/${encodeURIComponent(workspaceId ?? "")}/projects`, { method: "POST", body: input }),
  );

  return (
    <main id="main" className="mx-auto max-w-3xl px-4 py-6">
      <p className="mb-2 text-sm">
        <Link to="/projects">← Projects</Link>
      </p>
      <PageHeader
        title="New project"
        description="Tell us about the website. Nothing is crawled until you verify ownership, and nothing is sent to AI providers until you add keys and approve prompts."
      />
      {!workspaceId ? (
        <EmptyState title="No workspace selected" />
      ) : (
        <ProjectForm
          initial={emptyProjectInput()}
          submitLabel="Create project"
          submitting={create.loading}
          serverError={create.error !== null ? <ErrorState error={create.error} /> : null}
          onSubmit={async (input) => {
            const p = await create.run(input);
            if (p) navigate(`${projectPath(p.id, "integrations")}?onboarding=1`);
          }}
        />
      )}
    </main>
  );
}
