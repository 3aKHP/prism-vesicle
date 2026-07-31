import { expect, test } from "bun:test";
import { OpenAIResponsesAdapter } from "../../../src/providers/openai-responses/adapter";
import { summarize } from "./support";
import {
  collect,
  completed,
  nativeItemCount,
  resolveResponsesAcceptance,
  runResponsesFunctionLoop,
} from "./responses-support";

const resolved = await resolveResponsesAcceptance({
  providerEnv: "BUN_E2E_DEEPSEEK_RESPONSES_PROVIDER",
  modelEnv: "BUN_E2E_DEEPSEEK_RESPONSES_MODEL",
  profile: "deepseek-subset-2026-07-31",
});
const precondition = resolved.config && new URL(resolved.config.baseUrl).hostname !== "api.deepseek.com"
  ? { reason: `${resolved.config.providerId} is not the official api.deepseek.com endpoint` }
  : resolved.config && resolved.config.model !== "deepseek-v4-flash"
    ? { reason: `${resolved.config.providerId}/${resolved.config.model} is not deepseek-v4-flash` }
    : resolved;
if (!precondition.config) console.log(`[acceptance:deepseek-responses] unavailable: ${precondition.reason}`);
const liveTest: typeof test = precondition.config ? test : test.skip;

liveTest("real DeepSeek subset maps plaintext reasoning events and Items", async () => {
  const config = precondition.config!;
  const adapter = new OpenAIResponsesAdapter({ ...config, responsesTransport: "http" });
  const events = await collect(adapter.stream({
    id: `acceptance-${crypto.randomUUID()}`,
    model: { provider: config.providerId, model: config.model },
    system: ["Reason briefly, then answer with only the final integer."],
    messages: [{ role: "user", content: "What is 37 + 58?" }],
    generation: { reasoningTier: "high", maxTokens: 256 },
  }));
  const response = completed(events);
  expect(response.reasoningContent?.length ?? 0).toBeGreaterThan(0);
  expect(response.content.length).toBeGreaterThan(0);
  expect(nativeItemCount(response.providerState?.payload)).toBeGreaterThan(0);
  summarize("deepseek-responses-reasoning", {
    provider: config.providerId,
    model: config.model,
    eventTypes: events.map((event) => event.type),
    reasoningLength: response.reasoningContent?.length ?? 0,
    contentLength: response.content.length,
    nativeItemCount: nativeItemCount(response.providerState?.payload),
  });
}, 120_000);

liveTest("real DeepSeek subset completes the declared function-call loop", async () => {
  const config = precondition.config!;
  const adapter = new OpenAIResponsesAdapter({ ...config, responsesTransport: "http" });
  const result = await runResponsesFunctionLoop(adapter, config);
  expect(result.first.toolCalls).toHaveLength(1);
  expect(result.second.toolCalls ?? []).toHaveLength(0);
  expect(result.second.content.length).toBeGreaterThan(0);
  summarize("deepseek-responses-tools", {
    provider: config.providerId,
    model: config.model,
    firstEventTypes: result.firstEvents.map((event) => event.type),
    secondEventTypes: result.secondEvents.map((event) => event.type),
    callIdShape: result.callId.length > 0,
  });
}, 120_000);
