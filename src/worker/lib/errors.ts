/** Errors that map to HTTP responses. Messages are safe to show to the user. */
export class HttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
  }
}

export const notFound = (what = "Resource") => new HttpError(404, "not_found", `${what} not found.`);
export const unauthorized = () => new HttpError(401, "unauthorized", "Sign in required.");
export const forbidden = (msg = "Not allowed.") => new HttpError(403, "forbidden", msg);
export const badRequest = (msg: string, details?: unknown) => new HttpError(400, "bad_request", msg, details);
export const conflict = (msg: string) => new HttpError(409, "conflict", msg);
export const tooManyRequests = (msg = "Too many requests.") => new HttpError(429, "rate_limited", msg);
export const setupRequired = (msg: string) => new HttpError(412, "setup_required", msg);

/** A capability is unavailable because configuration or credentials are missing. Never simulate around it. */
export class SetupRequiredError extends Error {
  constructor(public readonly capability: string, message: string) {
    super(message);
  }
}

/** Budget or quota reservation failed. */
export class BudgetExceededError extends Error {
  constructor(public readonly resource: string, message: string) {
    super(message);
  }
}
