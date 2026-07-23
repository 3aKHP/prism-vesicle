import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { runPrompt } from "../../../src/core/agent-loop/run";
import type { AgentLoopEvent } from "../../../src/core/agent-loop/types";
import { loadSessionRecords } from "../../../src/core/session/store";
import type { SideQuestionContextSnapshot } from "../../../src/core/side-question/types";
import { createPromptRoot, configureTestProviderEnv, restoreAgentLoopTestState } from "./fixtures/agent-loop";

beforeEach(configureTestProviderEnv);
afterEach(restoreAgentLoopTestState);

function userConfigDir(): string {
  return dirname(process.env.VESICLE_PROVIDERS_FILE!);
}

async function runOneTurn(rootDir: string, onEvent?: (event: AgentLoopEvent) => void): Promise<{ snapshot: SideQuestionContextSnapshot; requestBody: string; sessionId: string }> {
  const snapshots: SideQuestionContextSnapshot[] = [];
  let requestBody = "";
  globalThis.fetch = (async (_input: unknown, init: RequestInit & { body?: unknown }) => {
    if (typeof init.body === "string") requestBody = init.body;
    return Response.json({ id: "round-1", choices: [{ message: { content: "done" } }] });
  }) as unknown as typeof fetch;

  const result = await runPrompt({
    input: "hello",
    rootDir,
    permission: { mode: "MOMENTUM" },
    onProviderContextSnapshot: (snapshot) => snapshots.push(snapshot),
    ...(onEvent ? { onEvent } : {}),
  });
  expect(result.kind).toBe("complete");
  expect(snapshots.length).toBe(1);
  return { snapshot: snapshots[0]!, requestBody, sessionId: result.sessionId };
}

describe("persistent instructions reach the provider system authority", () => {
  test("user then project instruction blocks follow the engine prompt, in order", async () => {
    await writeFile(join(userConfigDir(), "VESICLE.md"), "USER-BODY-MARKER", "utf8");
    const rootDir = await createPromptRoot();
    await writeFile(join(rootDir, "VESICLE.md"), "PROJECT-BODY-MARKER", "utf8");

    const { snapshot, requestBody } = await runOneTurn(rootDir);

    // The composed string is the single system authority the provider receives.
    const system = snapshot.engineSystemPrompt;
    const engineIndex = system.indexOf("etl");
    const userIndex = system.indexOf("USER-BODY-MARKER");
    const projectIndex = system.indexOf("PROJECT-BODY-MARKER");
    expect(engineIndex).toBeGreaterThan(-1);
    expect(userIndex).toBeGreaterThan(engineIndex);
    expect(projectIndex).toBeGreaterThan(userIndex);
    // The wire request carries the same composed system content.
    expect(requestBody).toContain("USER-BODY-MARKER");
    expect(requestBody).toContain("PROJECT-BODY-MARKER");
  });

  test("an Engine-specific user target replaces the user general target", async () => {
    await writeFile(join(userConfigDir(), "VESICLE.md"), "USER-GENERAL", "utf8");
    await writeFile(join(userConfigDir(), "VESICLE.etl.md"), "USER-ETL-OVERRIDE", "utf8");
    const rootDir = await createPromptRoot();

    const { snapshot } = await runOneTurn(rootDir);
    expect(snapshot.engineSystemPrompt).toContain("USER-ETL-OVERRIDE");
    expect(snapshot.engineSystemPrompt).not.toContain("USER-GENERAL");
  });

  test("no instruction files leaves the engine prompt unchanged", async () => {
    const rootDir = await createPromptRoot();
    const { snapshot } = await runOneTurn(rootDir);
    expect(snapshot.engineSystemPrompt).toBe("base\n\netl");
  });

  test("a new session records the instruction resolution in the system record metadata", async () => {
    await writeFile(join(userConfigDir(), "VESICLE.md"), "USER-BODY", "utf8");
    const rootDir = await createPromptRoot();
    await writeFile(join(rootDir, "VESICLE.md"), "PROJECT-BODY", "utf8");

    const result = await runOneTurn(rootDir);
    const records = await loadSessionRecords(rootDir, result.sessionId);
    const systemRecord = records.find((record) => record.role === "system" && record.metadata?.engine === "etl");
    expect(systemRecord).toBeDefined();
    const instructions = systemRecord?.metadata?.instructions as { files: { logicalName: string; bytes: number }[] } | undefined;
    expect(instructions).toBeDefined();
    expect(instructions?.files.map((file) => file.logicalName)).toEqual(["VESICLE.md", "VESICLE.md"]);
  });

  test("an invalid instruction file surfaces an instruction_warning event", async () => {
    await writeFile(join(userConfigDir(), "VESICLE.md"), Buffer.from([0xff, 0xfe, 0x00]));
    const rootDir = await createPromptRoot();
    const events: AgentLoopEvent[] = [];
    await runOneTurn(rootDir, (event) => events.push(event));
    const warning = events.find((event): event is Extract<AgentLoopEvent, { type: "instruction_warning" }> => event.type === "instruction_warning");
    expect(warning).toBeDefined();
    expect(warning?.diagnostics.some((d) => d.kind === "invalid-utf8")).toBe(true);
  });
});
