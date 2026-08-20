import type { ToolCall } from "../../core/tools";
import { ProviderError } from "../shared/errors";
import { displayTextFromThinkingBlocks } from "../shared/thinking";
import { normalizeResponseUsage } from "../shared/usage";
import type { ProviderThinkingBlock, VesicleResponse, WebSearchCitation, WebSearchReport } from "../shared/types";
import type { GeminiGroundingMetadata, GeminiPart, GeminiResponse } from "./types";

export function responseFromGeminiBody(
  body: GeminiResponse | undefined,
  fallbackId: string,
  providerId?: string,
): VesicleResponse {
  const candidate = body?.candidates?.[0];
  return responseFromGeminiParts({
    parts: candidate?.content?.parts ?? [],
    finishReason: candidate?.finishReason,
    usage: body?.usageMetadata,
    groundingMetadata: candidate?.groundingMetadata,
    fallbackId,
    raw: body,
    providerId,
  });
}

export function responseFromGeminiParts(args: {
  parts: GeminiPart[];
  finishReason?: string;
  usage?: GeminiResponse["usageMetadata"];
  groundingMetadata?: GeminiGroundingMetadata;
  fallbackId: string;
  raw?: unknown;
  providerId?: string;
}): VesicleResponse {
  const normalizedParts = args.parts.map((part, index) => normalizeGeminiPart(part, index));
  const textParts: string[] = [];
  const toolCalls: ToolCall[] = [];
  const needsReplay = normalizedParts.some((part) => part.thought === true || typeof part.thoughtSignature === "string");
  const thinkingBlocks: ProviderThinkingBlock[] = needsReplay
    ? normalizedParts.map((part) => ({ type: "gemini_part", part: jsonClone(part) }))
    : [];

  for (let index = 0; index < normalizedParts.length; index++) {
    const part = normalizedParts[index];
    if (part.text && part.thought !== true) textParts.push(part.text);
    if (part.functionCall) {
      const name = part.functionCall.name?.trim();
      if (!name) {
        throw new ProviderError("Provider response included a functionCall without name.", {
          kind: "malformed_response",
          providerId: args.providerId,
        });
      }
      toolCalls.push({
        id: part.functionCall.id || `gemini_tool_${index + 1}`,
        name,
        arguments: jsonString(part.functionCall.args),
      });
    }
  }

  const content = textParts.join("");
  const webSearch = webSearchReport(args.groundingMetadata, args.providerId);
  const reasoningContent = displayTextFromThinkingBlocks(thinkingBlocks);
  if (!content && toolCalls.length === 0) {
    throw new ProviderError("Provider response did not include assistant content or tool calls.", {
      kind: "malformed_response",
      providerId: args.providerId,
    });
  }

  return {
    id: args.fallbackId,
    content,
    ...(reasoningContent ? { reasoningContent } : {}),
    ...(thinkingBlocks.length > 0 ? { thinkingBlocks } : {}),
    toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
    ...(webSearch ? { webSearch } : {}),
    finishReason: args.finishReason,
    raw: args.raw,
    usage: usageFromGeminiMetadata(args.usage),
  };
}

/**
 * Gemini returns grounding on the candidate rather than as a tool-call part.
 * Queries are the durable audit floor, so malformed or empty query metadata
 * produces no report even when citations are present.
 */
function webSearchReport(
  groundingMetadata: GeminiGroundingMetadata | undefined,
  providerId: string | undefined,
): WebSearchReport | undefined {
  if (!groundingMetadata || !providerId) return undefined;
  const queries = new Set<string>();
  for (const query of [...(groundingMetadata.webSearchQueries ?? []), ...(groundingMetadata.webSupportQueries ?? [])]) {
    if (typeof query === "string" && query) queries.add(query);
  }
  if (queries.size === 0) return undefined;
  const citations = (groundingMetadata.groundingChunks ?? []).flatMap((chunk): WebSearchCitation[] => {
    const web = chunk.web;
    if (typeof web?.uri !== "string" || !web.uri || typeof web.title !== "string" || !web.title) return [];
    return [{ url: web.uri, title: web.title }];
  });
  return {
    provider: providerId,
    queries: [...queries],
    ...(citations.length > 0 ? { citations } : {}),
  };
}

function usageFromGeminiMetadata(usage: GeminiResponse["usageMetadata"] | undefined): VesicleResponse["usage"] {
  if (!usage) return undefined;
  return normalizeResponseUsage({
    contextInputTokens: usage.promptTokenCount,
    inputTokens: usage.promptTokenCount,
    outputTokens: usage.candidatesTokenCount,
    totalTokens: usage.totalTokenCount,
    cacheReadInputTokens: usage.cachedContentTokenCount,
    cacheHitInputTokens: usage.cachedContentTokenCount,
    reasoningTokens: usage.thoughtsTokenCount,
    providerDetails: {
      ...(usage.promptTokensDetails !== undefined ? { promptTokensDetails: usage.promptTokensDetails } : {}),
      ...(usage.cacheTokensDetails !== undefined ? { cacheTokensDetails: usage.cacheTokensDetails } : {}),
      ...(usage.candidatesTokensDetails !== undefined ? { candidatesTokensDetails: usage.candidatesTokensDetails } : {}),
      ...(usage.toolUsePromptTokensDetails !== undefined ? { toolUsePromptTokensDetails: usage.toolUsePromptTokensDetails } : {}),
      ...(usage.toolUsePromptTokenCount !== undefined ? { toolUsePromptTokenCount: usage.toolUsePromptTokenCount } : {}),
    },
  });
}

function normalizeGeminiPart(part: GeminiPart, index: number): GeminiPart {
  if (!part.functionCall || part.functionCall.id) return part;
  return {
    ...part,
    functionCall: {
      ...part.functionCall,
      id: `gemini_tool_${index + 1}`,
    },
  };
}

function jsonString(value: unknown): string {
  try {
    return JSON.stringify(value ?? {});
  } catch {
    return "{}";
  }
}

function jsonClone(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value));
}
