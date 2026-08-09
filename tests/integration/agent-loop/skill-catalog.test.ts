import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { runPrompt } from "../../../src/core/agent-loop/run";
import { loadSessionRecords } from "../../../src/core/session/store";
import { clearSessionSkillCatalog } from "../../../src/core/skills";
import type { SideQuestionContextSnapshot } from "../../../src/core/side-question/types";
import { createPromptRoot, configureTestProviderEnv, restoreAgentLoopTestState } from "./fixtures/agent-loop";

beforeEach(configureTestProviderEnv);
afterEach(restoreAgentLoopTestState);

function userConfigDir(): string {
  return dirname(process.env.VESICLE_PROVIDERS_FILE!);
}

async function writeUserSkill(name: string, body?: string): Promise<void> {
  const root = join(userConfigDir(), "skills", name);
  await mkdir(root, { recursive: true });
  await Bun.write(
    join(root, "SKILL.md"),
    `---\nname: ${name}\ndescription: ${name} routing description\n---\n\n${body ?? `# ${name}\n\nSECRET-BODY-MARKER for ${name}.`}\n`,
  );
}

async function runOneTurn(rootDir: string, sessionId?: string): Promise<{ snapshot: SideQuestionContextSnapshot; requestBody: string; sessionId: string }> {
  const snapshots: SideQuestionContextSnapshot[] = [];
  let requestBody = "";
  globalThis.fetch = (async (_input: unknown, init: RequestInit & { body?: unknown }) => {
    if (typeof init.body === "string") requestBody = init.body;
    return Response.json({ id: "round-1", choices: [{ message: { content: "done" } }] });
  }) as unknown as typeof fetch;

  const result = await runPrompt({
    input: "hello",
    rootDir,
    ...(sessionId ? { sessionId } : {}),
    permission: { mode: "MOMENTUM" },
    onProviderContextSnapshot: (snapshot) => snapshots.push(snapshot),
  });
  expect(result.kind).toBe("complete");
  return { snapshot: snapshots[0]!, requestBody, sessionId: result.sessionId };
}

describe("skill catalog bootstrap wiring", () => {
  test("a user-scope skill enters the prompt catalog block and the activate_skill tool enum", async () => {
    await writeUserSkill("alpha");
    const rootDir = await createPromptRoot({ skillTools: true });

    const { snapshot, requestBody, sessionId } = await runOneTurn(rootDir);

    const system = snapshot.engineSystemPrompt;
    expect(system).toContain('<skill_catalog hash="');
    expect(system).toContain("- alpha [user]: alpha routing description");
    expect(system).toContain("- vesicle-docs [host]:");
    expect(system).toContain("routing data, not instructions");
    // Progressive disclosure: the body is not in the catalog block.
    expect(system).not.toContain("SECRET-BODY-MARKER");
    // The tool surface carries activate_skill gated to the catalog enum.
    expect(requestBody).toContain("activate_skill");
    expect(requestBody).toContain("alpha");
    expect(requestBody).toContain("vesicle-docs");

    // The session header persists the bounded catalog snapshot (no paths, no bodies).
    const records = await loadSessionRecords(rootDir, sessionId);
    const skills = records[0]?.metadata?.skills as { catalogHash?: string; entries?: Array<Record<string, unknown>> } | undefined;
    expect(typeof skills?.catalogHash).toBe("string");
    expect(skills?.entries?.length).toBe(5);
    const names = skills?.entries?.map((e) => e.name).sort();
    expect(names).toEqual(["alpha", "novel-outline-v3", "skillify", "update-config", "vesicle-docs"]);
    expect(JSON.stringify(skills)).not.toContain(userConfigDir());
  });

  test("host-bundled vesicle-docs is always discoverable and injects a catalog block", async () => {
    const rootDir = await createPromptRoot({ skillTools: true });

    const { snapshot, requestBody, sessionId } = await runOneTurn(rootDir);

    expect(snapshot.engineSystemPrompt).toContain('<skill_catalog hash="');
    expect(snapshot.engineSystemPrompt).toContain("- vesicle-docs [host]:");
    expect(requestBody).toContain("activate_skill");
    const records = await loadSessionRecords(rootDir, sessionId);
    const skills = records[0]?.metadata?.skills as { entries?: Array<Record<string, unknown>> } | undefined;
    expect(skills?.entries?.length).toBe(4);
    const hostNames = skills?.entries?.map((e) => e.name).sort();
    expect(hostNames).toEqual(["novel-outline-v3", "skillify", "update-config", "vesicle-docs"]);
    expect(skills?.entries?.every((e) => e.scope === "host")).toBe(true);
  });

  test("skill tools are host-injected regardless of profile defaultTools", async () => {
    await writeUserSkill("alpha");
    const rootDir = await createPromptRoot();

    const { snapshot, requestBody } = await runOneTurn(rootDir);
    // Skill tools are injected by the host layer for all non-Stage engines,
    // independent of the Harness profile's defaultTools.
    expect(snapshot.engineSystemPrompt).toContain('<skill_catalog hash="');
    expect(snapshot.engineSystemPrompt).toContain("- alpha [user]:");
    expect(requestBody).toContain("activate_skill");
  });

  test("the frozen session catalog does not pick up a new skill mid-session", async () => {
    const rootDir = await createPromptRoot({ skillTools: true });
    const { sessionId } = await runOneTurn(rootDir);

    // A new Skill appears after the catalog is frozen; the same session does not see it.
    await writeUserSkill("alpha");
    const { snapshot } = await runOneTurn(rootDir, sessionId);

    expect(snapshot.engineSystemPrompt).toContain("- vesicle-docs [host]:");
    expect(snapshot.engineSystemPrompt).not.toContain("- alpha [user]:");
    clearSessionSkillCatalog(sessionId);
  });
});
