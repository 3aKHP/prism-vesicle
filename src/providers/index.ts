import type { VesicleConfig } from "../config/env";
import { OpenAIChatCompatibleAdapter } from "./openai-chat/adapter";
import type { ProviderAdapter } from "./shared/types";

export function createProvider(config: VesicleConfig): ProviderAdapter {
  switch (config.provider) {
    case "openai-chat-compatible":
      return new OpenAIChatCompatibleAdapter(config);
  }
}
