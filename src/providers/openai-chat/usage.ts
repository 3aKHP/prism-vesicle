import { normalizeResponseUsage } from "../shared/usage";
import type { ResponseUsage } from "../shared/types";
import type { ChatCompletionResponse } from "./types";

export function usageFromChatCompletionUsage(usage: ChatCompletionResponse["usage"] | undefined): ResponseUsage | undefined {
  if (!usage) return undefined;
  const cachedTokens = usage.prompt_tokens_details?.cached_tokens;
  const reasoningTokens = usage.completion_tokens_details?.reasoning_tokens;
  return normalizeResponseUsage({
    contextInputTokens: usage.prompt_tokens,
    inputTokens: usage.prompt_tokens,
    outputTokens: usage.completion_tokens,
    totalTokens: usage.total_tokens,
    cacheReadInputTokens: cachedTokens,
    cacheHitInputTokens: cachedTokens,
    reasoningTokens,
    providerDetails: {
      ...(usage.prompt_tokens_details ? { promptTokensDetails: usage.prompt_tokens_details } : {}),
      ...(usage.completion_tokens_details ? { completionTokensDetails: usage.completion_tokens_details } : {}),
    },
  });
}
