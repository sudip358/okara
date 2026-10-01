# TASKS

Spec: `docs/build-kit.md`. API contract: `docs/api.md` + `src/shared/types.ts`. Schema: `migrations/0001_init.sql`.

## Module ownership (parallel build)

| Module | Owns (files) | Entry points / routes |
|---|---|---|
| foundation (lead) | migrations, src/shared/types.ts, src/worker/{env,app,index}.ts, lib/{db,ids,hash,time,errors,crypto,read-capped}.ts, platform/{access,session,credentials}.ts, recommendations/{evidence,store}.ts, runs/{context,policy}.ts, providers/types.ts, tests/helpers | — |
| platform-auth | platform/{security,oidc,rate-limit,custom-providers}.ts, routes/{auth,credentials,custom-providers}.ts, tests/platform-auth*.test.ts, tests/custom-providers.test.ts | /auth/*, /me, /workspaces/:wid/credentials/*, /workspaces/:wid/custom-providers/*, /workspaces/:wid/writer-source |
| platform-projects | routes/{projects,integrations,demo}.ts, platform/{projects,gsc-oauth,verification,export}.ts, demo/*, tests/platform-projects*.test.ts | projects, context, verification, limits, integrations, GSC OAuth, demo seed |
| seo-crawl | seo/crawl/**, seo/rules/**, seo/ssrf.ts, routes/seo-audit.ts (exports `seoCrawlRoutes`), tests/seo-crawl*.test.ts | `runCrawl` |
| seo-analysis | seo/gsc/**, seo/recommend/**, seo/questions.ts, routes/seo-overview.ts (exports `seoOverviewRoutes`), tests/seo-analysis*.test.ts | `syncGsc`, `generateSeoRecommendations` |
| geo-providers | providers/{gemini,perplexity,rates}.ts, geo/batch.ts, tests/geo-providers*.test.ts, tests/fixtures/geo/* | `runGeoBatch` |
| geo-analysis | geo/{analyze,detect,source-type,metrics,proposals,prompts,manual-import,questions}.ts, routes/geo.ts, tests/geo-analysis*.test.ts | `analyzeObservation`, `generateGeoProposals`, /geo/* |
| runtime | providers/{typesafe,writer-anthropic,writer-openai}.ts, writing/**, runs/{budget,calls,locks,runtime,orchestrate,scheduler,workflow}.ts, routes/{runs,recommendations}.ts, tests/runtime*.test.ts | runs, recommendations, usage, attention |
| web-shell | src/web/{main,App}.tsx, src/web/lib/**, src/web/components/**, pages: SignIn, Workspace/Projects, Onboarding, Overview, Integrations (+ pages/integrations/**: writer card custom provider flow), Usage, Settings, RunHistory | — |
| web-features | src/web/pages/{seo,geo,recommendations}/** | SEO audit, recommendations list/detail, GEO prompts, GEO results, observation drawer, competitors |

## Milestones
- [x] M0 Foundation: scaffold, schema, contracts, test harness
- [ ] M1–M5 per docs/build-kit.md section 1 (tracked by module agents)
