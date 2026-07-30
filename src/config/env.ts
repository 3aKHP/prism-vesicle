export type VesicleProvider = "openai-chat-compatible" | "openai-responses" | "anthropic-messages" | "gemini-generate-content";
export type ProviderAuthMethod = "bearer" | "x-api-key" | "x-goog-api-key";
export type ResponsesProfile = "openai-public" | "codex-http-relay";

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
  vision?: boolean;
};

export type AutoCompactLimits = {
  enabled?: boolean;
  threshold?: number;
  reserveOutputTokens?: number;
};

export type ModelLimits = {
  contextWindow?: number;
  maxOutputTokens?: number;
  autoCompact?: AutoCompactLimits;
};

export type VesicleConfig = {
  provider: VesicleProvider;
  providerId: string;
  baseUrl: string;
  model: string;
  apiKey?: string;
  apiKeyLabel?: string;
  authMethod?: ProviderAuthMethod;
  userAgent?: string;
  responsesProfile?: ResponsesProfile;
  generation?: GenerationDefaults;
  capabilities?: ModelCapabilities;
  limits?: ModelLimits;
};
