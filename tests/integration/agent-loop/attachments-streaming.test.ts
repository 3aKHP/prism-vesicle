import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { runPrompt } from "../../../src/core/agent-loop/run";
import type { AgentLoopEvent } from "../../../src/core/agent-loop/run";
import { ingestImageBytes } from "../../../src/core/attachments/store";
import { sseFromBlocks } from "../../support/providers/sse";
import { configureTestProviderEnv, createPromptRoot, restoreAgentLoopTestState, testPng } from "./fixtures/agent-loop";

beforeEach(configureTestProviderEnv);
afterEach(restoreAgentLoopTestState);

describe("agent loop: attachments and streaming", () => {
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

  test("emits streamed reasoning deltas from the provider", async () => {
    const rootDir = await createPromptRoot();
    const events: AgentLoopEvent[] = [];

    globalThis.fetch = (async () => {
      return new Response(sseFromBlocks([
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

});
