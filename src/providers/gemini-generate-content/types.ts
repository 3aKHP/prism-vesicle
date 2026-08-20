export type GeminiPart = {
  text?: string;
  thought?: boolean;
  thoughtSignature?: string;
  functionCall?: {
    id?: string;
    name?: string;
    args?: unknown;
  };
  functionResponse?: {
    id?: string;
    name?: string;
    response?: unknown;
  };
  [key: string]: unknown;
};

export type GeminiContent = {
  role?: "user" | "model";
  parts?: GeminiPart[];
};

export type GeminiGroundingMetadata = {
  webSearchQueries?: string[];
  webSupportQueries?: string[];
  groundingChunks?: Array<{
    web?: {
      uri?: string;
      title?: string;
    };
    [key: string]: unknown;
  }>;
  [key: string]: unknown;
};

export type GeminiCandidate = {
  content?: GeminiContent;
  finishReason?: string;
  groundingMetadata?: GeminiGroundingMetadata;
};

export type GeminiResponse = {
  candidates?: GeminiCandidate[];
  usageMetadata?: {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
    totalTokenCount?: number;
    cachedContentTokenCount?: number;
    thoughtsTokenCount?: number;
    toolUsePromptTokenCount?: number;
    promptTokensDetails?: unknown;
    cacheTokensDetails?: unknown;
    candidatesTokensDetails?: unknown;
    toolUsePromptTokensDetails?: unknown;
  };
  error?: {
    message?: string;
  };
};
