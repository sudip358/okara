import type { Env } from "@worker/env";
import { createTestD1 } from "./d1";

/** A deterministic test key (32 zero-ish bytes). Never use outside tests. */
export const TEST_KEY_B64 = btoa(String.fromCharCode(...new Uint8Array(32).map((_, i) => i + 1)));

export function createTestEnv(overrides: Partial<Env> = {}): Env {
  return {
    DB: createTestD1(),
    ENVIRONMENT: "test",
    APP_ORIGIN: "http://localhost:5173",
    DEMO_MODE: "false",
    TOKEN_ENCRYPTION_KEY_V1: TEST_KEY_B64,
    SESSION_SECRET: "test-session-secret",
    GOOGLE_CLIENT_ID: "test-client-id.apps.googleusercontent.com",
    GOOGLE_CLIENT_SECRET: "test-client-secret",
    ...overrides,
  };
}
