import { Hono } from "hono";
import type { AppEnv } from "../app";

// STUB: owned by the internal-links module agent.
export const linkRoutes = new Hono<AppEnv>();
