import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { askSideQuestion } from "../../../src/core/side-question/service";
import type { SideQuestionContextSnapshot } from "../../../src/core/side-question/types";
import { sseFromBlocks } from "../../support/providers/sse";
import { configureTestProviderEnv, createPromptRoot, restoreAgentLoopTestState } from "../../integration/agent-loop/fixtures/agent-loop";

beforeEach(configureTestProviderEnv);
afterEach(restoreAgentLoopTestState);

function snapshot(overrides: Partial<SideQuestionContextSnapshot> = {}): SideQuestionContextSnapshot {
  return {
    sessionId: "side-session",
    engine: "etl",
    providerSelection: { provider: "test", model: "test-model" },
    visionEnabled: false,
    systemPrompt: "inherited engine system prompt",
    messages: [
      { role: "user", content: "what is 2+2?" },
      { role: "assistant", content: "four" },
    ],
    ...overrides,
  };
}

describe("side question service", () => {
  test("sends inherited system/history plus the question and omits tools", async () => {
    await configureTestProviderEnv();
    const rootDir = await createPromptRoot();
    let requestBody: any;
    globalThis.fetch = (async (_input: unknown, init: RequestInit & { body?: unknown }) => {
      requestBody = JSON.parse(String(init?.body));
      return Response.json({ id: "side-1", choices: [{ message: { content: "side answer" } }] });
    }) as unknown as typeof fetch;

    const result = await askSideQuestion({ rootDir, context: snapshot(), question: "why?" });

    expect(result.content).toBe("side answer");
    expect(requestBody.tools).toBeUndefined();
    const systemContents = requestBody.messages
      .filter((message: any) => message.role === "system")
      .map((message: any) => message.content);
    expect(systemContents[0]).toBe("inherited engine system prompt");
    expect(systemContents[1]).toContain("temporary side question");
    expect(requestBody.messages.at(-1)).toEqual({ role: "user", content: "why?" });
  });

  test("streams text deltas into one final answer", async () => {
    await configureTestProviderEnv();
    const rootDir = await createPromptRoot();
    globalThis.fetch = (async () => new Response(sseFromBlocks([
      'data: {"id":"side-stream","choices":[{"delta":{"content":"hel"}}]}',
      'data: {"id":"side-stream","choices":[{"delta":{"content":"lo"}}]}',
      'data: {"id":"side-stream","choices":[{"delta":{"content":"!"},"finish_reason":"stop"}]}',
      "data: [DONE]",
    ]), { headers: { "content-type": "text/event-stream" } })) as unknown as typeof fetch;

    const deltas: string[] = [];
    const result = await askSideQuestion({ rootDir, context: snapshot(), question: "hi", onDelta: (delta) => deltas.push(delta) });

    expect(deltas.join("")).toBe("hello!");
    expect(result.content).toBe("hello!");
  });

  test("a tool-call-only response becomes an error and is never executed", async () => {
    await configureTestProviderEnv();
    const rootDir = await createPromptRoot();
    globalThis.fetch = (async () => {
      // No text content, only a tool call — `/btw` must not loop or execute it.
      return Response.json({
        id: "side-tool",
        choices: [{ message: {
          content: "",
          tool_calls: [{ id: "call-x", type: "function", function: { name: "read_file", arguments: "{}" } }],
        } }],
      });
    }) as unknown as typeof fetch;

    await expect(askSideQuestion({ rootDir, context: snapshot(), question: "do something" }))
      .rejects.toThrow("did not return a text answer");
  });

  test("side cancellation aborts only the side request", async () => {
    await configureTestProviderEnv();
    const rootDir = await createPromptRoot();
    const controller = new AbortController();
    globalThis.fetch = ((input: unknown, init: RequestInit & { body?: unknown }) => {
      const signal = init?.signal ?? new AbortController().signal;
      return new Promise<Response>((resolve, reject) => {
        if (signal.aborted) reject(new DOMException("aborted", "AbortError"));
        signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
        setTimeout(() => resolve(Response.json({ id: "late", choices: [{ message: { content: "late" } }] })), 1000);
        void input;
      });
    }) as unknown as typeof fetch;

    setTimeout(() => controller.abort(), 10);
    await expect(askSideQuestion({ rootDir, context: snapshot(), question: "cancel me", signal: controller.signal }))
      .rejects.toThrow();
  });

  test("materializes inherited image references for a vision snapshot without base64 in the snapshot", async () => {
    await configureTestProviderEnv({ vision: true });
    const rootDir = await createPromptRoot();
    const { ingestImageBytes } = await import("../../../src/core/attachments/store");
    const { testPng } = await import("../../integration/agent-loop/fixtures/agent-loop");
    const image = await ingestImageBytes(rootDir, testPng(), { source: "clipboard", filename: "capture.png" });
    // The snapshot carries the reference only (no base64), as the agent loop publishes it.
    const referenceOnly = { ...image };
    delete (referenceOnly as { data?: string }).data;
    let requestBody: any;
    globalThis.fetch = (async (_input: unknown, init: RequestInit & { body?: unknown }) => {
      requestBody = JSON.parse(String(init?.body));
      return Response.json({ id: "side-vision", choices: [{ message: { content: "seen" } }] });
    }) as unknown as typeof fetch;

    const context = snapshot({
      visionEnabled: true,
      messages: [{ role: "user", content: "look", images: [referenceOnly] }],
    });
    const result = await askSideQuestion({ rootDir, context, question: "describe" });

    expect(result.content).toBe("seen");
    const userWithImage = requestBody.messages.find((message: any) => Array.isArray(message.content));
    expect(userWithImage.content).toContainEqual(expect.objectContaining({
      type: "image_url",
      image_url: expect.objectContaining({ url: expect.stringContaining("data:image/png;base64,") }),
    }));
    // The snapshot object passed in must not have gained base64 data.
    expect((context.messages[0]!.images![0] as { data?: string }).data).toBeUndefined();
  });
});
