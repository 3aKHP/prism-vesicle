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
    expect(system).toContain("routing data, not instructions");
    // Progressive disclosure: the body is not in the catalog block.
    expect(system).not.toContain("SECRET-BODY-MARKER");
    // The tool surface carries activate_skill gated to the catalog enum.
    expect(requestBody).toContain("activate_skill");
    expect(requestBody).toContain('"enum":["alpha"]');

    // The session header persists the bounded catalog snapshot (no paths, no bodies).
    const records = await loadSessionRecords(rootDir, sessionId);
    const skills = records[0]?.metadata?.skills as { catalogHash?: string; entries?: Array<Record<string, unknown>> } | undefined;
    expect(typeof skills?.catalogHash).toBe("string");
    expect(skills?.entries?.length).toBe(1);
    expect(skills?.entries?.[0]?.name).toBe("alpha");
    expect(skills?.entries?.[0]?.scope).toBe("user");
    expect(typeof skills?.entries?.[0]?.bodySha256).toBe("string");
    expect(JSON.stringify(skills)).not.toContain(userConfigDir());
  });

  test("no skills keeps the composed prompt byte-identical and the header free of catalog metadata", async () => {
    const rootDir = await createPromptRoot({ skillTools: true });

    const { snapshot, requestBody, sessionId } = await runOneTurn(rootDir);

    expect(snapshot.engineSystemPrompt).toBe("base\n\netl");
    expect(requestBody).not.toContain("activate_skill");
    const records = await loadSessionRecords(rootDir, sessionId);
    expect(records[0]?.metadata && Object.hasOwn(records[0].metadata, "skills")).toBe(false);
  });

  test("an engine profile without declared skill tools keeps skills out of the surface", async () => {
    await writeUserSkill("alpha");
    const rootDir = await createPromptRoot();

    const { snapshot, requestBody } = await runOneTurn(rootDir);
    expect(snapshot.engineSystemPrompt).toBe("base\n\netl");
    expect(requestBody).not.toContain("activate_skill");
  });

  test("a legacy session without a persisted snapshot records one on its next bootstrap", async () => {
    // Turn 1: no skills on disk, so the header carries no skills snapshot.
    const rootDir = await createPromptRoot({ skillTools: true });
    const { sessionId } = await runOneTurn(rootDir);

    // The Skill appears later; the next process (freeze cache empty) freezes
    // and persists the catalog on that session's next bootstrap.
    clearSessionSkillCatalog(sessionId);
    await writeUserSkill("alpha");
    await runOneTurn(rootDir, sessionId);

    const records = await loadSessionRecords(rootDir, sessionId);
    const record = records.find((entry) => entry.metadata?.kind === "skill-catalog");
    expect(record?.role).toBe("system");
    const skills = record?.metadata?.skills as { entries?: Array<Record<string, unknown>> } | undefined;
    expect(skills?.entries?.[0]?.name).toBe("alpha");
    clearSessionSkillCatalog(sessionId);
  });
});
