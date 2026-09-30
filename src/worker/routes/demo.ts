import { Hono } from "hono";
import type { AppEnv } from "../app";

// STUB: owned by a module agent; see TASKS.md.
export const demoRoutes = new Hono<AppEnv>();
