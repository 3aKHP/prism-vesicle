import type { ToolCall } from "../../core/tools";
import { ProviderError } from "../shared/errors";
import { displayTextFromThinkingBlocks } from "../shared/thinking";
import { normalizeResponseUsage } from "../shared/usage";
import type { ProviderThinkingBlock, VesicleResponse } from "../shared/types";
import type { GeminiPart, GeminiResponse } from "./types";

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
    fallbackId,
    raw: body,
    providerId,
  });
}

export function responseFromGeminiParts(args: {
  parts: GeminiPart[];
  finishReason?: string;
  usage?: GeminiResponse["usageMetadata"];
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
    finishReason: args.finishReason,
    raw: args.raw,
    usage: usageFromGeminiMetadata(args.usage),
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
