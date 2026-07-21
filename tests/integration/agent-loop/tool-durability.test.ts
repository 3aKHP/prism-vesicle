import { readFile, } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { resolvePermission, runPrompt } from "../../../src/core/agent-loop/run";
import type { AgentLoopEvent } from "../../../src/core/agent-loop/run";
import { loadSessionSnapshot } from "../../../src/core/session/store";
import { configureTestProviderEnv, createPromptRoot, restoreAgentLoopTestState, } from "./fixtures/agent-loop";

beforeEach(configureTestProviderEnv);
afterEach(restoreAgentLoopTestState);

describe("agent loop: tool durability", () => {
  test.skipIf(process.platform === "win32")("keeps a durable tool result resolved when the provider continuation fails", async () => {
    const rootDir = await createPromptRoot();
    globalThis.fetch = (async () => Response.json({
      id: "chat-permission-provider-failure",
      choices: [{ message: { content: "", tool_calls: [{
        id: "call-provider-failure",
        type: "function",
        function: { name: "shell_exec", arguments: JSON.stringify({ command: "printf completed" }) },
      }] } }],
    })) as unknown as typeof fetch;
    const paused = await runPrompt({ input: "run", rootDir, permission: { mode: "MOMENTUM", shellExecEnabled: true } });
    if (paused.kind !== "needs_permission") throw new Error("expected permission pause");
    globalThis.fetch = (async () => new Response("bad request", { status: 400 })) as unknown as typeof fetch;

    await expect(resolvePermission({
      engine: "etl",
      rootDir,
      sessionId: paused.sessionId,
      messages: paused.messages,
      request: paused.request,
      remainingToolCalls: paused.remainingToolCalls,
      resolution: { decision: "allow_once", resolvedAt: new Date().toISOString() },
      permission: { mode: "MOMENTUM", shellExecEnabled: true },
    })).rejects.toThrow();
    const recovered = await loadSessionSnapshot(rootDir, paused.sessionId, { synthesizeDanglingToolResults: false });
    expect(recovered.pendingPermission).toBeUndefined();
    expect(recovered.messages.find((message) => message.toolCallId === paused.request.toolCallId)?.toolOk).toBe(true);
  });

  test.skipIf(process.platform === "win32")("keeps a durable tool result resolved when cancellation reaches the provider continuation", async () => {
    const rootDir = await createPromptRoot();
    globalThis.fetch = (async () => Response.json({
      id: "chat-permission-provider-abort",
      choices: [{ message: { content: "", tool_calls: [{
        id: "call-provider-abort",
        type: "function",
        function: { name: "shell_exec", arguments: JSON.stringify({ command: "printf completed" }) },
      }] } }],
    })) as unknown as typeof fetch;
    const paused = await runPrompt({ input: "run", rootDir, permission: { mode: "MOMENTUM", shellExecEnabled: true } });
    if (paused.kind !== "needs_permission") throw new Error("expected permission pause");
    const controller = new AbortController();
    globalThis.fetch = (async (_input: unknown, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      if (init?.signal?.aborted) reject(init.signal.reason);
      else init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
    })) as unknown as typeof fetch;

    await expect(resolvePermission({
      engine: "etl",
      rootDir,
      sessionId: paused.sessionId,
      messages: paused.messages,
      request: paused.request,
      remainingToolCalls: paused.remainingToolCalls,
      resolution: { decision: "allow_once", resolvedAt: new Date().toISOString() },
      permission: { mode: "MOMENTUM", shellExecEnabled: true },
      signal: controller.signal,
      onEvent: (event) => {
        if (event.type === "tool_result" && event.callId === paused.request.toolCallId) controller.abort(new Error("cancel continuation"));
      },
    })).rejects.toThrow("aborted");
    const recovered = await loadSessionSnapshot(rootDir, paused.sessionId, { synthesizeDanglingToolResults: false });
    expect(recovered.pendingPermission).toBeUndefined();
    expect(recovered.messages.find((message) => message.toolCallId === paused.request.toolCallId)?.toolOk).toBe(true);
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

});
