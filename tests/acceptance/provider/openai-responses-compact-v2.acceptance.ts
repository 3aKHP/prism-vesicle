import { expect, test } from "bun:test";
import { OpenAIResponsesAdapter, resetResponsesCompactVariantForTest } from "../../../src/providers/openai-responses/adapter";
import { resolveProviderProxyPolicy } from "../../../src/providers";
import { PROVIDER_NATIVE_CHECKPOINT_KIND } from "../../../src/providers/shared/types";
import type { ProviderStateJson } from "../../../src/providers/shared/state";
import { summarize } from "./support";
import { resolveResponsesAcceptance } from "./responses-support";

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
// A success here is compatibility evidence only. Official OpenAI acceptance
// remains the api.openai.com v1 standalone-compaction lane
// (docs/dev/OPENAI_RESPONSES_CONFORMANCE.md).
const precondition = await resolveResponsesAcceptance({
  providerEnv: "BUN_E2E_OPENAI_RESPONSES_V2_PROVIDER",
  modelEnv: "BUN_E2E_OPENAI_RESPONSES_V2_MODEL",
  profile: "openai-public",
  requireRemoteCompact: true,
});
const proxyPolicy = precondition.config ? await resolveProviderProxyPolicy() : undefined;
if (!precondition.config) console.log(`[acceptance:openai-responses-compact-v2] unavailable: ${precondition.reason}`);
const liveTest: typeof test = precondition.config ? test : test.skip;

liveTest("backend without standalone compaction negotiates the inline trigger and replays the encrypted window", async () => {
  const config = precondition.config!;
  const adapter = new OpenAIResponsesAdapter({ ...config, responsesTransport: "http" }, { proxyPolicy });
  const codeword = `vesicle-${crypto.randomUUID().slice(0, 8)}`;
  const originalFetch = globalThis.fetch;
  const urls: string[] = [];
  resetResponsesCompactVariantForTest();
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    urls.push(String(input));
    return originalFetch(input, init);
  }) as typeof fetch;
  try {
    const compact = await adapter.compact!({
      id: `acceptance-${crypto.randomUUID()}`,
      model: { provider: config.providerId, model: config.model },
      messages: [{ role: "user", content: `Remember the acceptance codeword ${codeword}.` }],
    });
    const compacted = compact.providerState?.payload;
    expect(nativeCompactItemCount(compacted)).toBe(1);
    expect(urls.some((url) => url.endsWith("/responses/compact"))).toBe(true);
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
      probedStandaloneEndpoint: true,
      negotiatedInlineCompaction: true,
      codewordRecalled: replay.content.includes(codeword),
      usagePresent: compact.usage?.totalTokens !== undefined,
      proxyActive: proxyPolicy?.kind !== "direct",
    });
  } finally {
    globalThis.fetch = originalFetch;
    resetResponsesCompactVariantForTest();
  }
}, 120_000);

function nativeCompactItemCount(payload: ProviderStateJson | undefined): number {
  if (!payload || typeof payload !== "object" || Array.isArray(payload) || !Array.isArray(payload.compactedInput)) return 0;
  return payload.compactedInput.filter((item) => (
    item && typeof item === "object" && !Array.isArray(item) && item.type === "compaction"
  )).length;
}
