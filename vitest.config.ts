import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

// Tests run in Node against a D1-compatible shim over node:sqlite (tests/helpers/d1.ts).
// Workers-only APIs (cloudflare:workers) are isolated behind thin wrappers that tests do not import.
export default defineConfig({
  resolve: {
    alias: {
      "@shared": fileURLToPath(new URL("./src/shared", import.meta.url)),
      "@worker": fileURLToPath(new URL("./src/worker", import.meta.url)),
      "@web": fileURLToPath(new URL("./src/web", import.meta.url)),
    },
  },
  test: {
    include: ["tests/**/*.test.ts", "src/**/*.test.ts"],
    environment: "node",
    testTimeout: 20000,
  },
});
