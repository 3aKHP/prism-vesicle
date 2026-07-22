import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { askSideQuestion } from "../../../src/core/side-question/service";
import type { SideQuestionContextSnapshot } from "../../../src/core/side-question/types";
import { sseFromBlocks } from "../../support/providers/sse";
import { configureTestProviderEnv, createPromptRoot, restoreAgentLoopTestState, testPng } from "../../integration/agent-loop/fixtures/agent-loop";

beforeEach(configureTestProviderEnv);
afterEach(restoreAgentLoopTestState);

function snapshot(overrides: Partial<SideQuestionContextSnapshot> = {}): SideQuestionContextSnapshot {
  return {
    sessionId: "side-session",
    engine: "etl",
    providerSelection: { provider: "test", model: "test-model" },
    visionEnabled: false,
    engineSystemPrompt: "inherited engine system prompt",
    messages: [
      { role: "user", content: "what is 2+2?" },
      { role: "assistant", content: "four" },
    ],
    ...overrides,
  };
}

function captureBody(): { fetch: typeof fetch; read: () => any } {
  let body: any;
  return {
    fetch: (async (_input: unknown, init: RequestInit & { body?: unknown }) => {
      body = JSON.parse(String(init?.body));
      return Response.json({ id: "side-1", choices: [{ message: { content: "side answer" } }] });
    }) as unknown as typeof fetch,
    read: () => body,
  };
}

describe("side question service request shape", () => {
  test("sends exactly one system prompt (the side asset) and one user reference packet, omits tools", async () => {
    await configureTestProviderEnv();
    const rootDir = await createPromptRoot();
    const { fetch, read } = captureBody();
    globalThis.fetch = fetch;

    await askSideQuestion({ rootDir, context: snapshot(), question: "why?" });
    const body = read();

    // Exactly one system instruction, and it is the side-question prompt.
    const systemMessages = body.messages.filter((message: any) => message.role === "system");
    expect(systemMessages).toHaveLength(1);
    expect(systemMessages[0].content).toContain("temporary side question");
    // The parent Engine prompt is NOT a system message.
    expect(systemMessages[0].content).not.toContain("inherited engine system prompt");

    // No tools, no tool-choice, no tool-role or assistant messages on the wire.
    expect(body.tools).toBeUndefined();
    expect(body.tool_choice).toBeUndefined();
    expect(body.messages.filter((message: any) => message.role === "tool")).toHaveLength(0);
    expect(body.messages.filter((message: any) => message.role === "assistant")).toHaveLength(0);

    // One user reference packet carrying the parent Engine prompt (quoted) + the
    // final side question.
    const userMessages = body.messages.filter((message: any) => message.role === "user");
    expect(userMessages).toHaveLength(1);
    const packet = typeof userMessages[0].content === "string"
      ? userMessages[0].content
      : userMessages[0].content.map((part: any) => part.text ?? "").join("\n");
    expect(packet).toContain("<parent_engine_reference engine=\"etl\">");
    expect(packet).toContain("inherited engine system prompt");
    expect(packet).toContain("<conversation_reference>");
    expect(packet).toContain("<side_question>");
    expect(packet).toContain("why?");
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
});

describe("side question service response handling", () => {
  test("a tool-call-only response is rejected and never executed", async () => {
    await configureTestProviderEnv();
    const rootDir = await createPromptRoot();
    globalThis.fetch = (async () => Response.json({
      id: "side-tool",
      choices: [{ message: {
        content: "",
        tool_calls: [{ id: "call-x", type: "function", function: { name: "read_file", arguments: "{}" } }],
      } }],
    })) as unknown as typeof fetch;

    await expect(askSideQuestion({ rootDir, context: snapshot(), question: "do something" }))
      .rejects.toThrow("attempted to call a tool");
  });

  test("a mixed text-plus-tool response is also rejected", async () => {
    await configureTestProviderEnv();
    const rootDir = await createPromptRoot();
    globalThis.fetch = (async () => Response.json({
      id: "side-mixed",
      choices: [{ message: {
        content: "Let me look that up.",
        tool_calls: [{ id: "call-y", type: "function", function: { name: "read_file", arguments: "{}" } }],
      } }],
    })) as unknown as typeof fetch;

    await expect(askSideQuestion({ rootDir, context: snapshot(), question: "do something" }))
      .rejects.toThrow("attempted to call a tool");
  });

  test("a whitespace-only text response is rejected by the service backstop", async () => {
    await configureTestProviderEnv();
    const rootDir = await createPromptRoot();
    // Non-empty whitespace passes the adapter's content check but must still be
    // rejected by the service's trim() backstop as a no-answer response.
    globalThis.fetch = (async () => Response.json({ id: "side-empty", choices: [{ message: { content: "   " } }] })) as unknown as typeof fetch;

    await expect(askSideQuestion({ rootDir, context: snapshot(), question: "do something" }))
      .rejects.toThrow("did not return a text answer");
  });

  test("side cancellation aborts only the side request", async () => {
    await configureTestProviderEnv();
    const rootDir = await createPromptRoot();
    const controller = new AbortController();
    globalThis.fetch = ((input: unknown, init: RequestInit & { body?: unknown }) => {
      const signal = init?.signal ?? new AbortController().signal;
      return new Promise<Response>((_resolve, reject) => {
        if (signal.aborted) reject(new DOMException("aborted", "AbortError"));
        signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
        void input;
      });
    }) as unknown as typeof fetch;

    setTimeout(() => controller.abort(), 10);
    await expect(askSideQuestion({ rootDir, context: snapshot(), question: "cancel me", signal: controller.signal }))
      .rejects.toThrow();
  });
});

describe("side question service images", () => {
  test("materializes inherited image references on the user packet for vision and keeps the snapshot base64-free", async () => {
    await configureTestProviderEnv({ vision: true });
    const rootDir = await createPromptRoot();
    const { ingestImageBytes } = await import("../../../src/core/attachments/store");
    const image = await ingestImageBytes(rootDir, testPng(), { source: "clipboard", filename: "capture.png" });
    const referenceOnly = { ...image };
    delete (referenceOnly as { data?: string }).data;
    const { fetch, read } = captureBody();
    globalThis.fetch = fetch;

    const context = snapshot({
      visionEnabled: true,
      messages: [{ role: "user", content: "look", images: [referenceOnly] }],
    });
    const result = await askSideQuestion({ rootDir, context, question: "describe" });

    expect(result.content).toBe("side answer");
    const userWithImage = read().messages.find((message: any) => Array.isArray(message.content));
    expect(userWithImage.content).toContainEqual(expect.objectContaining({
      type: "image_url",
      image_url: expect.objectContaining({ url: expect.stringContaining("data:image/png;base64,") }),
    }));
    // The snapshot object passed in must not have gained base64 data.
    expect((context.messages[0]!.images![0] as { data?: string }).data).toBeUndefined();
  });
});
