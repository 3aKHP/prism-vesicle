import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { runPrompt } from "../../../src/core/agent-loop/run";
import { configureTestProviderEnv, createPromptRoot, restoreAgentLoopTestState } from "./fixtures/agent-loop";

beforeEach(configureTestProviderEnv);
afterEach(restoreAgentLoopTestState);

const UPDATE_CALL = {
  id: "call-update",
  type: "function",
  function: {
    name: "update_instructions",
    arguments: JSON.stringify({ scope: "project", engine: "all", action: "write", content: "NEW-RULE-MARKER", summary: "add a rule" }),
  },
};

describe("update_instructions refreshes the active loop's system prompt", () => {
  test("the next provider round in the same turn sees the just-written instruction", async () => {
    const rootDir = await createPromptRoot();
    let round = 0;
    let round2Body = "";
    globalThis.fetch = (async (_input: unknown, init: RequestInit & { body?: unknown }) => {
      round += 1;
      if (typeof init.body === "string" && round === 2) round2Body = init.body;
      if (round === 1) {
        return Response.json({
          id: "round-1",
          choices: [{
            finish_reason: "tool_calls",
            message: { content: "adding a rule", tool_calls: [UPDATE_CALL] },
          }],
        });
      }
      return Response.json({ id: "round-2", choices: [{ message: { content: "done" } }] });
    }) as unknown as typeof fetch;

    const result = await runPrompt({
      input: "add a persistent rule then continue",
      rootDir,
      permission: { mode: "MOMENTUM" },
    });
    expect(result.kind).toBe("complete");
    // Round 2's provider request must carry the refreshed instruction content
    // (the active loop recomposed its system prompt after the update).
    expect(round2Body).toContain("NEW-RULE-MARKER");
  });
});
