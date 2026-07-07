export type VesicleProvider = "openai-chat-compatible";

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
  generation?: GenerationDefaults;
  capabilities?: ModelCapabilities;
};
