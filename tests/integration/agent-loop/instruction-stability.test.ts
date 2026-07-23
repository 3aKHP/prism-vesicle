import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { resolveUserQuestion, runPrompt } from "../../../src/core/agent-loop/run";
import { clearFrozenInstructionBlocks } from "../../../src/core/agent-loop/instruction-context";
import { configureTestProviderEnv, createPromptRoot, restoreAgentLoopTestState } from "./fixtures/agent-loop";

beforeEach(configureTestProviderEnv);
afterEach(restoreAgentLoopTestState);

function userConfigDir(): string {
  return dirname(process.env.VESICLE_PROVIDERS_FILE!);
}

const QUESTION_ARGS = JSON.stringify({
  header: "Scope",
  question: "Which scope?",
  options: [
    { label: "Narrow", description: "Minimum change." },
    { label: "Broad", description: "Adjacent cleanup." },
  ],
});

// Round 1 returns ask_user_question (the loop pauses); round 2 returns prose.
// The round-2 request body is captured so the instruction text the resumed
// continuation sent to the provider can be inspected.
function stubPausingProvider(): { round2Body: () => string } {
  let callCount = 0;
  let round2Body = "";
  globalThis.fetch = (async (_input: unknown, init: RequestInit & { body?: unknown }) => {
    callCount += 1;
    if (typeof init.body === "string" && callCount === 2) round2Body = init.body;
    if (callCount === 1) {
      return Response.json({
        id: "round-1",
        choices: [{
          finish_reason: "tool_calls",
          message: {
            content: "I need one choice.",
            tool_calls: [{ id: "call-q", type: "function", function: { name: "ask_user_question", arguments: QUESTION_ARGS } }],
          },
        }],
      });
    }
    return Response.json({ id: "round-2", choices: [{ message: { content: "done" } }] });
  }) as unknown as typeof fetch;
  return { round2Body: () => round2Body };
}

async function resume(paused: Awaited<ReturnType<typeof runPrompt>>, rootDir: string): Promise<void> {
  if (paused.kind !== "needs_user_question") throw new Error(`expected needs_user_question, got ${paused.kind}`);
  const resumed = await resolveUserQuestion({
    engine: "etl",
    rootDir,
    sessionId: paused.sessionId,
    messages: paused.messages,
    toolCallId: paused.toolCallId,
    question: paused.question,
    answer: { selectedIndex: 0, label: "Narrow", description: "Minimum change." },
  });
  expect(resumed.kind).toBe("complete");
}

describe("persistent instructions are frozen within a turn", () => {
  test("an in-process continuation reuses the turn-start instruction set, not a mid-pause edit", async () => {
    const instructionFile = join(userConfigDir(), "VESICLE.md");
    await writeFile(instructionFile, "ORIGINAL-RULE", "utf8");
    const rootDir = await createPromptRoot();
    const provider = stubPausingProvider();

    const paused = await runPrompt({ input: "continue", rootDir, messages: [{ role: "user", content: "continue" }] });
    // The user edits the instruction file during the pause. The resumed
    // continuation must stay on the turn-start instruction set.
    await writeFile(instructionFile, "EDITED-RULE", "utf8");
    await resume(paused, rootDir);

    expect(provider.round2Body()).toContain("ORIGINAL-RULE");
    expect(provider.round2Body()).not.toContain("EDITED-RULE");
  });

  test("losing the frozen snapshot (process restart) makes the continuation re-read disk", async () => {
    const instructionFile = join(userConfigDir(), "VESICLE.md");
    await writeFile(instructionFile, "ORIGINAL-RULE", "utf8");
    const rootDir = await createPromptRoot();
    const provider = stubPausingProvider();

    const paused = await runPrompt({ input: "continue", rootDir, messages: [{ role: "user", content: "continue" }] });
    await writeFile(instructionFile, "EDITED-RULE", "utf8");
    // Simulate a Vesicle restart: the in-process frozen snapshot is gone, so
    // the resumed continuation is a resume boundary that re-reads current disk.
    if (paused.kind === "needs_user_question") clearFrozenInstructionBlocks(paused.sessionId);
    await resume(paused, rootDir);

    expect(provider.round2Body()).toContain("EDITED-RULE");
    expect(provider.round2Body()).not.toContain("ORIGINAL-RULE");
  });
});
