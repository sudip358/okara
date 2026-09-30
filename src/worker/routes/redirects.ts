import { Hono } from "hono";
import type { AppEnv } from "../app";

// STUB: owned by the redirects module agent.
export const redirectRoutes = new Hono<AppEnv>();
