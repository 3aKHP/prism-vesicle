import { expect, test } from "bun:test";
import { OpenAIResponsesAdapter } from "../../../src/providers/openai-responses/adapter";
import { summarize } from "./support";
import { nativeItemCount, resolveResponsesAcceptance, runResponsesFunctionLoop } from "./responses-support";

const precondition = await resolveResponsesAcceptance({
  providerEnv: "BUN_E2E_RESPONSES_PROVIDER",
  modelEnv: "BUN_E2E_RESPONSES_MODEL",
  profile: "codex-http-relay",
  allowConfiguredProtocolOverride: true,
});
if (!precondition.config) console.log(`[acceptance:responses-http] unavailable: ${precondition.reason}`);
const liveTest: typeof test = precondition.config ? test : test.skip;

liveTest("real Responses HTTP/SSE function loop and native Item replay", async () => {
  const selected = precondition.config!;
  const adapter = new OpenAIResponsesAdapter({
    ...selected,
    provider: "openai-responses",
    responsesProfile: "codex-http-relay",
  });
  const { firstEvents, secondEvents, first, second, callId } = await runResponsesFunctionLoop(adapter, selected);
  expect(nativeItemCount(first.providerState?.payload)).toBeGreaterThan(0);
  expect(second.content.length).toBeGreaterThan(0);
  expect(second.toolCalls ?? []).toHaveLength(0);
  summarize("responses-http", {
    provider: selected.providerId,
    model: selected.model,
    firstEventTypes: firstEvents.map((event) => event.type),
    callCount: first.toolCalls?.length ?? 0,
    callIdShape: callId.startsWith("call_"),
    nativeItemCount: nativeItemCount(first.providerState?.payload),
    secondEventTypes: secondEvents.map((event) => event.type),
    finalContentLength: second.content.length,
    usagePresent: second.usage?.totalTokens !== undefined,
  });
}, 60_000);
