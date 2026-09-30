/** Current project for routes under /projects/:projectId. OWNED BY: web-shell. */
import { createContext, useContext, type ReactNode } from "react";
import type { Project } from "@shared/types";
import { useApi } from "./hooks";

export interface ProjectContextValue {
  project: Project;
  projectId: string;
  reload: () => void;
  /** Replace the cached project (e.g. after PATCH returned the updated one). */
  setProject: (p: Project) => void;
}

const ProjectContext = createContext<ProjectContextValue | null>(null);

export interface ProjectLoadState {
  project: Project | null;
  error: unknown;
  loading: boolean;
  reload: () => void;
  setProject: (p: Project) => void;
}

/** Fetches GET /projects/:id. Used by the project layout, which renders ProjectProvider once loaded. */
export function useProjectLoader(projectId: string | undefined): ProjectLoadState {
  const { data, error, loading, reload, setData } = useApi<Project>(projectId ? `/projects/${encodeURIComponent(projectId)}` : null);
  return { project: data, error, loading, reload, setProject: (p) => setData(p) };
}

export function ProjectProvider({ value, children }: { value: ProjectContextValue; children: ReactNode }) {
  return <ProjectContext.Provider value={value}>{children}</ProjectContext.Provider>;
}

/** { project, projectId, reload, setProject } for any page under /projects/:projectId. */
export function useProject(): ProjectContextValue {
  const v = useContext(ProjectContext);
  if (!v) throw new Error("useProject must be used under /projects/:projectId");
  return v;
}

/** Path helper: projectPath(id, "runs") → "/projects/<id>/runs". */
export function projectPath(projectId: string, sub = ""): string {
  const base = `/projects/${encodeURIComponent(projectId)}`;
  return sub ? `${base}/${sub.replace(/^\//, "")}` : base;
}
