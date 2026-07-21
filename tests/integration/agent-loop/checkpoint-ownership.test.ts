import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { runPrompt } from "../../../src/core/agent-loop/run";
import { AgentManager } from "../../../src/core/agents/manager";
import { AgentStore } from "../../../src/core/agents/store";
import { loadSessionRecords, } from "../../../src/core/session/store";
import { fileCheckpointDiffStats } from "../../../src/core/checkpoints/file-history";
import { configureTestProviderEnv, createPromptRoot, restoreAgentLoopTestState, } from "./fixtures/agent-loop";

beforeEach(configureTestProviderEnv);
afterEach(restoreAgentLoopTestState);

describe("agent loop: checkpoint ownership", () => {
  test("attributes child file mutations to the parent user-turn checkpoint", async () => {
    const rootDir = await createPromptRoot();
    await mkdir(join(rootDir, "workspace"), { recursive: true });
    const manager = new AgentManager(new AgentStore(rootDir), async ({ invocation }) => {
      expect(invocation?.beforeMutation).toBeFunction();
      await invocation!.beforeMutation!(["workspace/child-output.md"]);
      await writeFile(join(rootDir, "workspace", "child-output.md"), "child output\n", "utf8");
      return { content: "wrote child output" };
    });
    let parentRequests = 0;
    globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      parentRequests += 1;
      if (parentRequests === 1) {
        return Response.json({
          id: "parent-child-write",
          choices: [{ message: {
            content: "Delegating write.",
            tool_calls: [{
              id: "call-child-write",
              type: "function",
              function: { name: "spawn_agent", arguments: JSON.stringify({ profile: "general", description: "Write child output", prompt: "Write the output.", mode: "foreground" }) },
            }],
          } }],
        });
      }
      expect(body.messages.some((message: any) => message.role === "tool")).toBe(true);
      return Response.json({ id: "parent-child-write-done", choices: [{ message: { content: "Child output integrated." } }] });
    }) as typeof fetch;

    const result = await runPrompt({ input: "delegate writer", rootDir, agentManager: manager });
    expect(result.kind).toBe("complete");
    if (result.kind !== "complete") return;
    const records = await loadSessionRecords(rootDir, result.sessionId);
    const user = records.find((record) => record.role === "user" && record.content === "delegate writer");
    expect(user).toBeDefined();
    const diff = await fileCheckpointDiffStats(rootDir, result.sessionId, user!.uuid);
    expect(diff?.filesChanged).toContain("workspace/child-output.md");
  });

});
