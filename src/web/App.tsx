/** Router. OWNED BY: web-shell. Feature pages (seo/geo/recommendations) are owned by web-features. */
import { createBrowserRouter, Navigate, RouterProvider } from "react-router";
import { SessionProvider } from "./lib/session";
import { AppLayout } from "./layouts/AppLayout";
import { ProjectLayout } from "./layouts/ProjectLayout";
import { SignInPage } from "./pages/SignIn";
import { HomeRedirect, ProjectsPage } from "./pages/Projects";
import { OnboardingPage } from "./pages/Onboarding";
import { OverviewPage } from "./pages/Overview";
import { IntegrationsPage } from "./pages/Integrations";
import { UsagePage } from "./pages/Usage";
import { SettingsPage } from "./pages/Settings";
import { RunHistoryPage } from "./pages/RunHistory";
import { RunDetailPage } from "./pages/RunDetail";
import { NotFoundPage } from "./pages/NotFound";
import { SeoAuditPage } from "./pages/seo/SeoAuditPage";
import { RecommendationsPage } from "./pages/recommendations/RecommendationsPage";
import { RecommendationDetailPage } from "./pages/recommendations/RecommendationDetailPage";
import { GeoPromptsPage } from "./pages/geo/GeoPromptsPage";
import { GeoResultsPage } from "./pages/geo/GeoResultsPage";
import { CompetitorsPage } from "./pages/geo/CompetitorsPage";

const router = createBrowserRouter([
  { path: "/signin", element: <SignInPage /> },
  {
    path: "/",
    element: <AppLayout />,
    children: [
      { index: true, element: <HomeRedirect /> },
      { path: "projects", element: <ProjectsPage /> },
      { path: "projects/new", element: <OnboardingPage /> },
      {
        path: "projects/:projectId",
        element: <ProjectLayout />,
        children: [
          { index: true, element: <OverviewPage /> },
          { path: "seo", element: <SeoAuditPage /> },
          { path: "recommendations", element: <RecommendationsPage /> },
          { path: "recommendations/:recId", element: <RecommendationDetailPage /> },
          { path: "geo", element: <Navigate to="results" replace /> },
          { path: "geo/prompts", element: <GeoPromptsPage /> },
          { path: "geo/results", element: <GeoResultsPage /> },
          { path: "competitors", element: <CompetitorsPage /> },
          { path: "runs", element: <RunHistoryPage /> },
          { path: "runs/:runId", element: <RunDetailPage /> },
          { path: "integrations", element: <IntegrationsPage /> },
          { path: "usage", element: <UsagePage /> },
          { path: "settings", element: <SettingsPage /> },
          { path: "*", element: <NotFoundPage embedded /> },
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
