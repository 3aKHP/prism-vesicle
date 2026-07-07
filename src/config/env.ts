export type VesicleProvider = "openai-chat-compatible" | "anthropic-messages";
export type ProviderAuthMethod = "bearer" | "x-api-key";

export type GenerationDefaults = {
  temperature?: number;
  maxTokens?: number;
};

export type ModelCapabilities = {
  streaming?: boolean;
  tools?: boolean;
  reasoningTier?: boolean;
  reasoningContent?: boolean;
  temperature?: boolean;
  maxTokens?: boolean;
};

export type VesicleConfig = {
  provider: VesicleProvider;
  providerId: string;
  baseUrl: string;
  model: string;
  apiKey?: string;
  apiKeyLabel?: string;
  authMethod?: ProviderAuthMethod;
  generation?: GenerationDefaults;
  capabilities?: ModelCapabilities;
};
