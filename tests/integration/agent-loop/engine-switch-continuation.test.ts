import { readFile, } from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { resolveEngineSwitch, runPrompt } from "../../../src/core/agent-loop/run";
import { readFrozenInstructionBlocks } from "../../../src/core/instructions/instruction-context";
import { configureTestProviderEnv, createPromptRoot, restoreAgentLoopTestState, } from "./fixtures/agent-loop";

beforeEach(configureTestProviderEnv);
afterEach(restoreAgentLoopTestState);

describe("agent loop: engine switch continuation", () => {
  test("surfaces request_engine_switch as a user-confirmed handoff", async () => {
    const rootDir = await createPromptRoot();

    globalThis.fetch = (async () => {
      return Response.json({
        id: "chatcmpl-engine-switch",
        choices: [
          {
            finish_reason: "tool_calls",
            message: {
              content: "Runtime should handle the next step.",
              tool_calls: [
                {
                  id: "call-engine-switch",
                  type: "function",
                  function: {
                    name: "request_engine_switch",
                    arguments: JSON.stringify({
                      targetEngine: "runtime",
                      reason: "The cards are ready for turn simulation.",
                      handoffSummary: "Use workspace/a.md and workspace/b.md.",
                      recommendedNextAction: "Open the runtime log.",
                    }),
                  },
                },
              ],
            },
          },
        ],
      });
    }) as unknown as typeof fetch;

    const result = await runPrompt({
      input: "continue workflow",
      rootDir,
      messages: [{ role: "user", content: "continue workflow" }],
    });

    expect(result.kind).toBe("needs_engine_switch");
    if (result.kind !== "needs_engine_switch") throw new Error("expected needs_engine_switch");
    expect(result.request.targetEngine).toBe("runtime");
    expect(result.toolCallId).toBe("call-engine-switch");

    const jsonl = await readFile(result.sessionPath, "utf8");
    const records = jsonl.trim().split("\n").map((line) => JSON.parse(line));
    expect(records.map((record) => record.role)).toEqual(["system", "user", "system", "assistant"]);
    expect(records[2]?.metadata?.kind).toBe("file-history-snapshot");
    expect(records[3].metadata.toolCalls[0].name).toBe("request_engine_switch");
  });

  test("resolveEngineSwitch confirms without making another provider request", async () => {
    const rootDir = await createPromptRoot();
    let callCount = 0;

    globalThis.fetch = (async () => {
      callCount += 1;
      return Response.json({
        id: "chatcmpl-engine-switch",
        choices: [
          {
            finish_reason: "tool_calls",
            message: {
              content: "Runtime should handle this.",
              tool_calls: [
                {
                  id: "call-engine-switch",
                  type: "function",
                  function: {
                    name: "request_engine_switch",
                    arguments: JSON.stringify({
                      targetEngine: "runtime",
                      reason: "Turn simulation is next.",
                      handoffSummary: "Character and scenario cards are available.",
                    }),
                  },
                },
              ],
            },
          },
        ],
      });
    }) as unknown as typeof fetch;

    const paused = await runPrompt({
      input: "continue workflow",
      rootDir,
      messages: [{ role: "user", content: "continue workflow" }],
    });
    if (paused.kind !== "needs_engine_switch") throw new Error("expected needs_engine_switch");
    expect(readFrozenInstructionBlocks(paused.sessionId)).toBeDefined();

    const resolved = await resolveEngineSwitch({
      engine: "etl",
      rootDir,
      sessionId: paused.sessionId,
      messages: paused.messages,
      toolCallId: paused.toolCallId,
      request: paused.request,
      resolution: { decision: "confirm" },
    });

    expect(callCount).toBe(1);
    expect(resolved.kind).toBe("engine_switched");
    if (resolved.kind !== "engine_switched") throw new Error("expected confirmed engine switch");
    expect(resolved.engine).toBe("runtime");
    expect(resolved.messages.at(-2)?.role).toBe("tool");
    expect(resolved.messages.at(-2)?.content).toContain("Engine switch confirmed");
    expect(resolved.messages.at(-1)).toMatchObject({ role: "user" });
    expect(resolved.messages.at(-1)?.content).toContain("[engine_handoff]");
    expect(resolved.messages.at(-1)?.content).toContain("Character and scenario cards are available.");
    expect(readFrozenInstructionBlocks(paused.sessionId)).toBeUndefined();

    const jsonl = await readFile(resolved.sessionPath, "utf8");
    const records = jsonl.trim().split("\n").map((line) => JSON.parse(line));
    expect(records.at(-3).metadata.name).toBe("request_engine_switch");
    expect(records.at(-3).metadata.transition).toMatchObject({
      source: "model_request",
      decision: "confirmed",
      fromEngine: "etl",
      toEngine: "runtime",
      contextPolicy: "preserve_full",
    });
    expect(records.at(-2).metadata).toMatchObject({ kind: "engine-switch", engine: "runtime" });
    expect(records.at(-2).metadata.transition).toMatchObject({ source: "model_request", decision: "confirmed" });
    expect(records.at(-1).role).toBe("user");
    expect(records.at(-1).content).toContain("[engine_handoff]");
    expect(records.at(-1).metadata).toMatchObject({ kind: "engine-handoff", engine: "runtime" });
  });

  test("resolveEngineSwitch can record a summary context policy", async () => {
    const rootDir = await createPromptRoot();

    globalThis.fetch = (async () => Response.json({
      id: "chatcmpl-engine-switch-summary",
      choices: [
        {
          finish_reason: "tool_calls",
          message: {
            content: "Runtime should handle this.",
            tool_calls: [
              {
                id: "call-engine-switch-summary",
                type: "function",
                function: {
                  name: "request_engine_switch",
                  arguments: JSON.stringify({
                    targetEngine: "runtime",
                    reason: "Turn simulation is next.",
                    handoffSummary: "Cards are ready.",
                  }),
                },
              },
            ],
          },
        },
      ],
    })) as unknown as typeof fetch;

    const paused = await runPrompt({
      input: "continue workflow",
      rootDir,
      messages: [{ role: "user", content: "continue workflow" }],
    });
    if (paused.kind !== "needs_engine_switch") throw new Error("expected needs_engine_switch");

    const resolved = await resolveEngineSwitch({
      engine: "etl",
      rootDir,
      sessionId: paused.sessionId,
      messages: paused.messages,
      toolCallId: paused.toolCallId,
      request: paused.request,
      resolution: { decision: "confirm" },
      contextPolicy: "summary",
    });

    expect(resolved.kind).toBe("engine_switched");
    if (resolved.kind !== "engine_switched") throw new Error("expected confirmed engine switch");
    expect(resolved.messages.at(-1)?.content).toContain("Context Policy: summary");

    const jsonl = await readFile(resolved.sessionPath, "utf8");
    const records = jsonl.trim().split("\n").map((line) => JSON.parse(line));
    expect(records.at(-3).metadata.transition).toMatchObject({
      source: "model_request",
      decision: "confirmed",
      contextPolicy: "summary",
    });
    expect(records.at(-1).content).toContain("Context Policy: summary");
  });

  test("resolveEngineSwitch reject returns the tool result to the current engine", async () => {
      const rootDir = await createPromptRoot();
      const requestBodies: Array<{ messages?: Array<{ role?: string; content?: string }> }> = [];

      globalThis.fetch = (async (...args: Parameters<typeof fetch>) => {
        const [, init] = args;
        const body = JSON.parse(String(init?.body ?? "{}")) as { messages?: Array<{ role?: string; content?: string }> };
        requestBodies.push(body);
        if (requestBodies.length === 1) {
          return Response.json({
            id: "chatcmpl-engine-switch-reject",
            choices: [{
              finish_reason: "tool_calls",
              message: {
                content: "Runtime should handle this.",
                tool_calls: [{
                  id: "call-engine-switch-reject",
                  type: "function",
                  function: {
                    name: "request_engine_switch",
                    arguments: JSON.stringify({
                      targetEngine: "runtime",
                      reason: "Turn simulation is next.",
                      handoffSummary: "Character and scenario cards are available.",
                    }),
                  },
                }],
              },
            }],
          });
        }
        return Response.json({
          id: "chatcmpl-engine-switch-reject-continued",
          choices: [{
            finish_reason: "stop",
            message: { content: "Stayed in ETL after rejection." },
          }],
        });
      }) as unknown as typeof fetch;

      const paused = await runPrompt({
        input: "continue workflow",
        rootDir,
        messages: [{ role: "user", content: "continue workflow" }],
      });
      if (paused.kind !== "needs_engine_switch") throw new Error("expected needs_engine_switch");

      const resolved = await resolveEngineSwitch({
        engine: "etl",
        rootDir,
        sessionId: paused.sessionId,
        messages: paused.messages,
        toolCallId: paused.toolCallId,
        request: paused.request,
        resolution: { decision: "reject", feedback: "Please revise before switching." },
      });

      expect(requestBodies).toHaveLength(2);
      expect(resolved.kind).toBe("complete");
      if (resolved.kind !== "complete") throw new Error("expected current-engine continuation");
      expect(resolved.response.content).toBe("Stayed in ETL after rejection.");
      const continuationMessages = requestBodies[1].messages ?? [];
      const toolResult = continuationMessages.find((message) => message.role === "tool");
      expect(toolResult?.content).toContain("Please revise before switching.");
      expect(toolResult?.content).toContain('"confirmed":false');
  });

  test("resolveEngineSwitch reject without feedback asks the current engine to clarify", async () => {
    const rootDir = await createPromptRoot();
    const requestBodies: Array<{ messages?: Array<{ role?: string; content?: string }> }> = [];

    globalThis.fetch = (async (...args: Parameters<typeof fetch>) => {
      const [, init] = args;
      const body = JSON.parse(String(init?.body ?? "{}")) as { messages?: Array<{ role?: string; content?: string }> };
      requestBodies.push(body);
      if (requestBodies.length === 1) {
        return Response.json({
          id: "chatcmpl-engine-switch-empty-reject",
          choices: [{
            finish_reason: "tool_calls",
            message: {
              content: "Runtime should handle this.",
              tool_calls: [{
                id: "call-engine-switch-empty-reject",
                type: "function",
                function: {
                  name: "request_engine_switch",
                  arguments: JSON.stringify({
                    targetEngine: "runtime",
                    reason: "Turn simulation is next.",
                    handoffSummary: "Character and scenario cards are available.",
                  }),
                },
              }],
            },
          }],
        });
      }
      return Response.json({
        id: "chatcmpl-engine-switch-empty-reject-continued",
        choices: [{ finish_reason: "stop", message: { content: "What should change?" } }],
      });
    }) as unknown as typeof fetch;

    const paused = await runPrompt({
      input: "continue workflow",
      rootDir,
      messages: [{ role: "user", content: "continue workflow" }],
    });
    if (paused.kind !== "needs_engine_switch") throw new Error("expected needs_engine_switch");

    const resolved = await resolveEngineSwitch({
      engine: "etl",
      rootDir,
      sessionId: paused.sessionId,
      messages: paused.messages,
      toolCallId: paused.toolCallId,
      request: paused.request,
      resolution: { decision: "reject" },
    });

    expect(resolved.kind).toBe("complete");
    const toolResult = requestBodies[1].messages?.find((message) => message.role === "tool");
    expect(toolResult?.content).toContain("rejected without specific feedback");
    expect(toolResult?.content).toContain('"confirmed":false');
  });

});
