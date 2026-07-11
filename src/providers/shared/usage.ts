import type { ResponseUsage } from "./types";

export function normalizeResponseUsage(input: ResponseUsage | undefined): ResponseUsage | undefined {
  if (!input) return undefined;
  const usage: ResponseUsage = {};
  setNumber(usage, "contextInputTokens", input.contextInputTokens ?? input.inputTokens);
  setNumber(usage, "inputTokens", input.inputTokens);
  setNumber(usage, "outputTokens", input.outputTokens);
  setNumber(usage, "totalTokens", input.totalTokens ?? sumIfKnown(input.inputTokens, input.outputTokens));
  setNumber(usage, "cacheReadInputTokens", input.cacheReadInputTokens);
  setNumber(usage, "cacheWriteInputTokens", input.cacheWriteInputTokens);
  setNumber(usage, "cacheHitInputTokens", input.cacheHitInputTokens ?? input.cacheReadInputTokens);
  setNumber(usage, "cacheMissInputTokens", input.cacheMissInputTokens);
  setNumber(usage, "reasoningTokens", input.reasoningTokens);
  setNumber(usage, "effectiveTokens", input.effectiveTokens ?? effectiveTokens(input));
  if (input.providerDetails && Object.keys(input.providerDetails).length > 0) {
    usage.providerDetails = input.providerDetails;
  }
  return Object.keys(usage).length > 0 ? usage : undefined;
}

function effectiveTokens(usage: ResponseUsage): number | undefined {
  const output = usage.outputTokens ?? 0;
  const cachedInput = Math.max(usage.cacheHitInputTokens ?? 0, usage.cacheReadInputTokens ?? 0);
  if (usage.inputTokens !== undefined) {
    return Math.max(0, usage.inputTokens - cachedInput) + output;
  }
  const input = (usage.cacheMissInputTokens ?? 0) + (usage.cacheWriteInputTokens ?? 0);
  if (input > 0 || usage.outputTokens !== undefined) return input + output;
  return undefined;
}

function setNumber<T extends keyof ResponseUsage>(usage: ResponseUsage, key: T, value: ResponseUsage[T]): void {
  if (typeof value === "number" && Number.isFinite(value)) {
    (usage as Record<string, unknown>)[key] = value;
  }
}

function sumIfKnown(left: number | undefined, right: number | undefined): number | undefined {
  if (left === undefined || right === undefined) return undefined;
  return left + right;
}
