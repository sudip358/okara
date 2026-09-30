import { Hono } from "hono";
import type { AppEnv } from "../app";

// STUB: owned by the checklists module agent.
export const checklistRoutes = new Hono<AppEnv>();
