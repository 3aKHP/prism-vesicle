import type { VesicleConfig } from "../config/env";
import { AnthropicMessagesAdapter } from "./anthropic-messages/adapter";
import { GeminiGenerateContentAdapter } from "./gemini-generate-content/adapter";
import { OpenAIChatCompatibleAdapter } from "./openai-chat/adapter";
import type { ProviderAdapter } from "./shared/types";

export function createProvider(config: VesicleConfig): ProviderAdapter {
  switch (config.provider) {
    case "openai-chat-compatible":
      return new OpenAIChatCompatibleAdapter(config);
    case "anthropic-messages":
      return new AnthropicMessagesAdapter(config);
    case "gemini-generate-content":
      return new GeminiGenerateContentAdapter(config);
  }
}
