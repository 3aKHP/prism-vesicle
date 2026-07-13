import type { ResponseUsage } from "../shared/types";
import { normalizeResponseUsage } from "../shared/usage";
import type { AnthropicUsage } from "./types";

export function usageFromAnthropicUsage(usage: AnthropicUsage | undefined): ResponseUsage | undefined {
  if (!usage) return undefined;
  return normalizeResponseUsage({
    contextInputTokens: sumDefined(
      usage.input_tokens,
      usage.cache_creation_input_tokens,
      usage.cache_read_input_tokens,
    ),
    inputTokens: usage.input_tokens,
    outputTokens: usage.output_tokens,
    cacheReadInputTokens: usage.cache_read_input_tokens,
    cacheHitInputTokens: usage.cache_read_input_tokens,
    cacheWriteInputTokens: usage.cache_creation_input_tokens,
    cacheMissInputTokens: usage.cache_creation_input_tokens,
    providerDetails: {
      ...(usage.cache_creation_input_tokens !== undefined
        ? { cacheCreationInputTokens: usage.cache_creation_input_tokens }
        : {}),
      ...(usage.cache_read_input_tokens !== undefined
        ? { cacheReadInputTokens: usage.cache_read_input_tokens }
        : {}),
    },
  });
}

function sumDefined(...values: Array<number | undefined>): number | undefined {
  let total = 0;
  let seen = false;
  for (const value of values) {
    if (typeof value !== "number" || !Number.isFinite(value)) continue;
    total += value;
    seen = true;
  }
  return seen ? total : undefined;
}
