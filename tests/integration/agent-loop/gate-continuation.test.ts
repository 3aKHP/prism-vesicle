import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { resolveGate, runPrompt } from "../../../src/core/agent-loop/run";
import type { AgentLoopEvent } from "../../../src/core/agent-loop/run";
import { configureTestProviderEnv, createPromptRoot, restoreAgentLoopTestState, } from "./fixtures/agent-loop";

beforeEach(configureTestProviderEnv);
afterEach(restoreAgentLoopTestState);

describe("agent loop: gate continuation", () => {
  test("surfaces request_confirmation as needs_user and persists the gate call", async () => {
    const rootDir = await createPromptRoot({ stopGates: ["blueprint-confirmation"] });

    globalThis.fetch = (async () => {
      return Response.json({
        id: "chatcmpl-gate",
        choices: [
          {
            finish_reason: "tool_calls",
            message: {
              content: "Here is the blueprint I propose.",
              tool_calls: [
                {
                  id: "call-gate-1",
                  type: "function",
                  function: {
                    name: "request_confirmation",
                    arguments: JSON.stringify({
                      gate: "blueprint-confirmation",
                      summary: "Target Concept: A\nArchetype: B",
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
      input: "draft a blueprint",
      rootDir,
      messages: [{ role: "user", content: "draft a blueprint" }],
    });

    expect(result.kind).toBe("needs_user");
    if (result.kind !== "needs_user") throw new Error("expected needs_user");
    expect(result.gate.gate).toBe("blueprint-confirmation");
    expect(result.gate.summary).toContain("Target Concept: A");
    expect(result.toolCallId).toBe("call-gate-1");
    expect(result.assistantContent).toBe("Here is the blueprint I propose.");

    const jsonl = await readFile(result.sessionPath, "utf8");
    const records = jsonl.trim().split("\n").map((line) => JSON.parse(line));
    expect(records.map((record) => record.role)).toEqual(["system", "user", "system", "assistant"]);
    expect(records[2]?.metadata?.kind).toBe("file-history-snapshot");
    expect(records[3].metadata.toolCalls[0].name).toBe("request_confirmation");
  });

  test("resolveGate confirm advances the loop and threads the decision to the model", async () => {
    const rootDir = await createPromptRoot({ stopGates: ["blueprint-confirmation"] });
    let callCount = 0;
    const seenBodies: Array<{ messages: Array<{ role: string; content: string }> }> = [];

    globalThis.fetch = (async (_input: unknown, init: RequestInit & { body?: unknown }) => {
      callCount += 1;
      seenBodies.push(JSON.parse(String(init?.body)));
      if (callCount === 1) {
        return Response.json({
          id: "chatcmpl-gate",
          choices: [
            {
              finish_reason: "tool_calls",
              message: {
                content: "Blueprint ready.",
                tool_calls: [
                  {
                    id: "call-gate-1",
                    type: "function",
                    function: {
                      name: "request_confirmation",
                      arguments: JSON.stringify({
                        gate: "blueprint-confirmation",
                        summary: "Concept: A",
                      }),
                    },
                  },
                ],
              },
            },
          ],
        });
      }
      return Response.json({
        id: "chatcmpl-advance",
        choices: [{ message: { content: "Advancing to Phase 1." } }],
      });
    }) as unknown as typeof fetch;

    const paused = await runPrompt({
      input: "draft a blueprint",
      rootDir,
      messages: [{ role: "user", content: "draft a blueprint" }],
    });
    if (paused.kind !== "needs_user") throw new Error("expected needs_user");
    const originalPausedLength = paused.messages.length;
    await writeFile(join(rootDir, "assets", "prompts", "engines", "etl.md"), "etl changed\n", "utf8");
    const continuationEvents: AgentLoopEvent[] = [];
    let pendingInputs = [{ content: "Before you continue, emphasize the conflict." }];
    let commandBoundaries = 0;

    const resumed = await resolveGate({
      engine: "etl",
      rootDir,
      sessionId: paused.sessionId,
      messages: paused.messages,
      toolCallId: paused.toolCallId,
      gate: paused.gate,
      resolution: { decision: "confirm" },
      onEvent: (event) => continuationEvents.push(event),
      runToolBoundaryCommands: async () => { commandBoundaries += 1; },
      takePendingUserInputs: () => {
        const current = pendingInputs;
        pendingInputs = [];
        return current;
      },
    });

    expect(resumed.kind).toBe("complete");
    if (resumed.kind !== "complete") throw new Error("expected complete");
    expect(resumed.response.content).toBe("Advancing to Phase 1.");
    expect(commandBoundaries).toBe(1);

    // The follow-up request the provider saw must include the tool result
    // for the gate call and the synthetic user turn carrying the decision.
    const finalMessages = seenBodies[1].messages;
    expect(finalMessages.some((m) => m.role === "tool" && m.content.includes("Confirmed"))).toBe(true);
    expect(finalMessages.some((m) => m.role === "user" && m.content.includes("[gate:blueprint-confirmation resolved as confirm]"))).toBe(true);
    const gateResultIndex = finalMessages.findIndex((m) => m.role === "tool" && m.content.includes("Confirmed"));
    const queuedInputIndex = finalMessages.findIndex((m) => m.role === "user" && m.content === "Before you continue, emphasize the conflict.");
    expect(queuedInputIndex).toBeGreaterThan(gateResultIndex);

    // CR S2/B2: resolveGate must not mutate the caller's message array, and
    // the complete result must carry the full threaded message list so the
    // TUI can build the next turn on a provider-valid view.
    expect(paused.messages.length).toBe(originalPausedLength);
    if (resumed.kind !== "complete") throw new Error("expected complete");
    expect(resumed.messages.length).toBeGreaterThan(paused.messages.length);
    // The threaded list must pair the gate tool call with its result.
    const resumedToolMessages = resumed.messages.filter((m) => m.role === "tool");
    expect(resumedToolMessages.some((m) => m.toolCallId === paused.toolCallId)).toBe(true);
    expect(continuationEvents).toContainEqual(expect.objectContaining({
      type: "asset_drift",
      fingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
      changedPaths: ["assets/prompts/engines/etl.md"],
    }));
  });

  test("resolveGate reject threads feedback into the follow-up turn", async () => {
    const rootDir = await createPromptRoot({ stopGates: ["blueprint-confirmation"] });
    let callCount = 0;
    const seenBodies: Array<{ messages: Array<{ role: string; content: string }> }> = [];

    globalThis.fetch = (async (_input: unknown, init: RequestInit & { body?: unknown }) => {
      callCount += 1;
      seenBodies.push(JSON.parse(String(init?.body)));
      if (callCount === 1) {
        return Response.json({
          id: "chatcmpl-gate",
          choices: [
            {
              finish_reason: "tool_calls",
              message: {
                content: "Blueprint ready.",
                tool_calls: [
                  {
                    id: "call-gate-1",
                    type: "function",
                    function: {
                      name: "request_confirmation",
                      arguments: JSON.stringify({
                        gate: "blueprint-confirmation",
                        summary: "Concept: A",
                      }),
                    },
                  },
                ],
              },
            },
          ],
        });
      }
      return Response.json({
        id: "chatcmpl-redo",
        choices: [{ message: { content: "Reworking the blueprint." } }],
      });
    }) as unknown as typeof fetch;

    const paused = await runPrompt({
      input: "draft a blueprint",
      rootDir,
      messages: [{ role: "user", content: "draft a blueprint" }],
    });
    if (paused.kind !== "needs_user") throw new Error("expected needs_user");

    const resumed = await resolveGate({
      engine: "etl",
      rootDir,
      sessionId: paused.sessionId,
      messages: paused.messages,
      toolCallId: paused.toolCallId,
      gate: paused.gate,
      resolution: { decision: "reject", feedback: "change archetype to trickster" },
    });

    expect(resumed.kind).toBe("complete");
    const finalMessages = seenBodies[1].messages;
    expect(finalMessages.some((m) => m.role === "user" && m.content.includes("change archetype to trickster"))).toBe(true);
  });

  test("a gate the engine did not declare is refused, not paused", async () => {
    const rootDir = await createPromptRoot({ stopGates: [] });
    let callCount = 0;

    globalThis.fetch = (async () => {
      callCount += 1;
      if (callCount === 1) {
        return Response.json({
          id: "chatcmpl-bad-gate",
          choices: [
            {
              finish_reason: "tool_calls",
              message: {
                content: "",
                tool_calls: [
                  {
                    id: "call-bad",
                    type: "function",
                    function: {
                      name: "request_confirmation",
                      arguments: JSON.stringify({
                        gate: "blueprint-confirmation",
                        summary: "Concept: A",
                      }),
                    },
                  },
                ],
              },
            },
          ],
        });
      }
      // Engine profile declares no stopGates, so request_confirmation is
      // never even attached to the request. The mock above is defensive;
      // the loop refuses the undeclared gate and the model's next turn
      // is the final response below.
      return Response.json({
        id: "chatcmpl-after-refuse",
        choices: [{ message: { content: "Understood, no gate available." } }],
      });
    }) as unknown as typeof fetch;

    const result = await runPrompt({
      input: "try to gate",
      rootDir,
      messages: [{ role: "user", content: "try to gate" }],
    });

    // The engine declares no stopGates, so the gate tool is never offered.
    // The model still calls request_confirmation; the partition loop routes
    // it to gateCalls regardless, and the undeclared-gate refusal branch
    // writes a "gate not declared" tool result (anyFailed=true). The
    // no-progress breaker does not fire for a single failure, so the second
    // provider call returns the final assistant message.
    expect(result.kind).toBe("complete");
  });
});
