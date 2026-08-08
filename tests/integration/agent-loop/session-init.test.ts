import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { runPrompt } from "../../../src/core/agent-loop/run";
import { bootstrapTurn } from "../../../src/core/agent-loop/turn-bootstrap";
import { initializeSessionIdentity } from "../../../src/core/agent-loop/session-init";
import { createSessionStore, loadSessionRecords, loadSessionSnapshot } from "../../../src/core/session/store";
import { activateSkillForSession, clearSessionActivations, clearSessionSkillCatalog } from "../../../src/core/skills";
import { harnessRuntime } from "../harness/fixtures/harness";
import { createPromptRoot, configureTestProviderEnv, restoreAgentLoopTestState } from "./fixtures/agent-loop";

beforeEach(configureTestProviderEnv);
afterEach(restoreAgentLoopTestState);

function userConfigDir(): string {
  return dirname(process.env.VESICLE_PROVIDERS_FILE!);
}

async function writeUserSkill(name: string): Promise<void> {
  const root = join(userConfigDir(), "skills", name);
  await mkdir(root, { recursive: true });
  await Bun.write(
    join(root, "SKILL.md"),
    `---\nname: ${name}\ndescription: ${name} routing description\n---\n\n# ${name}\n\nBody for ${name}.\n`,
  );
}

/** The host path the TUI now runs: full identity first, then the activation record. */
async function initThenActivate(
  rootDir: string,
  name: string,
  mode: "invoke" | "context-only" = "invoke",
): Promise<{ sessionId: string; recordUuid: string | undefined }> {
  const identity = await initializeSessionIdentity({ rootDir, permission: { mode: "MOMENTUM" } });
  const activation = await activateSkillForSession(rootDir, process.env, identity.sessionId, name, {
    profile: { id: "etl" },
    mode,
  });
  return { sessionId: identity.sessionId, recordUuid: activation.recordUuid };
}

function mockProviderFetch(): void {
  globalThis.fetch = (async () => {
    return Response.json({ id: "round-1", choices: [{ message: { content: "done" } }] });
  }) as unknown as typeof fetch;
}

describe("initializeSessionIdentity (issue #131)", () => {
  test("fresh session: the identity header precedes the activation record", async () => {
    await writeUserSkill("alpha");
    const rootDir = await createPromptRoot({ skillTools: true });

    const { sessionId } = await initThenActivate(rootDir, "alpha");

    const records = await loadSessionRecords(rootDir, sessionId);
    // First durable record is the system header, not the activation.
    expect(records[0]?.role).toBe("system");
    const harness = records[0]?.metadata?.harness as Record<string, unknown> | undefined;
    expect(harness).toBeDefined();
    for (const key of ["packId", "packVersion", "sourceCommit", "manifestSha256", "adapterId", "adapterVersion", "adapterHash"]) {
      expect(typeof harness?.[key]).toBe("string");
    }
    const skills = records[0]?.metadata?.skills as { entries?: Array<{ name: string }> } | undefined;
    expect(skills?.entries?.map((entry) => entry.name).sort()).toEqual(["alpha", "novel-outline-v3", "skillify", "vesicle-docs"]);

    // The activation is the second record and chains directly off the header.
    expect(records[1]?.metadata?.kind).toBe("skill-activation");
    expect(records[1]?.metadata?.name).toBe("alpha");
    expect(records[1]?.parentUuid).toBe(records[0]?.uuid);

    // The snapshot loads with a recorded Harness identity (the value the guard checks).
    const snapshot = await loadSessionSnapshot(rootDir, sessionId);
    expect(snapshot.harness).toBeDefined();
    expect(snapshot.skillCatalogSnapshot).toBeDefined();
    clearSessionActivations(sessionId);
    clearSessionSkillCatalog(sessionId);
  });

  test("bootstrapTurn accepts a session whose identity was initialized before activation", async () => {
    const rootDir = await createPromptRoot({ skillTools: true });
    const { sessionId } = await initThenActivate(rootDir, "vesicle-docs");

    // Before the fix this exact call threw "Session Harness identity does not match...".
    await expect(
      bootstrapTurn({ input: "hello", rootDir, sessionId, permission: { mode: "MOMENTUM" } }),
    ).resolves.toBeDefined();
    clearSessionActivations(sessionId);
    clearSessionSkillCatalog(sessionId);
  });

  test("records the exact Harness identity passed to initialization", async () => {
    const rootDir = await createPromptRoot({ skillTools: true });
    const harness = harnessRuntime();

    const identity = await initializeSessionIdentity({ rootDir, permission: { mode: "MOMENTUM" }, harness });
    await activateSkillForSession(rootDir, process.env, identity.sessionId, "vesicle-docs", { profile: { id: "etl" } });

    const records = await loadSessionRecords(rootDir, identity.sessionId);
    expect(records[0]?.metadata?.harness).toEqual(harness.identity);

    // The same identity satisfies the guard on the next turn.
    await expect(
      bootstrapTurn({ input: "hello", rootDir, sessionId: identity.sessionId, permission: { mode: "MOMENTUM" }, harness }),
    ).resolves.toBeDefined();
    clearSessionActivations(identity.sessionId);
    clearSessionSkillCatalog(identity.sessionId);
  });

  test("a full turn completes after /skill-style initialization", async () => {
    const rootDir = await createPromptRoot({ skillTools: true });
    mockProviderFetch();
    const { sessionId } = await initThenActivate(rootDir, "vesicle-docs");

    const result = await runPrompt({ input: "hello", rootDir, sessionId, permission: { mode: "MOMENTUM" } });
    expect(result.kind).toBe("complete");

    const records = await loadSessionRecords(rootDir, sessionId);
    const roles = records.map((record) => `${record.role}:${record.metadata?.kind ?? ""}`);
    expect(roles[0]).toBe("system:");
    expect(roles[1]).toBe("user:skill-activation");
    expect(roles[2]).toBe("user:");
    expect(records.some((record) => record.role === "assistant")).toBe(true);
    clearSessionActivations(sessionId);
    clearSessionSkillCatalog(sessionId);
  });

  test("--context-only: a later normal turn chains after the activation", async () => {
    const rootDir = await createPromptRoot({ skillTools: true });
    mockProviderFetch();
    const { sessionId, recordUuid } = await initThenActivate(rootDir, "vesicle-docs", "context-only");
    expect(recordUuid).toBeDefined();

    const result = await runPrompt({ input: "hello", rootDir, sessionId, permission: { mode: "MOMENTUM" } });
    expect(result.kind).toBe("complete");

    const records = await loadSessionRecords(rootDir, sessionId);
    const activation = records.find((record) => record.metadata?.kind === "skill-activation");
    const userPrompt = records.find((record) => record.role === "user" && record.metadata?.kind !== "skill-activation");
    expect(activation?.uuid).toBe(recordUuid);
    expect(userPrompt?.parentUuid).toBe(recordUuid);
    clearSessionActivations(sessionId);
    clearSessionSkillCatalog(sessionId);
  });

  test("fail-closed: a headerless session is still rejected", async () => {
    const rootDir = await createPromptRoot({ skillTools: true });
    const sessionId = randomUUID();
    const store = await createSessionStore(rootDir, sessionId);
    await store.append({ role: "user", content: "orphan first record" });

    await expect(
      bootstrapTurn({ input: "hello", rootDir, sessionId, permission: { mode: "MOMENTUM" } }),
    ).rejects.toThrow("Session Harness identity does not match");
  });

  test("fail-closed: activation-first ordering (the old bug) is still rejected", async () => {
    const rootDir = await createPromptRoot({ skillTools: true });
    const sessionId = randomUUID();
    // Old TUI ordering: activation appended as the first record, no identity header.
    await activateSkillForSession(rootDir, process.env, sessionId, "vesicle-docs", { profile: { id: "etl" } });

    await expect(
      bootstrapTurn({ input: "hello", rootDir, sessionId, permission: { mode: "MOMENTUM" } }),
    ).rejects.toThrow("Session Harness identity does not match");
    clearSessionActivations(sessionId);
    clearSessionSkillCatalog(sessionId);
  });
});
