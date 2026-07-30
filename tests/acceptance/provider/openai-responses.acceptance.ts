import { expect, test } from "bun:test";
import { OpenAIResponsesAdapter } from "../../../src/providers/openai-responses/adapter";
import { closeResponsesWebSocketSession } from "../../../src/providers/openai-responses/websocket";
import type { ProviderStateJson } from "../../../src/providers/shared/state";
import { summarize } from "./support";
import {
  nativeItemCount,
  resolveResponsesAcceptance,
  runResponsesFunctionLoop,
} from "./responses-support";

const precondition = await resolveResponsesAcceptance({
  providerEnv: "BUN_E2E_OPENAI_RESPONSES_PROVIDER",
  modelEnv: "BUN_E2E_OPENAI_RESPONSES_MODEL",
  profile: "openai-public",
  requireOfficialEndpoint: true,
  requireRemoteCompact: true,
});
if (!precondition.config) console.log(`[acceptance:openai-responses] unavailable: ${precondition.reason}`);
const liveTest: typeof test = precondition.config ? test : test.skip;

liveTest("official OpenAI HTTP/SSE function loop and stateless native replay", async () => {
  const config = precondition.config!;
  const adapter = new OpenAIResponsesAdapter({ ...config, responsesTransport: "http" });
  const result = await runResponsesFunctionLoop(adapter, config);
  expect(result.first.toolCalls).toHaveLength(1);
  expect(result.second.toolCalls ?? []).toHaveLength(0);
  expect(result.second.content.length).toBeGreaterThan(0);
  expect(nativeItemCount(result.first.providerState?.payload)).toBeGreaterThan(0);
  summarize("openai-responses-http", {
    provider: config.providerId,
    model: config.model,
    firstEventTypes: result.firstEvents.map((event) => event.type),
    secondEventTypes: result.secondEvents.map((event) => event.type),
    callIdShape: result.callId.startsWith("call_"),
    nativeItemCount: nativeItemCount(result.first.providerState?.payload),
    usagePresent: result.second.usage?.totalTokens !== undefined,
  });
}, 120_000);

liveTest("official OpenAI non-stream JSON and standalone compact", async () => {
  const config = precondition.config!;
  const adapter = new OpenAIResponsesAdapter({ ...config, responsesTransport: "http" });
  const response = await adapter.complete({
    id: `acceptance-${crypto.randomUUID()}`,
    model: { provider: config.providerId, model: config.model },
    system: ["Reply with one short sentence."],
    messages: [{ role: "user", content: "Confirm this non-streaming request." }],
    generation: { maxTokens: 128 },
  });
  expect(response.content.length).toBeGreaterThan(0);
  const compact = await adapter.compact!({
    id: `acceptance-${crypto.randomUUID()}`,
    model: { provider: config.providerId, model: config.model },
    messages: [
      { role: "user", content: "Retain the fact that the acceptance marker is blue." },
      { role: "assistant", content: response.content, providerState: response.providerState },
    ],
  });
  expect(nativeCompactItemCount(compact.providerState?.payload)).toBe(1);
  summarize("openai-responses-compact", {
    provider: config.providerId,
    model: config.model,
    nonStreamContentLength: response.content.length,
    compactItemCount: nativeCompactItemCount(compact.providerState?.payload),
    usagePresent: compact.usage?.totalTokens !== undefined,
  });
}, 120_000);

liveTest("official OpenAI public WebSocket prewarm, continuation, and tool loop", async () => {
  const config = precondition.config!;
  const sessionId = `acceptance-${crypto.randomUUID()}`;
  const originalFetch = globalThis.fetch;
  const adapter = new OpenAIResponsesAdapter({
    ...config,
    responsesTransport: "websocket",
  }, { sessionId });
  try {
    globalThis.fetch = (async () => {
      throw new Error("Official OpenAI WebSocket acceptance attempted HTTP fallback.");
    }) as unknown as typeof fetch;
    const result = await runResponsesFunctionLoop(adapter, config);
    expect(result.first.toolCalls).toHaveLength(1);
    expect(result.second.content.length).toBeGreaterThan(0);
    summarize("openai-responses-websocket", {
      provider: config.providerId,
      model: config.model,
      firstEventTypes: result.firstEvents.map((event) => event.type),
      secondEventTypes: result.secondEvents.map((event) => event.type),
      callIdShape: result.callId.startsWith("call_"),
    });
  } finally {
    globalThis.fetch = originalFetch;
    closeResponsesWebSocketSession(sessionId);
  }
}, 120_000);

function nativeCompactItemCount(payload: ProviderStateJson | undefined): number {
  if (!payload || typeof payload !== "object" || Array.isArray(payload) || !Array.isArray(payload.compactedInput)) return 0;
  return payload.compactedInput.filter((item) => (
    item && typeof item === "object" && !Array.isArray(item) && item.type === "compaction"
  )).length;
}
