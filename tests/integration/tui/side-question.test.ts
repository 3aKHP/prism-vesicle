import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createSignal } from "solid-js";
import { KeyEvent } from "@opentui/core";
import { createSideQuestionController } from "../../../src/tui/side-question-controller";
import type { SideQuestionContextSnapshot } from "../../../src/core/side-question/types";
import type { VesicleMessage } from "../../../src/providers/shared/types";
import { sseFromBlocks } from "../../support/providers/sse";
import { configureTestProviderEnv, createPromptRoot, restoreAgentLoopTestState, testPng } from "../agent-loop/fixtures/agent-loop";

beforeEach(configureTestProviderEnv);
afterEach(restoreAgentLoopTestState);

function key(name: string) {
  return new KeyEvent({
    name, ctrl: false, meta: false, shift: false, option: false,
    sequence: "", number: false, raw: "", eventType: "press", source: "raw",
  });
}

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

async function waitFor<T>(read: () => T, predicate: (value: T) => boolean, timeoutMs = 1000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let value = read();
  while (!predicate(value) && Date.now() < deadline) {
    await tick();
    value = read();
  }
  if (!predicate(value)) throw new Error(`waitFor timed out; last value: ${JSON.stringify(value)}`);
  return value;
}

function snapshot(): SideQuestionContextSnapshot {
  return {
    sessionId: "session-a",
    engine: "etl",
    providerSelection: { provider: "test", model: "test-model" },
    visionEnabled: false,
    engineSystemPrompt: "system",
    messages: [{ role: "user", content: "hi" }, { role: "assistant", content: "hello" }],
  };
}

function makeController(rootDir: string) {
  const [sessionId, setSessionId] = createSignal<string | undefined>("session-a");
  const [conversation] = createSignal(snapshot().messages);
  const [activeEngine] = createSignal<"etl">("etl");
  const [reasoningTier] = createSignal(undefined);
  const [status, setStatus] = createSignal("");
  const [mainActive] = createSignal(false);
  const copied: string[] = [];
  const controller = createSideQuestionController({
    rootDir,
    sessionId,
    conversation,
    activeEngine,
    activeProviderSelection: () => ({ provider: "test", model: "test-model" }),
    activeReasoningTier: reasoningTier,
    mainStatus: status,
    mainActive,
    setStatus,
    copyText: async (text) => { copied.push(text); return true; },
  });
  controller.captureSnapshot(snapshot());
  return { controller, copied, setSessionId };
}

describe("side question controller", () => {
  test("idle refresh replays the live conversation images and thinking with full fidelity", async () => {
    await configureTestProviderEnv({ vision: true });
    const rootDir = await createPromptRoot();
    const { ingestImageBytes } = await import("../../../src/core/attachments/store");
    const image = await ingestImageBytes(rootDir, testPng(), { source: "clipboard", filename: "capture.png" });
    // The boundary snapshot has no images; the live conversation gained one plus
    // assistant thinking after the turn settled. The idle refresh must carry both.
    const [conversation] = createSignal<VesicleMessage[]>([
      { role: "user", content: "look", images: [image] },
      { role: "assistant", content: "ok", reasoningContent: "reasoning here", thinkingBlocks: [{ type: "reasoning", reasoningContent: "reasoning here" }] },
    ]);
    let requestBody: { messages?: Array<{ content?: unknown }> } | undefined;
    globalThis.fetch = (async (_input: unknown, init: RequestInit & { body?: unknown }) => {
      requestBody = JSON.parse(String(init?.body));
      return new Response(sseFromBlocks([
        'data: {"id":"s","choices":[{"delta":{"content":"a"}}]}',
        'data: {"id":"s","choices":[{"delta":{},"finish_reason":"stop"}]}',
        "data: [DONE]",
      ]), { headers: { "content-type": "text/event-stream" } });
    }) as unknown as typeof fetch;

    const controller = createSideQuestionController({
      rootDir,
      sessionId: createSignal<string | undefined>("session-a")[0],
      conversation,
      activeEngine: createSignal<"etl">("etl")[0],
      activeProviderSelection: () => ({ provider: "test", model: "test-model" }),
      activeReasoningTier: createSignal(undefined)[0],
      mainStatus: createSignal("")[0],
      mainActive: createSignal(false)[0],
      setStatus: createSignal("")[1],
      copyText: async () => true,
    });
    controller.captureSnapshot({
      sessionId: "session-a",
      engine: "etl",
      providerSelection: { provider: "test", model: "test-model" },
      visionEnabled: true,
      engineSystemPrompt: "system",
      messages: [{ role: "user", content: "look" }],
    });

    await controller.openSideQuestion("describe");
    await waitFor(() => controller.currentExchange()?.phase, (phase) => phase === "complete");

    const userWithImage = requestBody!.messages!.find((message) => Array.isArray(message.content));
    expect(userWithImage?.content).toContainEqual(expect.objectContaining({
      type: "image_url",
      image_url: expect.objectContaining({ url: expect.stringContaining("data:image/png;base64,") }),
    }));
  });

  test("opens, streams, and reopens the latest exchange with bare /btw", async () => {
    await configureTestProviderEnv();
    const rootDir = await createPromptRoot();
    globalThis.fetch = (async () => new Response(sseFromBlocks([
      'data: {"id":"s","choices":[{"delta":{"content":"side answer"}}]}',
      'data: {"id":"s","choices":[{"delta":{},"finish_reason":"stop"}]}',
      "data: [DONE]",
    ]), { headers: { "content-type": "text/event-stream" } })) as unknown as typeof fetch;

    const { controller } = makeController(rootDir);
    await controller.openSideQuestion("question 1");
    await waitFor(() => controller.currentExchange()?.phase, (phase) => phase === "complete");
    expect(controller.currentExchange()?.answer).toBe("side answer");

    // Closing then bare /btw reopens the latest in-memory exchange.
    controller.setOverlay(null);
    expect(controller.overlay()).toBeNull();
    await controller.openSideQuestion("");
    expect(controller.overlay()?.exchangeIndex).toBe(0);
    expect(controller.currentExchange()?.question).toBe("question 1");
  });

  test("left/right navigate only this session's exchanges; c copies; x clears", async () => {
    await configureTestProviderEnv();
    const rootDir = await createPromptRoot();
    globalThis.fetch = (async () => new Response(sseFromBlocks([
      'data: {"id":"s","choices":[{"delta":{"content":"a"}}]}',
      'data: {"id":"s","choices":[{"delta":{},"finish_reason":"stop"}]}',
      "data: [DONE]",
    ]), { headers: { "content-type": "text/event-stream" } })) as unknown as typeof fetch;

    const { controller, copied } = makeController(rootDir);
    await controller.openSideQuestion("first");
    await waitFor(() => controller.currentExchange()?.phase, (phase) => phase === "complete");
    await controller.openSideQuestion("second");
    await waitFor(() => controller.currentExchange()?.phase, (phase) => phase === "complete");
    expect(controller.overlay()?.exchangeIndex).toBe(1);

    controller.handleKey(key("left"));
    expect(controller.currentExchange()?.question).toBe("first");
    controller.handleKey(key("right"));
    expect(controller.currentExchange()?.question).toBe("second");

    controller.handleKey(key("c"));
    await waitFor(() => copied.length, (length) => length === 1);
    expect(copied).toEqual(["a"]);

    controller.handleKey(key("x"));
    expect(controller.overlay()).toBeNull();
    expect(controller.sessionExchanges("session-a")).toHaveLength(0);
  });

  test("escape during loading cancels only the side request and closes the overlay", async () => {
    await configureTestProviderEnv();
    const rootDir = await createPromptRoot();
    globalThis.fetch = ((input: unknown, init: RequestInit & { body?: unknown }) => {
      const signal = init?.signal ?? new AbortController().signal;
      void input;
      return new Promise<Response>((_resolve, reject) => {
        if (signal.aborted) reject(new DOMException("aborted", "AbortError"));
        signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
      });
    }) as unknown as typeof fetch;

    const { controller } = makeController(rootDir);
    await controller.openSideQuestion("loading one");
    expect(controller.currentExchange()?.phase).toBe("loading");
    // Escape during loading aborts the side AbortController and closes.
    controller.handleKey(key("escape"));
    expect(controller.overlay()).toBeNull();
    await waitFor(
      () => controller.sessionExchanges("session-a").at(-1)?.phase,
      (phase) => phase === "cancelled",
    );
  });

  test("a failed side request records the error in the exchange, not the main transcript", async () => {
    await configureTestProviderEnv();
    const rootDir = await createPromptRoot();
    globalThis.fetch = (async () => new Response("bad request", { status: 400, headers: { "content-type": "text/plain" } })) as unknown as typeof fetch;

    const { controller } = makeController(rootDir);
    await controller.openSideQuestion("will fail");
    await waitFor(
      () => controller.currentExchange()?.phase,
      (phase) => phase === "error",
    );
    expect(controller.currentExchange()?.error).toBeTruthy();
  });

  test("with no snapshot, falls back to the not-started status and opens nothing", async () => {    await configureTestProviderEnv();
    const rootDir = await createPromptRoot();
    const [status, setStatus] = createSignal("");
    const [sessionId] = createSignal<string | undefined>("session-a");
    const controller = createSideQuestionController({
      rootDir,
      sessionId,
      conversation: createSignal([])[0],
      activeEngine: createSignal<"etl">("etl")[0],
      activeProviderSelection: () => ({ provider: "test", model: "test-model" }),
      activeReasoningTier: createSignal(undefined)[0],
      mainStatus: status,
      mainActive: createSignal(false)[0],
      setStatus,
      copyText: async () => true,
    });
    // No captureSnapshot call: nothing to ask over.
    await controller.openSideQuestion("anything");
    expect(controller.overlay()).toBeNull();
    expect(status()).toContain("available after the session starts");
  });
});
