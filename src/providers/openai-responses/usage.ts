import { normalizeResponseUsage } from "../shared/usage";
import type { ResponseUsage } from "../shared/types";
import type { ResponsesUsage } from "./types";

export function usageFromResponses(usage: ResponsesUsage | undefined): ResponseUsage | undefined {
  if (!usage) return undefined;
  const cached = usage.input_tokens_details?.cached_tokens;
  const reasoning = usage.output_tokens_details?.reasoning_tokens;
  return normalizeResponseUsage({
    contextInputTokens: usage.input_tokens,
    inputTokens: usage.input_tokens,
    outputTokens: usage.output_tokens,
    totalTokens: usage.total_tokens,
    cacheReadInputTokens: cached,
    cacheHitInputTokens: cached,
    reasoningTokens: reasoning,
    providerDetails: {
      ...(usage.input_tokens_details ? { inputTokensDetails: usage.input_tokens_details } : {}),
      ...(usage.output_tokens_details ? { outputTokensDetails: usage.output_tokens_details } : {}),
    },
  });
}
