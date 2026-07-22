import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createSignal } from "solid-js";
import { KeyEvent } from "@opentui/core";
import { runPrompt } from "../../../src/core/agent-loop/run";
import { createSideQuestionController } from "../../../src/tui/side-question-controller";
import { resolveSideQuestionSnapshot } from "../../../src/core/side-question/service";
import type { SideQuestionContextSnapshot } from "../../../src/core/side-question/types";
import { sseFromBlocks } from "../../support/providers/sse";
import { configureTestProviderEnv, createPromptRoot, restoreAgentLoopTestState } from "../agent-loop/fixtures/agent-loop";

beforeEach(configureTestProviderEnv);
afterEach(restoreAgentLoopTestState);

function key(name: string) {
  return new KeyEvent({
    name, ctrl: false, meta: false, shift: false, option: false,
    sequence: "", number: false, raw: "", eventType: "press", source: "raw",
  });
}

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

async function waitFor<T>(read: () => T, predicate: (value: T) => boolean, timeoutMs = 2000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let value = read();
  while (!predicate(value) && Date.now() < deadline) {
    await tick();
    value = read();
  }
  if (!predicate(value)) throw new Error(`waitFor timed out; last value: ${JSON.stringify(value)}`);
  return value;
}

describe("side question snapshot freshness after host actions", () => {
  test("rebuilds with the current model after a /model switch with no intervening turn", async () => {
    await configureTestProviderEnv({ models: ["      - test-model", "      - other-model"] });
    const rootDir = await createPromptRoot();
    globalThis.fetch = (async () => Response.json({ id: "turn", choices: [{ message: { content: "ok" } }] })) as unknown as typeof fetch;

    let captured: SideQuestionContextSnapshot | undefined;
    const result = await runPrompt({
      input: "hi",
      rootDir,
      permission: { mode: "MOMENTUM" },
      onProviderContextSnapshot: (snapshot) => { captured = snapshot; },
    });
    if (result.kind !== "complete") throw new Error("expected complete turn");
    expect(captured?.providerSelection.model).toBe("test-model");

    // Simulate the user switching model after the turn, before any new turn.
    const [providerSel, setProviderSel] = createSignal({ provider: "test", model: "test-model" });
    let requestModel: string | undefined;
    globalThis.fetch = (async (_input: unknown, init: RequestInit & { body?: unknown }) => {
      requestModel = (JSON.parse(String(init?.body)) as { model?: string }).model;
      return new Response(sseFromBlocks([
        'data: {"id":"s","choices":[{"delta":{"content":"a"}}]}',
        'data: {"id":"s","choices":[{"delta":{},"finish_reason":"stop"}]}',
        "data: [DONE]",
      ]), { headers: { "content-type": "text/event-stream" } });
    }) as unknown as typeof fetch;

    const controller = createSideQuestionController({
      rootDir,
      sessionId: createSignal<string | undefined>(result.sessionId)[0],
      conversation: createSignal([])[0],
      activeEngine: createSignal<"etl">("etl")[0],
      activeProviderSelection: providerSel,
      activeReasoningTier: createSignal(undefined)[0],
      mainStatus: createSignal("")[0],
      mainActive: createSignal(false)[0],
      setStatus: createSignal("")[1],
      copyText: async () => true,
    });
    controller.captureSnapshot(captured!);
    setProviderSel({ provider: "test", model: "other-model" });

    await controller.openSideQuestion("follow-up");
    await waitFor(() => controller.currentExchange()?.phase, (phase) => phase === "complete");
    expect(requestModel).toBe("other-model");
  });

  test("resume snapshot keeps model generation defaults alongside the reasoning tier", async () => {
    await configureTestProviderEnv({
      models: [
        "      - id: test-model",
        "        generation:",
        "          temperature: 0.42",
        "          maxTokens: 2048",
      ],
    });
    const rootDir = await createPromptRoot();
    globalThis.fetch = (async () => Response.json({ id: "turn", choices: [{ message: { content: "ok" } }] })) as unknown as typeof fetch;
    const result = await runPrompt({ input: "hi", rootDir, permission: { mode: "MOMENTUM" } });
    if (result.kind !== "complete") throw new Error("expected complete turn");

    const snapshot = await resolveSideQuestionSnapshot({
      rootDir,
      sessionId: result.sessionId,
      engine: "etl",
      providerSelection: { provider: "test", model: "test-model" },
      reasoningTier: "high",
    });
    expect(snapshot?.generation).toMatchObject({ temperature: 0.42, maxTokens: 2048, reasoningTier: "high" });
  });

  test("idle /btw uses current messages after the conversation changes (rewind/compact)", async () => {
    await configureTestProviderEnv();
    const rootDir = await createPromptRoot();
    globalThis.fetch = (async () => Response.json({ id: "turn", choices: [{ message: { content: "ok" } }] })) as unknown as typeof fetch;
    let captured: SideQuestionContextSnapshot | undefined;
    const result = await runPrompt({
      input: "first prompt",
      rootDir,
      permission: { mode: "MOMENTUM" },
      onProviderContextSnapshot: (snapshot) => { captured = snapshot; },
    });
    if (result.kind !== "complete") throw new Error("expected complete turn");

    // The boundary snapshot still sees the pre-rewind messages; the live
    // conversation was rewound to a single different user message.
    const rewound = createSignal([{ role: "user" as const, content: "only this remains" }]);
    let sideBody: { messages?: Array<{ role?: string; content?: unknown }> } | undefined;
    globalThis.fetch = (async (_input: unknown, init: RequestInit & { body?: unknown }) => {
      sideBody = JSON.parse(String(init?.body));
      return new Response(sseFromBlocks([
        'data: {"id":"s","choices":[{"delta":{"content":"a"}}]}',
        'data: {"id":"s","choices":[{"delta":{},"finish_reason":"stop"}]}',
        "data: [DONE]",
      ]), { headers: { "content-type": "text/event-stream" } });
    }) as unknown as typeof fetch;

    const controller = createSideQuestionController({
      rootDir,
      sessionId: createSignal<string | undefined>(result.sessionId)[0],
      conversation: rewound[0],
      activeEngine: createSignal<"etl">("etl")[0],
      activeProviderSelection: () => ({ provider: "test", model: "test-model" }),
      activeReasoningTier: createSignal(undefined)[0],
      mainStatus: createSignal("")[0],
      mainActive: createSignal(false)[0],
      setStatus: createSignal("")[1],
      copyText: async () => true,
    });
    controller.captureSnapshot(captured!);

    await controller.openSideQuestion("what is left?");
    await waitFor(() => controller.currentExchange()?.phase, (phase) => phase === "complete");
    const replayed = sideBody!.messages!.filter((message) => message.role === "user").map((message) => String(message.content));
    expect(replayed.some((content) => content.includes("only this remains"))).toBe(true);
    expect(replayed.some((content) => content.includes("first prompt"))).toBe(false);
  });

  test("Escape during snapshot resolution cancels the side request before it starts", async () => {
    await configureTestProviderEnv({ models: ["      - test-model", "      - other-model"] });
    const rootDir = await createPromptRoot();
    globalThis.fetch = (async () => Response.json({ id: "turn", choices: [{ message: { content: "ok" } }] })) as unknown as typeof fetch;
    let captured: SideQuestionContextSnapshot | undefined;
    const result = await runPrompt({
      input: "hi",
      rootDir,
      permission: { mode: "MOMENTUM" },
      onProviderContextSnapshot: (snapshot) => { captured = snapshot; },
    });
    if (result.kind !== "complete") throw new Error("expected complete turn");

    // Switching the model forces resolveEffectiveSnapshot onto the rebuild
    // path (config + harness + engine-asset + session reads), which spans many
    // async ticks — a real window for Escape to land during the await.
    const [providerSel, setProviderSel] = createSignal({ provider: "test", model: "test-model" });
    let sideFetchCalled = false;
    globalThis.fetch = (async () => {
      sideFetchCalled = true;
      return new Response(sseFromBlocks([
        'data: {"id":"s","choices":[{"delta":{"content":"a"}}]}',
        'data: {"id":"s","choices":[{"delta":{},"finish_reason":"stop"}]}',
        "data: [DONE]",
      ]), { headers: { "content-type": "text/event-stream" } });
    }) as unknown as typeof fetch;

    const controller = createSideQuestionController({
      rootDir,
      sessionId: createSignal<string | undefined>(result.sessionId)[0],
      conversation: createSignal([])[0],
      activeEngine: createSignal<"etl">("etl")[0],
      activeProviderSelection: providerSel,
      activeReasoningTier: createSignal(undefined)[0],
      mainStatus: createSignal("")[0],
      mainActive: createSignal(false)[0],
      setStatus: createSignal("")[1],
      copyText: async () => true,
    });
    controller.captureSnapshot(captured!);
    setProviderSel({ provider: "test", model: "other-model" });

    await controller.openSideQuestion("follow-up");
    // Escape lands during the rebuild await, before the side fetch starts.
    controller.handleKey(key("escape"));
    await waitFor(
      () => controller.sessionExchanges(result.sessionId).at(-1)?.phase,
      (phase) => phase === "cancelled" || phase === "complete" || phase === "error",
    );
    expect(controller.sessionExchanges(result.sessionId).at(-1)?.phase).toBe("cancelled");
    expect(sideFetchCalled).toBe(false);
  });
});
