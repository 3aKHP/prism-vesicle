import { expect, test } from "bun:test";
import { OpenAIResponsesAdapter, resetResponsesCompactVariantForTest } from "../../../src/providers/openai-responses/adapter";
import { resolveProviderProxyPolicy } from "../../../src/providers";
import { PROVIDER_NATIVE_CHECKPOINT_KIND } from "../../../src/providers/shared/types";
import { summarize } from "./support";
import { nativeCompactItemCount, resolveResponsesAcceptance } from "./responses-support";

// Manual third-party lane for the inline compaction fallback (#328): it
// targets a real Responses backend WITHOUT the standalone /responses/compact
// endpoint (for example a Codex subscription backend relayed by CLIProxyAPI,
// configured as an openai-public profile with remoteCompact: true and a
// non-api.openai.com baseUrl in the user-level providers.yaml).
//
// Run (bring your own endpoint; ~2 model calls on the target backend):
//   BUN_E2E_OPENAI_RESPONSES_V2_PROVIDER=<provider-id> \
//   BUN_E2E_OPENAI_RESPONSES_V2_MODEL=<model> \
//   bun run test:acceptance:responses:compact-v2
//
// The lane PROVES the fallback ran: the recorded standalone probe must answer
// 404 and a POST /responses body must end with the compaction_trigger sentinel.
// Pointing it at an endpoint that still serves the standalone route (for
// example api.openai.com) fails the 404 assertion instead of recording false
// compatibility evidence. A success here is compatibility evidence only.
// Official OpenAI acceptance remains the api.openai.com v1 standalone
// compaction lane (docs/dev/OPENAI_RESPONSES_CONFORMANCE.md).
const precondition = await resolveResponsesAcceptance({
  providerEnv: "BUN_E2E_OPENAI_RESPONSES_V2_PROVIDER",
  modelEnv: "BUN_E2E_OPENAI_RESPONSES_V2_MODEL",
  profile: "openai-public",
  requireRemoteCompact: true,
});
const proxyPolicy = precondition.config ? await resolveProviderProxyPolicy() : undefined;
if (!precondition.config) console.log(`[acceptance:openai-responses-compact-v2] unavailable: ${precondition.reason}`);
const liveTest: typeof test = precondition.config ? test : test.skip;

type RecordedAttempt = { url: string; body: Record<string, unknown>; status: number };

liveTest("backend without standalone compaction negotiates the inline trigger and replays the encrypted window", async () => {
  const config = precondition.config!;
  const adapter = new OpenAIResponsesAdapter({ ...config, responsesTransport: "http" }, { proxyPolicy });
  const codeword = `vesicle-${crypto.randomUUID().slice(0, 8)}`;
  const originalFetch = globalThis.fetch;
  const attempts: RecordedAttempt[] = [];
  resetResponsesCompactVariantForTest();
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const response = await originalFetch(input, init);
    attempts.push({
      url,
      body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>,
      status: response.status,
    });
    return response;
  }) as typeof fetch;
  try {
    const compact = await adapter.compact!({
      id: `acceptance-${crypto.randomUUID()}`,
      model: { provider: config.providerId, model: config.model },
      messages: [{ role: "user", content: `Remember the acceptance codeword ${codeword}.` }],
    });
    expect(nativeCompactItemCount(compact.providerState?.payload)).toBe(1);

    // The evidence owner must observe the fallback, not assume it: a v1
    // success would leave the probe at 200 and no trigger-bearing turn.
    const standaloneProbe = attempts.find((attempt) => attempt.url.endsWith("/responses/compact"));
    expect(standaloneProbe?.status).toBe(404);
    const inlineTurn = attempts.find((attempt) => attempt.url.endsWith("/responses")
      && Array.isArray(attempt.body.input)
      && attempt.body.input.at(-1)?.type === "compaction_trigger");
    expect(inlineTurn).toBeDefined();

    const replay = await adapter.complete({
      id: `acceptance-${crypto.randomUUID()}`,
      model: { provider: config.providerId, model: config.model },
      system: ["Reply with the acceptance codeword only."],
      messages: [
        { role: "user", content: "", kind: PROVIDER_NATIVE_CHECKPOINT_KIND, providerState: compact.providerState },
        { role: "user", content: "What is the acceptance codeword?" },
      ],
      generation: { maxTokens: 256 },
    });
    expect(replay.content).toContain(codeword);
    summarize("openai-responses-compact-v2", {
      provider: config.providerId,
      model: config.model,
      endpoint: new URL(config.baseUrl).hostname,
      standaloneProbeStatus: standaloneProbe?.status,
      negotiatedInlineCompaction: inlineTurn !== undefined,
      codewordRecalled: replay.content.includes(codeword),
      usagePresent: compact.usage?.totalTokens !== undefined,
      proxyActive: proxyPolicy?.kind !== "direct",
    });
  } finally {
    globalThis.fetch = originalFetch;
    resetResponsesCompactVariantForTest();
  }
}, 120_000);
