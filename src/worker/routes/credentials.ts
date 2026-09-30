import { Hono } from "hono";
import type { AppEnv } from "../app";

// STUB: owned by a module agent; see TASKS.md.
export const credentialRoutes = new Hono<AppEnv>();
