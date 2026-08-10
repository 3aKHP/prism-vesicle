import { expect, test } from "bun:test";
import { OpenAIResponsesAdapter } from "../../../src/providers/openai-responses/adapter";
import { closeResponsesWebSocketSession } from "../../../src/providers/openai-responses/websocket";
import { resolveProviderProxyPolicy } from "../../../src/providers";
import { summarize } from "./support";
import { resolveResponsesAcceptance, runResponsesFunctionLoop } from "./responses-support";

// Validates that the official api.openai.com endpoint still accepts the
// codex-beta-2026-02-06 WebSocket wire shape — the `openai-beta:
// responses_websockets=2026-02-06` handshake header and the stream:true +
// stream_options `response.create` body. Like the openai-public WebSocket lane,
// it overwrites globalThis.fetch to fail any silent HTTP downgrade, so a pass
// confirms real WebSocket use.
//
// The lane intentionally resolves the Setup-authored openai-public provider
// config (credentials + official endpoint) and injects the codex-beta profile
// on the adapter, because codex-beta is hand-edit-only (Setup never authors it)
// but targets the same official endpoint.
const precondition = await resolveResponsesAcceptance({
  providerEnv: "BUN_E2E_OPENAI_RESPONSES_PROVIDER",
  modelEnv: "BUN_E2E_OPENAI_RESPONSES_MODEL",
  profile: "openai-public",
  requireOfficialEndpoint: true,
});
const proxyPolicy = precondition.config ? await resolveProviderProxyPolicy() : undefined;
const proxyActive = proxyPolicy?.kind !== "direct";
if (!precondition.config) console.log(`[acceptance:openai-responses-codex-beta] unavailable: ${precondition.reason}`);
const liveTest: typeof test = precondition.config ? test : test.skip;

liveTest("official OpenAI codex-beta-2026-02-06 WebSocket function loop", async () => {
  const config = precondition.config!;
  const sessionId = `acceptance-codex-beta-${crypto.randomUUID()}`;
  const originalFetch = globalThis.fetch;
  const adapter = new OpenAIResponsesAdapter({
    ...config,
    responsesProfile: "codex-beta-2026-02-06",
    responsesTransport: "websocket",
  }, { sessionId, proxyPolicy });
  try {
    globalThis.fetch = (async () => {
      throw new Error("codex-beta-2026-02-06 acceptance attempted HTTP fallback.");
    }) as unknown as typeof fetch;
    const result = await runResponsesFunctionLoop(adapter, config);
    expect(result.first.toolCalls).toHaveLength(1);
    expect(result.second.content.length).toBeGreaterThan(0);
    summarize("openai-responses-codex-beta", {
      provider: config.providerId,
      model: config.model,
      firstEventTypes: result.firstEvents.map((event) => event.type),
      secondEventTypes: result.secondEvents.map((event) => event.type),
      callIdShape: result.callId.startsWith("call_"),
      proxyActive,
    });
  } finally {
    globalThis.fetch = originalFetch;
    closeResponsesWebSocketSession(sessionId);
  }
}, 120_000);
