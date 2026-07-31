import type { VesicleConfig } from "../config/env";
import { loadUserConfigEnvironment } from "../config/providers";
import { AnthropicMessagesAdapter } from "./anthropic-messages/adapter";
import { GeminiGenerateContentAdapter } from "./gemini-generate-content/adapter";
import { OpenAIChatCompatibleAdapter } from "./openai-chat/adapter";
import { OpenAIResponsesAdapter } from "./openai-responses/adapter";
import type { ResponsesSocketFactory } from "./openai-responses/websocket";
import { loadProviderProxyPolicy, type ProviderProxyPolicy } from "./shared/proxy";
import type { ProviderAdapter } from "./shared/types";

export type ProviderRuntimeContext = {
  sessionId?: string;
  /** Runtime-only provider proxy policy; resolved from the user/process env. */
  proxyPolicy?: ProviderProxyPolicy;
  /** Test override for the native Responses WebSocket factory. */
  webSocketFactory?: ResponsesSocketFactory;
  /** Test override for the Responses WebSocket request timeout. */
  webSocketRequestTimeoutMs?: number;
};

export function createProvider(config: VesicleConfig, context: ProviderRuntimeContext = {}): ProviderAdapter {
  switch (config.provider) {
    case "openai-chat-compatible":
      return new OpenAIChatCompatibleAdapter(config, { proxyPolicy: context.proxyPolicy });
    case "openai-responses":
      return new OpenAIResponsesAdapter(config, {
        sessionId: context.sessionId,
        proxyPolicy: context.proxyPolicy,
        webSocketFactory: context.webSocketFactory,
        webSocketRequestTimeoutMs: context.webSocketRequestTimeoutMs,
      });
    case "anthropic-messages":
      return new AnthropicMessagesAdapter(config, { proxyPolicy: context.proxyPolicy });
    case "gemini-generate-content":
      return new GeminiGenerateContentAdapter(config, { proxyPolicy: context.proxyPolicy });
  }
}

/**
 * Resolve the provider proxy policy from the user-level `.env` (file-only map)
 * and the captured process environment. Composes config loading with the proxy
 * resolver; safe to call wherever a provider is constructed.
 */
export async function resolveProviderProxyPolicy(env: NodeJS.ProcessEnv = process.env): Promise<ProviderProxyPolicy> {
  const userEnv = await loadUserConfigEnvironment(env);
  return loadProviderProxyPolicy({ userFileEnv: userEnv.fileEnv, processEnv: env });
}
