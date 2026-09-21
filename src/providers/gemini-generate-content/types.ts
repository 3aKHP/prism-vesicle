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

/**
 * Gemini streaming can end a response with a bare empty text part: the
 * documented carrier shape for a trailing thoughtSignature. When `text` is
 * the only field, the part carries no signature, content, or thought. The
 * endpoint does not validate such signature-less non-functionCall parts, but
 * a lossy JSON re-serializer downstream can degrade one into a data-less `{}`
 * part, which the endpoint rejects (`oneof data` must have one initialized
 * field). Empty text parts that do carry a thoughtSignature are kept verbatim.
 */
export function isBareEmptyGeminiTextPart(part: GeminiPart): boolean {
  return part.text === "" && Object.keys(part).length === 1;
}

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
