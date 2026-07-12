import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { resolveEngineSwitch, resolveGate, resolveUserQuestion, runPrompt } from "../src/core/agent-loop/run";
import type { AgentLoopEvent } from "../src/core/agent-loop/run";
import { ingestImageBytes } from "../src/core/attachments/store";
import { AgentManager } from "../src/core/agents/manager";
import { AgentStore } from "../src/core/agents/store";
import { runChildAgent } from "../src/core/agents/child-runner";
import { AgentContinuationScheduler } from "../src/core/agents/scheduler";
import { createSessionStore, loadSessionRecords } from "../src/core/session/store";
import { fileCheckpointDiffStats } from "../src/core/checkpoints/file-history";

const originalFetch = globalThis.fetch;
const originalEnv = { ...process.env };
const providerConfigDirs: string[] = [];

describe("agent loop sessions", () => {
  beforeEach(async () => {
    await configureTestProviderEnv();
  });

  afterEach(async () => {
    globalThis.fetch = originalFetch;
    process.env = { ...originalEnv };
    await cleanupProviderConfigDirs();
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
    expect(first.messages.map((message) => message.role)).toEqual(["user", "assistant"]);
    expect(first.messages.at(-1)?.content).toBe(firstReply);

    const secondMessages = [
      ...first.messages,
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
      "system",
      "assistant",
      "user",
      "system",
      "assistant",
    ]);
    expect(records[0].metadata.assets).toMatchObject({
      sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      files: expect.arrayContaining([
        expect.objectContaining({ path: "assets/engines/etl.profile.yaml" }),
        expect.objectContaining({ path: "assets/prompts/shared/vesicle-base.md" }),
        expect.objectContaining({ path: "assets/prompts/engines/etl.md" }),
      ]),
    });
    expect(records.filter((record) => record.metadata?.kind === "file-history-snapshot")).toHaveLength(2);
  });

  test("materializes conversation images and persists only attachment references", async () => {
    await configureTestProviderEnv({ vision: true });
    const rootDir = await createPromptRoot();
    const image = await ingestImageBytes(rootDir, testPng(), { source: "clipboard", filename: "capture.png" });
    let requestBody: any;
    globalThis.fetch = (async (_input: unknown, init: RequestInit & { body?: unknown }) => {
      requestBody = JSON.parse(String(init?.body));
      return Response.json({ id: "chat-image", choices: [{ message: { content: "seen" } }] });
    }) as unknown as typeof fetch;

    const result = await runPrompt({
      input: "inspect [Image #1]",
      rootDir,
      images: [image],
      messages: [{ role: "user", content: "inspect [Image #1]", images: [image] }],
    });
    expect(result.kind).toBe("complete");
    expect(requestBody.messages[1].content).toContainEqual(expect.objectContaining({
      type: "image_url",
      image_url: expect.objectContaining({ url: expect.stringContaining("data:image/png;base64,") }),
    }));
    const records = (await readFile(result.sessionPath, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    expect(records[1].metadata.images[0].data).toBeUndefined();
  });

  test("passes view_image output back to vision models as image content", async () => {
    await configureTestProviderEnv({ vision: true });
    const rootDir = await createPromptRoot();
    await writeFile(join(rootDir, "source_materials", "reference.png"), testPng());
    const bodies: any[] = [];
    globalThis.fetch = (async (_input: unknown, init: RequestInit & { body?: unknown }) => {
      const body = JSON.parse(String(init?.body));
      bodies.push(body);
      if (bodies.length === 1) {
        return Response.json({
          id: "chat-view-1",
          choices: [{ message: {
            content: "",
            tool_calls: [{
              id: "call-view",
              type: "function",
              function: { name: "view_image", arguments: '{"path":"source_materials/reference.png"}' },
            }],
          } }],
        });
      }
      return Response.json({ id: "chat-view-2", choices: [{ message: { content: "seen" } }] });
    }) as unknown as typeof fetch;

    const result = await runPrompt({ input: "inspect the reference", rootDir });
    expect(result.kind).toBe("complete");
    const imageFollowUp = bodies[1].messages.find((message: any) =>
      message.role === "user" && Array.isArray(message.content));
    expect(imageFollowUp.content).toContainEqual(expect.objectContaining({ type: "image_url" }));
  });

  test("passes generation thinking tier to the provider request", async () => {
    const rootDir = await createPromptRoot();
    const requestBodies: Array<{ thinking?: unknown; reasoning_effort?: string }> = [];

    globalThis.fetch = (async (_input: unknown, init: RequestInit & { body?: unknown }) => {
      requestBodies.push(JSON.parse(String(init?.body)));

      return Response.json({
        id: "chatcmpl-thinking",
        choices: [{ message: { content: "reply" } }],
      });
    }) as unknown as typeof fetch;

    const result = await runPrompt({
      input: "think hard",
      rootDir,
      generation: { reasoningTier: "max" },
    });

    if (result.kind !== "complete") throw new Error("expected complete");
    expect(requestBodies[0]).toMatchObject({
      thinking: { type: "enabled" },
      reasoning_effort: "max",
    });
  });

  test("propagates host cancellation to the provider request", async () => {
    const rootDir = await createPromptRoot();
    const controller = new AbortController();
    let providerSignal: AbortSignal | undefined;
    let markFetchStarted: () => void = () => undefined;
    const fetchStarted = new Promise<void>((resolve) => { markFetchStarted = resolve; });
    globalThis.fetch = ((_input: unknown, init?: RequestInit) => {
      providerSignal = init?.signal ?? undefined;
      markFetchStarted();
      return new Promise<Response>((_resolve, reject) => {
        if (providerSignal?.aborted) {
          reject(new DOMException("Aborted", "AbortError"));
          return;
        }
        providerSignal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
      });
    }) as typeof fetch;

    const turn = runPrompt({ input: "cancel me", rootDir, signal: controller.signal });
    await fetchStarted;
    controller.abort("user-cancel");

    await expect(turn).rejects.toMatchObject({ name: "AbortError" });
    expect(providerSignal).toBe(controller.signal);
  });

  test("passes configured model generation defaults to the provider request", async () => {
    await cleanupProviderConfigDirs();
    await configureTestProviderEnv({
      models: [
        "      - id: test-model",
        "        generation:",
        "          temperature: 0.2",
        "          maxTokens: 1234",
      ],
    });
    const rootDir = await createPromptRoot();
    const requestBodies: Array<{ temperature?: number; max_tokens?: number }> = [];

    globalThis.fetch = (async (_input: unknown, init: RequestInit & { body?: unknown }) => {
      requestBodies.push(JSON.parse(String(init?.body)));

      return Response.json({
        id: "chatcmpl-generation-defaults",
        choices: [{ message: { content: "reply" } }],
      });
    }) as unknown as typeof fetch;

    const result = await runPrompt({
      input: "use configured defaults",
      rootDir,
    });

    if (result.kind !== "complete") throw new Error("expected complete");
    expect(requestBodies[0]).toMatchObject({
      temperature: 0.2,
      max_tokens: 1234,
    });
  });

  test("does not let undefined generation overrides erase configured defaults", async () => {
    await cleanupProviderConfigDirs();
    await configureTestProviderEnv({
      models: [
        "      - id: test-model",
        "        generation:",
        "          temperature: 0.2",
        "          maxTokens: 1234",
      ],
    });
    const rootDir = await createPromptRoot();
    const requestBodies: Array<{ temperature?: number; max_tokens?: number }> = [];

    globalThis.fetch = (async (_input: unknown, init: RequestInit & { body?: unknown }) => {
      requestBodies.push(JSON.parse(String(init?.body)));

      return Response.json({
        id: "chatcmpl-generation-defined",
        choices: [{ message: { content: "reply" } }],
      });
    }) as unknown as typeof fetch;

    const result = await runPrompt({
      input: "keep configured defaults",
      rootDir,
      generation: { temperature: undefined, maxTokens: undefined },
    });

    if (result.kind !== "complete") throw new Error("expected complete");
    expect(requestBodies[0]).toMatchObject({
      temperature: 0.2,
      max_tokens: 1234,
    });
  });

  test("emits streamed reasoning deltas from the provider", async () => {
    const rootDir = await createPromptRoot();
    const events: AgentLoopEvent[] = [];

    globalThis.fetch = (async () => {
      return new Response(rawSse([
        'data: {"id":"chatcmpl-reasoning","choices":[{"delta":{"reasoning_content":"considering context"}}]}',
        'data: {"id":"chatcmpl-reasoning","choices":[{"delta":{"content":"answer"},"finish_reason":"stop"}]}',
        "data: [DONE]",
      ]), {
        headers: { "content-type": "text/event-stream" },
      });
    }) as unknown as typeof fetch;

    const result = await runPrompt({
      input: "stream reasoning",
      rootDir,
      onEvent: (event) => events.push(event),
    });

    if (result.kind !== "complete") throw new Error("expected complete");
    expect(result.response.reasoningContent).toBe("considering context");
    expect(result.response.thinkingBlocks).toEqual([{ type: "reasoning", reasoningContent: "considering context" }]);
    expect(events).toContainEqual({ type: "assistant_reasoning_delta", delta: "considering context" });
    expect(events).toContainEqual({
      type: "assistant_response",
      content: "answer",
      reasoningContent: "considering context",
      thinkingBlocks: [{ type: "reasoning", reasoningContent: "considering context" }],
      toolCalls: [],
    });
  });

  test("executes model-requested write_file calls", async () => {
    const rootDir = await createPromptRoot();
    const requestBodies: Array<{ messages: Array<{ role: string; content: string; reasoning_content?: string }> }> = [];
    const events: AgentLoopEvent[] = [];

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
                reasoning_content: "Need to write the requested artifact before answering.",
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
      onEvent: (event) => events.push(event),
    });
    if (result.kind !== "complete") throw new Error("expected complete");

    const written = await readFile(join(rootDir, "workspace", "tool-test.md"), "utf8");
    const records = (await readFile(result.sessionPath, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    const toolRecord = records.find((record) => record.role === "tool");

    expect(result.response.content).toBe("File written.");
    expect(written).toBe("# Tool Test\n\nwritten");
    expect(requestBodies[1].messages.some((message) => message.role === "tool")).toBe(true);
    expect(requestBodies[1].messages.some((message) => (
      message.role === "assistant" &&
      message.reasoning_content === "Need to write the requested artifact before answering."
    ))).toBe(true);
    expect(toolRecord?.metadata.fileEvent).toMatchObject({
      kind: "file_operation",
      operation: "write",
      path: "workspace/tool-test.md",
      changed: true,
    });
    expect(events).toContainEqual(expect.objectContaining({
      type: "tool_result",
      name: "write_file",
      fileEvent: expect.objectContaining({
        operation: "write",
        path: "workspace/tool-test.md",
      }),
    }));
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

  test("launches multiple foreground SubAgents in parallel and resumes the same parent turn", async () => {
    const rootDir = await createPromptRoot();
    const childResolvers: Array<(response: Response) => void> = [];
    const childSystems: string[] = [];
    let parentRequests = 0;
    globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      const system = String(body.messages?.[0]?.content ?? "");
      if (system.includes("Explore Agent") || system.includes("Reviewer Agent")) {
        childSystems.push(system);
        return new Promise<Response>((resolve) => childResolvers.push(resolve));
      }
      parentRequests += 1;
      if (parentRequests === 1) {
        return Response.json({
          id: "parent-spawn",
          choices: [{ message: {
            content: "Delegating both checks.",
            tool_calls: [
              {
                id: "call-explore",
                type: "function",
                function: { name: "spawn_agent", arguments: JSON.stringify({ profile: "explore", description: "Explore sources", prompt: "Map the sources.", mode: "foreground" }) },
              },
              {
                id: "call-review",
                type: "function",
                function: { name: "spawn_agent", arguments: JSON.stringify({ profile: "reviewer", description: "Review evidence", prompt: "Review the evidence.", mode: "foreground" }) },
              },
            ],
          } }],
        });
      }
      expect(body.messages.filter((message: any) => message.role === "tool")).toHaveLength(2);
      return Response.json({ id: "parent-complete", choices: [{ message: { content: "Combined child results." } }] });
    }) as typeof fetch;

    const turn = runPrompt({ input: "delegate", rootDir });
    await eventually(() => expect(childResolvers).toHaveLength(2));
    expect(parentRequests).toBe(1);
    childResolvers[0]!(Response.json({ id: "child-a", choices: [{ message: { content: "source map" } }] }));
    childResolvers[1]!(Response.json({ id: "child-b", choices: [{ message: { content: "review" } }] }));
    const result = await turn;
    expect(result.kind).toBe("complete");
    if (result.kind !== "complete") return;
    expect(result.response.content).toBe("Combined child results.");
    expect(parentRequests).toBe(2);
    expect(childSystems).toHaveLength(2);
  });

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

  test("background SubAgent returns accepted without blocking the parent", async () => {
    const rootDir = await createPromptRoot();
    const store = new AgentStore(rootDir);
    const manager = new AgentManager(store, runChildAgent);
    let resolveChild: (response: Response) => void = () => undefined;
    let childStarted = false;
    let parentRequests = 0;
    globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      const system = String(body.messages?.[0]?.content ?? "");
      if (system.includes("Explore Agent")) {
        childStarted = true;
        return new Promise<Response>((resolve) => { resolveChild = resolve; });
      }
      parentRequests += 1;
      if (parentRequests === 1) {
        return Response.json({
          id: "parent-background",
          choices: [{ message: {
            content: "Starting background exploration.",
            tool_calls: [{
              id: "call-background",
              type: "function",
              function: { name: "spawn_agent", arguments: JSON.stringify({ profile: "explore", description: "Explore later", prompt: "Explore in background.", mode: "background" }) },
            }],
          } }],
        });
      }
      const tool = body.messages.find((message: any) => message.role === "tool");
      expect(tool.content).toContain("accepted");
      return Response.json({ id: "parent-free", choices: [{ message: { content: "Parent is free." } }] });
    }) as typeof fetch;

    const result = await runPrompt({ input: "start background", rootDir, agentManager: manager });
    expect(result.kind).toBe("complete");
    if (result.kind !== "complete") return;
    expect(result.response.content).toBe("Parent is free.");
    expect(manager.listActive(result.sessionId)).toHaveLength(1);
    await eventually(() => expect(childStarted).toBe(true));
    resolveChild(Response.json({ id: "child-later", choices: [{ message: { content: "late result" } }] }));
    await eventually(async () => expect(await store.listInbox(result.sessionId, "pending")).toHaveLength(1));
  });

  test("delivers background completion through an automatic parent continuation", async () => {
    const rootDir = await createPromptRoot();
    const store = new AgentStore(rootDir);
    const manager = new AgentManager(store, runChildAgent);
    let resolveChild: (response: Response) => void = () => undefined;
    let childStarted = false;
    let parentRequests = 0;
    globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      const system = String(body.messages?.[0]?.content ?? "");
      if (system.includes("Explore Agent")) {
        childStarted = true;
        return new Promise<Response>((resolve) => { resolveChild = resolve; });
      }
      parentRequests += 1;
      if (parentRequests === 1) {
        return Response.json({
          id: "parent-background-start",
          choices: [{ message: {
            content: "Delegating.",
            tool_calls: [{
              id: "call-auto-background",
              type: "function",
              function: { name: "spawn_agent", arguments: JSON.stringify({ profile: "explore", description: "Explore automatically", prompt: "Explore.", mode: "background" }) },
            }],
          } }],
        });
      }
      if (parentRequests === 2) return Response.json({ id: "parent-continues", choices: [{ message: { content: "Continuing while it runs." } }] });
      expect(body.messages.at(-1).content).toContain("<subagent-results>");
      return Response.json({ id: "parent-integrates", choices: [{ message: { content: "Integrated late evidence." } }] });
    }) as typeof fetch;

    const initial = await runPrompt({ input: "start", rootDir, agentManager: manager });
    expect(initial.kind).toBe("complete");
    if (initial.kind !== "complete") return;
    await eventually(() => expect(childStarted).toBe(true));
    resolveChild(Response.json({ id: "child-complete", choices: [{ message: { content: "late evidence" } }] }));
    await eventually(async () => expect(await store.listInbox(initial.sessionId, "pending")).toHaveLength(1));
    let integrated = "";
    const scheduler = new AgentContinuationScheduler(store, async (parentSessionId, _entries, packet) => {
      const continuation = await runPrompt({
        input: packet,
        rootDir,
        sessionId: parentSessionId,
        messages: [...initial.messages, { role: "user", content: packet }],
        agentManager: manager,
      });
      if (continuation.kind !== "complete") throw new Error("expected complete continuation");
      integrated = continuation.response.content;
    }, { debounceMs: 0 });
    await scheduler.notify(initial.sessionId);
    expect(integrated).toBe("Integrated late evidence.");
    expect(await store.listInbox(initial.sessionId, "acknowledged")).toHaveLength(1);
  });

  test("reuses a pre-persisted durable delivery input without appending it twice", async () => {
    const rootDir = await createPromptRoot();
    const session = await createSessionStore(rootDir);
    await session.append({ role: "system", content: "parent" });
    const delivery = await session.append({
      role: "user",
      content: "<subagent-results>done</subagent-results>",
      metadata: { kind: "subagent-results", inboxIds: ["inbox-1"] },
    });
    globalThis.fetch = (async () => Response.json({
      id: "delivery-retry",
      choices: [{ message: { content: "integrated" } }],
    })) as unknown as typeof fetch;

    const result = await runPrompt({
      input: "<subagent-results>done</subagent-results>",
      rootDir,
      sessionId: session.sessionId,
      messages: [{ role: "user", content: "<subagent-results>done</subagent-results>" }],
      prePersistedInputUuid: delivery.uuid,
    });
    expect(result.kind).toBe("complete");
    const records = (await readFile(session.sessionPath, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    expect(records.filter((record) => record.metadata?.kind === "subagent-results")).toHaveLength(1);
  });
});

describe("agent loop gates", () => {
  beforeEach(async () => {
    await configureTestProviderEnv();
  });

  afterEach(async () => {
    globalThis.fetch = originalFetch;
    process.env = { ...originalEnv };
    await cleanupProviderConfigDirs();
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

    const resumed = await resolveGate({
      engine: "etl",
      rootDir,
      sessionId: paused.sessionId,
      messages: paused.messages,
      toolCallId: paused.toolCallId,
      gate: paused.gate,
      resolution: { decision: "confirm" },
      onEvent: (event) => continuationEvents.push(event),
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

  test("surfaces ask_user_question as a user question pause", async () => {
    const rootDir = await createPromptRoot();

    globalThis.fetch = (async () => {
      return Response.json({
        id: "chatcmpl-question",
        choices: [
          {
            finish_reason: "tool_calls",
            message: {
              content: "I need one choice before continuing.",
              tool_calls: [
                {
                  id: "call-question",
                  type: "function",
                  function: {
                    name: "ask_user_question",
                    arguments: JSON.stringify({
                      header: "Scope",
                      question: "Which scope should I use?",
                      options: [
                        { label: "Narrow", description: "Only change the minimum needed." },
                        { label: "Broad", description: "Include adjacent cleanup." },
                      ],
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

    expect(result.kind).toBe("needs_user_question");
    if (result.kind !== "needs_user_question") throw new Error("expected needs_user_question");
    expect(result.question.header).toBe("Scope");
    expect(result.question.options.map((option) => option.label)).toEqual(["Narrow", "Broad", "Skip", "Answer freely"]);
    expect(result.question.options[2].kind).toBe("skip");
    expect(result.question.options[3].kind).toBe("freeform");
  });

  test("resolveUserQuestion continues the engine loop with the selected answer", async () => {
    const rootDir = await createPromptRoot();
    let callCount = 0;
    const seenBodies: Array<{ messages: Array<{ role: string; content: string }> }> = [];

    globalThis.fetch = (async (_input: unknown, init: RequestInit & { body?: unknown }) => {
      callCount += 1;
      seenBodies.push(JSON.parse(String(init?.body)));
      if (callCount === 1) {
        return Response.json({
          id: "chatcmpl-question",
          choices: [
            {
              finish_reason: "tool_calls",
              message: {
                content: "Pick a scope.",
                tool_calls: [
                  {
                    id: "call-question",
                    type: "function",
                    function: {
                      name: "ask_user_question",
                      arguments: JSON.stringify({
                        header: "Scope",
                        question: "Which scope should I use?",
                        options: [
                          { label: "Narrow", description: "Only change the minimum needed." },
                          { label: "Broad", description: "Include adjacent cleanup." },
                        ],
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
        id: "chatcmpl-answer",
        choices: [{ message: { content: "Continuing narrowly." } }],
      });
    }) as unknown as typeof fetch;

    const paused = await runPrompt({
      input: "continue workflow",
      rootDir,
      messages: [{ role: "user", content: "continue workflow" }],
    });
    if (paused.kind !== "needs_user_question") throw new Error("expected needs_user_question");

    const resumed = await resolveUserQuestion({
      engine: "etl",
      rootDir,
      sessionId: paused.sessionId,
      messages: paused.messages,
      toolCallId: paused.toolCallId,
      question: paused.question,
      answer: { selectedIndex: 0, label: "Narrow", description: "Only change the minimum needed." },
    });

    expect(resumed.kind).toBe("complete");
    if (resumed.kind !== "complete") throw new Error("expected complete");
    expect(resumed.response.content).toBe("Continuing narrowly.");
    expect(seenBodies[1].messages.some((m) => m.role === "tool" && m.content.includes("Narrow"))).toBe(true);
    expect(seenBodies[1].messages.some((m) => m.role === "user" && m.content.includes("[question:Scope answered]"))).toBe(true);
  });

  test("resolveUserQuestion threads free-form fallback answers", async () => {
    const rootDir = await createPromptRoot();
    let callCount = 0;
    const seenBodies: Array<{ messages: Array<{ role: string; content: string }> }> = [];

    globalThis.fetch = (async (_input: unknown, init: RequestInit & { body?: unknown }) => {
      callCount += 1;
      seenBodies.push(JSON.parse(String(init?.body)));
      if (callCount === 1) {
        return Response.json({
          id: "chatcmpl-question",
          choices: [
            {
              finish_reason: "tool_calls",
              message: {
                content: "Pick a scope.",
                tool_calls: [
                  {
                    id: "call-question",
                    type: "function",
                    function: {
                      name: "ask_user_question",
                      arguments: JSON.stringify({
                        header: "Scope",
                        question: "Which scope should I use?",
                        options: [
                          { label: "Narrow", description: "Only change the minimum needed." },
                          { label: "Broad", description: "Include adjacent cleanup." },
                        ],
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
        id: "chatcmpl-answer",
        choices: [{ message: { content: "Continuing." } }],
      });
    }) as unknown as typeof fetch;

    const paused = await runPrompt({
      input: "continue workflow",
      rootDir,
      messages: [{ role: "user", content: "continue workflow" }],
    });
    if (paused.kind !== "needs_user_question") throw new Error("expected needs_user_question");

    await resolveUserQuestion({
      engine: "etl",
      rootDir,
      sessionId: paused.sessionId,
      messages: paused.messages,
      toolCallId: paused.toolCallId,
      question: paused.question,
      answer: { selectedIndex: 3, label: "Answer freely", description: "Type freely.", kind: "freeform", freeformText: "Keep the file format unchanged." },
    });

    expect(seenBodies[1].messages.some((m) => m.role === "tool" && m.content.includes("freeformText"))).toBe(true);
    expect(seenBodies[1].messages.some((m) => m.role === "user" && m.content.includes("[question:Scope answered freely] Keep the file format unchanged."))).toBe(true);

    const jsonl = await readFile(paused.sessionPath, "utf8");
    expect(jsonl).toContain('"answerKind":"freeform"');
    expect(jsonl).toContain("Keep the file format unchanged.");
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
  await mkdir(join(rootDir, "source_materials"), { recursive: true });
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
    "  - stat_path",
    "  - list_files",
    "  - grep_files",
    "  - read_file",
    "  - view_image",
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

async function configureTestProviderEnv(options: { models?: string[]; vision?: boolean } = {}): Promise<void> {
  const configDir = await mkdtemp(join(tmpdir(), "vesicle-agent-provider-"));
  providerConfigDirs.push(configDir);
  const configPath = join(configDir, "providers.yaml");
  await writeFile(configPath, [
    "default:",
    "  provider: test",
    "  model: test-model",
    "providers:",
    "  test:",
    "    protocol: openai-chat-compatible",
    "    baseUrl: https://provider.test/v1",
    "    apiKeyEnv: TEST_PROVIDER_API_KEY",
    "    models:",
    ...(options.models ?? (options.vision
      ? [
          "      - id: test-model",
          "        capabilities:",
          "          vision: true",
        ]
      : ["      - test-model"])),
    "",
  ].join("\n"), "utf8");
  await writeFile(join(configDir, ".env"), "TEST_PROVIDER_API_KEY=test-key\n", "utf8");
  process.env.VESICLE_PROVIDERS_FILE = configPath;
  delete process.env.TEST_PROVIDER_API_KEY;
  delete process.env.VESICLE_API_KEY;
  delete process.env.VESICLE_PROVIDER;
  delete process.env.VESICLE_BASE_URL;
  delete process.env.VESICLE_MODEL;
}

function testPng(): Uint8Array {
  return Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
}

async function cleanupProviderConfigDirs(): Promise<void> {
  const dirs = providerConfigDirs.splice(0);
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })));
}

function rawSse(blocks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const block of blocks) {
        controller.enqueue(encoder.encode(`${block}\n\n`));
      }
      controller.close();
    },
  });
}

async function eventually(assertion: () => void | Promise<void>): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      await assertion();
      return;
    } catch (error) {
      lastError = error;
      await Bun.sleep(5);
    }
  }
  throw lastError;
}
