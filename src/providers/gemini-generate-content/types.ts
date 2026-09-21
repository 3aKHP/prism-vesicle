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
 * Single owner of the degenerate-part rule. Gemini streaming can end a
 * response with a bare empty text part: the documented carrier shape for a
 * trailing thoughtSignature. Without a signature such a part carries nothing
 * the endpoint validates, and a lossy JSON re-serializer (a strict relay, in
 * either direction) can strip the empty string and degrade the part into a
 * data-less shape the endpoint rejects (`oneof data` must have one
 * initialized field). The same rejection covers every signature-less part
 * whose only keys are `text`/`thought` with empty or absent text: `{}` (the
 * relay already stripped the empty string on the response path),
 * `{text:"", thought:true}`, and `{thought:true}`. Parts carrying a
 * `thoughtSignature` string, non-empty text, or any other field are kept
 * verbatim.
 */
export function isDatalessGeminiPart(part: GeminiPart): boolean {
  if (typeof part.thoughtSignature === "string") return false;
  if (typeof part.text === "string" && part.text !== "") return false;
  return Object.keys(part).every((key) => key === "text" || key === "thought");
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
