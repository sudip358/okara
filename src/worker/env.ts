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
  SESSION_SECRET?: string;

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

  /** Global daily spend cap across all projects, in USD micros. */
  GLOBAL_USD_MICROS_PER_DAY?: string;
}

export const isProduction = (env: Env) => env.ENVIRONMENT === "production";
export const demoModeEnabled = (env: Env) => env.DEMO_MODE === "true" && !isProduction(env);
