import { readFile, stat, } from "node:fs/promises";
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

  test("fails malformed tool arguments without replaying successful siblings", async () => {
    const rootDir = await createPromptRoot();
    const requestBodies: any[] = [];

    globalThis.fetch = (async (_input: unknown, init: RequestInit & { body?: unknown }) => {
      requestBodies.push(JSON.parse(String(init.body)));
      if (requestBodies.length === 1) {
        return Response.json({
          id: "chatcmpl-malformed-tools",
          choices: [{ message: {
            content: "",
            tool_calls: [
              {
                id: "call-good",
                type: "function",
                function: {
                  name: "write_file",
                  arguments: JSON.stringify({ path: "workspace/good.md", content: "written once" }),
                },
              },
              {
                id: "call-bad",
                type: "function",
                function: {
                  name: "write_file",
                  arguments: "{\"path\":\"workspace/bad.md\",\"content\":\"truncated",
                },
              },
            ],
          } }],
        });
      }
      return Response.json({ id: "chatcmpl-recovered", choices: [{ message: { content: "Recovered." } }] });
    }) as unknown as typeof fetch;

    const result = await runPrompt({ input: "write both files", rootDir, permission: { mode: "MOMENTUM" } });
    if (result.kind !== "complete") throw new Error("expected complete");

    expect(await readFile(join(rootDir, "workspace", "good.md"), "utf8")).toBe("written once");
    await expect(stat(join(rootDir, "workspace", "bad.md"))).rejects.toMatchObject({ code: "ENOENT" });
    const replayedAssistant = requestBodies[1].messages.find((message: any) => message.role === "assistant");
    expect(replayedAssistant.tool_calls).toEqual([
      expect.objectContaining({ id: "call-good", function: expect.objectContaining({ arguments: expect.stringContaining("good.md") }) }),
      expect.objectContaining({ id: "call-bad", function: expect.objectContaining({ arguments: "{}" }) }),
    ]);
    expect(requestBodies[1].messages.filter((message: any) => message.role === "tool")).toHaveLength(2);

    const records = (await readFile(result.sessionPath, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    const assistant = records.find((record) => record.role === "assistant" && record.metadata?.providerResponseId === "chatcmpl-malformed-tools");
    expect(assistant.metadata.toolCalls[1].arguments).toBe("{}");
    expect(assistant.metadata.malformedToolArguments).toEqual([
      expect.objectContaining({
        toolCallId: "call-bad",
        name: "write_file",
        reason: "invalid-json",
        originalLength: expect.any(Number),
        sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      }),
    ]);
    expect(records.filter((record) => record.role === "tool" && record.metadata?.toolCallId === "call-good")).toHaveLength(1);
    expect(records.find((record) => record.role === "tool" && record.metadata?.toolCallId === "call-bad")?.metadata).toMatchObject({
      ok: false,
      reason: "malformed-tool-arguments",
    });
    expect(records.filter((record) => record.role === "tool").map((record) => record.metadata.toolCallId)).toEqual([
      "call-good",
      "call-bad",
    ]);
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
