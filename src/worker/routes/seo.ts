import { Hono } from "hono";
import type { AppEnv } from "../app";
import { seoCrawlRoutes } from "./seo-audit";
import { seoOverviewRoutes } from "./seo-overview";

export const seoRoutes = new Hono<AppEnv>();
seoRoutes.route("/", seoCrawlRoutes);
seoRoutes.route("/", seoOverviewRoutes);
