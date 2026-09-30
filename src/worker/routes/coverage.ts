import { Hono } from "hono";
import type { AppEnv } from "../app";

// STUB: owned by the coverage module agent.
export const coverageRoutes = new Hono<AppEnv>();
