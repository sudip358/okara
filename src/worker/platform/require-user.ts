/**
 * Route helper kept outside app.ts so route modules can import it without a circular
 * dependency on the app (app.ts imports every route module).
 */
import { HttpError } from "../lib/errors";
import type { SessionUser } from "./access";

/** The signed-in user or 401. */
export function requireUser(c: { get(key: "user"): SessionUser | null }): SessionUser {
  const u = c.get("user");
  if (!u) throw new HttpError(401, "unauthorized", "Sign in required.");
  return u;
}
