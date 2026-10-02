/** Router. OWNED BY: web-shell. Feature pages (seo/geo/recommendations) are owned by web-features. */
import { createBrowserRouter, Navigate, RouterProvider } from "react-router";
import { SessionProvider } from "./lib/session";
import { AppLayout } from "./layouts/AppLayout";
import { ProjectLayout } from "./layouts/ProjectLayout";
import { SignInPage } from "./pages/SignIn";
import { HomeRedirect, ProjectsPage } from "./pages/Projects";
import { NotFoundPage } from "./pages/NotFound";
import { RouteError } from "./components/RouteError";
import { installPreloadErrorReload } from "./components/preload-reload";

/** A tab left open across a redeploy reloads once when a hashed route chunk is gone (see components/chunk-reload.ts). */
installPreloadErrorReload();

/** Route-level code splitting: each page loads on first visit. */
function page<M extends Record<string, unknown>>(load: () => Promise<M>, name: keyof M & string) {
  return async () => ({ Component: (await load())[name] as React.ComponentType });
}

const router = createBrowserRouter([
  { path: "/signin", element: <SignInPage />, errorElement: <RouteError /> },
  {
    path: "/",
    element: <AppLayout />,
    errorElement: <RouteError />,
    children: [
      { index: true, element: <HomeRedirect /> },
      { path: "projects", element: <ProjectsPage /> },
      { path: "projects/new", lazy: page(() => import("./pages/Onboarding"), "OnboardingPage") },
      {
        path: "projects/:projectId",
        element: <ProjectLayout />,
        children: [
          {
            // Pathless boundary: a failed page (e.g. a stale chunk) renders inside the project layout, keeping its nav.
            errorElement: <RouteError embedded />,
            children: [
              { index: true, lazy: page(() => import("./pages/Overview"), "OverviewPage") },
              { path: "live", lazy: page(() => import("./pages/live/LivePage"), "LivePage") },
              { path: "seo", lazy: page(() => import("./pages/seo/SeoAuditPage"), "SeoAuditPage") },
              { path: "internal-links", lazy: page(() => import("./pages/links/InternalLinksPage"), "InternalLinksPage") },
              { path: "draft-check", lazy: page(() => import("./pages/draft-check/DraftCheckPage"), "DraftCheckPage") },
              { path: "redirects", lazy: page(() => import("./pages/redirects/RedirectMapPage"), "RedirectMapPage") },
              { path: "recommendations", lazy: page(() => import("./pages/recommendations/RecommendationsPage"), "RecommendationsPage") },
              { path: "recommendations/:recId", lazy: page(() => import("./pages/recommendations/RecommendationDetailPage"), "RecommendationDetailPage") },
              { path: "geo", element: <Navigate to="results" replace /> },
              { path: "geo/prompts", lazy: page(() => import("./pages/geo/GeoPromptsPage"), "GeoPromptsPage") },
              { path: "geo/results", lazy: page(() => import("./pages/geo/GeoResultsPage"), "GeoResultsPage") },
              { path: "geo/board", lazy: page(() => import("./pages/geo/EngineBoardPage"), "EngineBoardPage") },
              { path: "competitors", lazy: page(() => import("./pages/geo/CompetitorsPage"), "CompetitorsPage") },
              { path: "checklists", lazy: page(() => import("./pages/checklists/ChecklistsPage"), "ChecklistsPage") },
              { path: "pages/:pageId/checklist", lazy: page(() => import("./pages/checklists/PageChecklistPage"), "PageChecklistPage") },
              { path: "runs", lazy: page(() => import("./pages/RunHistory"), "RunHistoryPage") },
              { path: "runs/:runId", lazy: page(() => import("./pages/RunDetail"), "RunDetailPage") },
              { path: "import", lazy: page(() => import("./pages/import/ImportPage"), "ImportPage") },
              { path: "integrations", lazy: page(() => import("./pages/Integrations"), "IntegrationsPage") },
              { path: "usage", lazy: page(() => import("./pages/Usage"), "UsagePage") },
              { path: "settings", lazy: page(() => import("./pages/Settings"), "SettingsPage") },
              { path: "*", element: <NotFoundPage embedded /> },
            ],
          },
        ],
      },
      { path: "*", element: <NotFoundPage /> },
    ],
  },
]);

export function App() {
  return (
    <SessionProvider>
      <RouterProvider router={router} />
    </SessionProvider>
  );
}
