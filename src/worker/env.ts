/** Worker bindings and configuration. Secrets are set with `wrangler secret put`. */
export interface Env {
  DB: D1Database;
  AGENT_RUN?: Workflow;
  ASSETS?: Fetcher;

  ENVIRONMENT: "production" | "staging" | "development" | "test";
  APP_ORIGIN: string;
  DEMO_MODE?: string;
  DEV_AUTH_BYPASS?: string;

  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  /** Base64 32-byte keys. Add V2, V3... to rotate; the newest present version encrypts. */
  TOKEN_ENCRYPTION_KEY_V1?: string;
  TOKEN_ENCRYPTION_KEY_V2?: string;

  /** Optional operator-owned provider keys. BYO workspace keys take precedence. */
  TYPESAFE_API_KEY?: string;
  TYPESAFE_MODEL?: string;
  GEMINI_API_KEY?: string;
  GEMINI_MODEL?: string;
  PERPLEXITY_API_KEY?: string;
  PERPLEXITY_MODEL?: string;
  WRITER_PROVIDER?: string; // 'anthropic' | 'openai_compatible'
  WRITER_MODEL?: string;
  WRITER_API_KEY?: string;
  WRITER_BASE_URL?: string;
  /** Optional, openai_compatible only: none|minimal|low|medium|high|xhigh|max, sent as reasoning_effort. Unset: not sent. */
  WRITER_REASONING_EFFORT?: string;
  /**
   * Optional, openai_compatible only: extra max_completion_tokens added to the answer budget for
   * reasoning tokens (and reserved in writer_tokens). Default in providers/writer-openai.ts.
   */
  WRITER_REASONING_HEADROOM_TOKENS?: string;
  /** Optional Gemini thinkingLevel override (e.g. LOW, HIGH) for models that accept it. Default in providers/gemini.ts. */
  GEMINI_THINKING_LEVEL?: string;

  /**
   * Global daily caps across all projects, applied only to spend on the operator keys above
   * (tenants on their own keys are bounded by their project limits only). Defaults in runs/budget.ts.
   */
  GLOBAL_USD_MICROS_PER_DAY?: string;
  GLOBAL_JEV_CALLS_PER_DAY?: string;
  GLOBAL_PROVIDER_CALLS_PER_DAY?: string;
  GLOBAL_WRITER_TOKENS_PER_DAY?: string;

  /**
   * Sign-in allowlist (comma-separated, case-insensitive; verified Google emails only). In production
   * sign-in is refused (authError=signup_closed) unless at least one of these is set.
   */
  ALLOWED_EMAILS?: string;
  ALLOWED_EMAIL_DOMAINS?: string;
}

export const isProduction = (env: Env) => env.ENVIRONMENT === "production";
export const demoModeEnabled = (env: Env) => env.DEMO_MODE === "true" && !isProduction(env);
