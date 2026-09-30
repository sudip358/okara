import { Hono } from "hono";
import type { AppEnv } from "../app";

// STUB: owned by the robots-advisor module agent.
export const robotsRoutes = new Hono<AppEnv>();
