import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { resolveGate, runPrompt } from "../src/core/agent-loop/run";

const originalFetch = globalThis.fetch;
const originalEnv = { ...process.env };

describe("agent loop sessions", () => {
  beforeEach(() => {
    process.env.VESICLE_PROVIDER = "openai-chat-compatible";
    process.env.VESICLE_BASE_URL = "https://provider.test/v1";
    process.env.VESICLE_MODEL = "test-model";
    process.env.VESICLE_API_KEY = "test-key";
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    process.env = { ...originalEnv };
  });

  test("reuses one session and sends prior turns to the provider", async () => {
    const rootDir = await createPromptRoot();
    const requestBodies: Array<{ messages: Array<{ role: string; content: string }> }> = [];

    globalThis.fetch = (async (_input: unknown, init: RequestInit & { body?: unknown }) => {
      requestBodies.push(JSON.parse(String(init?.body)));

      return Response.json({
        id: `chatcmpl-${requestBodies.length}`,
        choices: [
          {
            message: {
              content: `reply ${requestBodies.length}`,
            },
          },
        ],
      });
    }) as unknown as typeof fetch;

    const firstMessages = [{ role: "user" as const, content: "first" }];
    const first = await runPrompt({
      input: "first",
      rootDir,
      messages: firstMessages,
    });
    if (first.kind !== "complete") throw new Error("expected complete");
    const firstReply = first.response.content;

    const secondMessages = [
      ...firstMessages,
      { role: "assistant" as const, content: firstReply },
      { role: "user" as const, content: "second" },
    ];
    const second = await runPrompt({
      input: "second",
      rootDir,
      sessionId: first.sessionId,
      messages: secondMessages,
    });
    if (second.kind !== "complete") throw new Error("expected complete");

    expect(second.sessionId).toBe(first.sessionId);
    expect(requestBodies[1].messages.map((message) => message.content)).toEqual([
      "base\n\netl",
      "first",
      "reply 1",
      "second",
    ]);

    const jsonl = await readFile(first.sessionPath, "utf8");
    const records = jsonl.trim().split("\n").map((line) => JSON.parse(line));
    expect(records.map((record) => record.role)).toEqual([
      "system",
      "user",
      "assistant",
      "user",
      "assistant",
    ]);
  });

  test("executes model-requested write_file calls", async () => {
    const rootDir = await createPromptRoot();
    const requestBodies: Array<{ messages: Array<{ role: string; content: string }> }> = [];

    globalThis.fetch = (async (_input: unknown, init: RequestInit & { body?: unknown }) => {
      requestBodies.push(JSON.parse(String(init?.body)));

      if (requestBodies.length === 1) {
        return Response.json({
          id: "chatcmpl-tool",
          choices: [
            {
              finish_reason: "tool_calls",
              message: {
                content: "",
                tool_calls: [
                  {
                    id: "call-write",
                    type: "function",
                    function: {
                      name: "write_file",
                      arguments: JSON.stringify({
                        path: "workspace/tool-test.md",
                        content: "# Tool Test\n\nwritten",
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
        id: "chatcmpl-final",
        choices: [
          {
            finish_reason: "stop",
            message: {
              content: "File written.",
            },
          },
        ],
      });
    }) as unknown as typeof fetch;

    const result = await runPrompt({
      input: "write a file",
      rootDir,
      messages: [{ role: "user", content: "write a file" }],
    });
    if (result.kind !== "complete") throw new Error("expected complete");

    const written = await readFile(join(rootDir, "workspace", "tool-test.md"), "utf8");

    expect(result.response.content).toBe("File written.");
    expect(written).toBe("# Tool Test\n\nwritten");
    expect(requestBodies[1].messages.some((message) => message.role === "tool")).toBe(true);
  });

  test("does not run artifact validators on ordinary assistant prose", async () => {
    const rootDir = await createPromptRoot({ validators: ["character-card", "scenario-card"] });

    globalThis.fetch = (async () => Response.json({
      id: "chatcmpl-prose",
      choices: [{ message: { content: "Confirmed. Moving to Phase 1." } }],
    })) as unknown as typeof fetch;

    const result = await runPrompt({
      input: "continue",
      rootDir,
      messages: [{ role: "user", content: "continue" }],
    });

    if (result.kind !== "complete") throw new Error("expected complete");
    expect(result.validation).toBeUndefined();
  });
});

describe("agent loop gates", () => {
  beforeEach(() => {
    process.env.VESICLE_PROVIDER = "openai-chat-compatible";
    process.env.VESICLE_BASE_URL = "https://provider.test/v1";
    process.env.VESICLE_MODEL = "test-model";
    process.env.VESICLE_API_KEY = "test-key";
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    process.env = { ...originalEnv };
  });

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
    expect(records.map((record) => record.role)).toEqual(["system", "user", "assistant"]);
    expect(records[2].metadata.toolCalls[0].name).toBe("request_confirmation");
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

    const resumed = await resolveGate({
      engine: "etl",
      rootDir,
      sessionId: paused.sessionId,
      messages: paused.messages,
      toolCallId: paused.toolCallId,
      gate: paused.gate,
      resolution: { decision: "confirm" },
    });

    expect(resumed.kind).toBe("complete");
    if (resumed.kind !== "complete") throw new Error("expected complete");
    expect(resumed.response.content).toBe("Advancing to Phase 1.");

    // The follow-up request the provider saw must include the tool result
    // for the gate call and the synthetic user turn carrying the decision.
    const finalMessages = seenBodies[1].messages;
    expect(finalMessages.some((m) => m.role === "tool" && m.content.includes("Confirmed"))).toBe(true);
    expect(finalMessages.some((m) => m.role === "user" && m.content.includes("[gate:blueprint-confirmation resolved as confirm]"))).toBe(true);

    // CR S2/B2: resolveGate must not mutate the caller's message array, and
    // the complete result must carry the full threaded message list so the
    // TUI can build the next turn on a provider-valid view.
    expect(paused.messages.length).toBe(originalPausedLength);
    if (resumed.kind !== "complete") throw new Error("expected complete");
    expect(resumed.messages.length).toBeGreaterThan(paused.messages.length);
    // The threaded list must pair the gate tool call with its result.
    const resumedToolMessages = resumed.messages.filter((m) => m.role === "tool");
    expect(resumedToolMessages.some((m) => m.toolCallId === paused.toolCallId)).toBe(true);
  });

  test("resolveGate revise threads feedback into the follow-up turn", async () => {
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
      resolution: { decision: "revise", feedback: "change archetype to trickster" },
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

async function createPromptRoot(options: { stopGates?: string[]; validators?: string[] } = {}): Promise<string> {
  const rootDir = await mkdtemp(join(tmpdir(), "vesicle-agent-loop-"));
  const sharedDir = join(rootDir, "assets", "prompts", "shared");
  const engineDir = join(rootDir, "assets", "prompts", "engines");
  const enginesDir = join(rootDir, "assets", "engines");

  await mkdir(sharedDir, { recursive: true });
  await mkdir(engineDir, { recursive: true });
  await mkdir(enginesDir, { recursive: true });
  await mkdir(join(rootDir, "workspace"), { recursive: true });
  await writeFile(join(sharedDir, "vesicle-base.md"), "base\n", "utf8");
  await writeFile(join(engineDir, "etl.md"), "etl\n", "utf8");

  const stopGatesBlock = (options.stopGates ?? []).length > 0
    ? `stopGates:\n${(options.stopGates ?? []).map((g) => `  - ${g}`).join("\n")}\n`
    : "stopGates: []\n";

  const validatorsBlock = (options.validators ?? []).length > 0
    ? `validators:\n${(options.validators ?? []).map((name) => `  - ${name}`).join("\n")}`
    : "validators: []";

  const profileYaml = [
    "id: etl",
    "displayName: Test ETL",
    "protocolVersion: v9.0-state-space",
    "systemPrompt:",
    "  - assets/prompts/shared/vesicle-base.md",
    "  - assets/prompts/engines/etl.md",
    "defaultTools:",
    "  - config.load",
    "  - prompt.load",
    "  - session.write",
    "  - list_files",
    "  - read_file",
    "  - write_file",
    validatorsBlock,
    stopGatesBlock,
    "stateRoots:",
    "  - workspace",
    "",
  ].join("\n");
  await writeFile(join(enginesDir, "etl.profile.yaml"), profileYaml, "utf8");

  return rootDir;
}
