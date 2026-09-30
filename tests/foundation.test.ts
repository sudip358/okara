import { describe, expect, it } from "vitest";
import { createTestEnv } from "./helpers/env";
import { seedProject, seedUser } from "./helpers/fixtures";
import { requireProject } from "@worker/platform/access";
import { decryptSecret, encryptSecret } from "@worker/lib/crypto";
import { tierFor } from "@worker/runs/policy";

describe("foundation", () => {
  it("applies migrations and enforces cross-tenant project access", async () => {
    const env = createTestEnv();
    const a = await seedUser(env);
    const b = await seedUser(env);
    const projectA = await seedProject(env, a.workspaceId);
    await expect(requireProject(a.db, a.userId, projectA)).resolves.toMatchObject({ id: projectA });
    await expect(requireProject(b.db, b.userId, projectA)).rejects.toMatchObject({ status: 404 });
  });

  it("encrypts with a versioned envelope, unique IVs, and AAD binding", async () => {
    const env = createTestEnv();
    const e1 = await encryptSecret(env, "refresh-token", "aad-1");
    const e2 = await encryptSecret(env, "refresh-token", "aad-1");
    expect(e1).toMatch(/^v1\./);
    expect(e1).not.toEqual(e2);
    expect(await decryptSecret(env, e1, "aad-1")).toBe("refresh-token");
    await expect(decryptSecret(env, e1, "aad-2")).rejects.toBeTruthy();
  });

  it("tiers Noul by probability bands, never by a confidence field", () => {
    expect(tierFor("x", { type: "noul", noul: 0.95 })).toBe("act");
    expect(tierFor("x", { type: "noul", noul: 0.5 })).toBe("flag");
    expect(tierFor("x", { type: "choice", choice: "a", confidence: 0.3, probabilities: { a: 0.3 } })).toBe("drop");
    expect(tierFor("x", undefined)).toBe("drop");
  });
});
