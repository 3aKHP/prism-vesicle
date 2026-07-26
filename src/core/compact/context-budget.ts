import type { AutoCompactLimits, GenerationDefaults, ModelLimits } from "../../config/env";
import type { ResumedMessage } from "../session/store";

/**
 * Provider-neutral context-budget evaluation for auto-compaction (issue #107
 * §6 frozen contract). This module owns activation, the soft/hard token
 * formulas, the usage oracle, and the provider-neutral fallback estimator. It
 * is pure core logic — no TUI, no provider calls — so the trigger decision is
 * testable with an oracle derived from the frozen formulas.
 *
 * Auto-compaction is strictly opt-in: it activates only when `limits.autoCompact`
 * exists, `enabled !== false`, `threshold` is strictly between 0 and 1, and
 * `contextWindow` is a positive integer. There is no hidden default threshold.
 */

export type UsageSource = "provider" | "estimated" | "unknown";
export type ReserveSource = "explicit" | "generation-maxTokens" | "model-maxOutputTokens" | "zero";

export type AutoCompactActivation =
  | {
      kind: "active";
      contextWindow: number;
      softTriggerTokens: number;
      hardInputCeilingTokens: number;
      reserveTokens: number;
      reserveSource: ReserveSource;
      threshold: number;
    }
  | {
      kind: "inactive";
      reason: "missing-config" | "disabled" | "missing-threshold" | "invalid-threshold" | "missing-context-window" | "invalid-reserve";
    };

export type InactiveReason = "missing-config" | "disabled" | "missing-threshold" | "invalid-threshold" | "missing-context-window" | "invalid-reserve";

export type BudgetCheckResult =
  | { kind: "inactive"; reason: InactiveReason }
  | { kind: "below"; projectedTokens: number; usageSource: UsageSource }
  | { kind: "soft-trigger"; projectedTokens: number; usageSource: Exclude<UsageSource, "unknown">; softTriggerTokens: number; hardInputCeilingTokens: number }
  | { kind: "hard-ceiling"; projectedTokens: number; usageSource: Exclude<UsageSource, "unknown">; softTriggerTokens: number; hardInputCeilingTokens: number }
  | { kind: "degraded" };

export type BudgetInputs = {
  config: AutoCompactLimits | undefined;
  limits: ModelLimits | undefined;
  generation: GenerationDefaults | undefined;
  /** Explicit per-turn override (composer /effort or generation override). */
  turnMaxTokens?: number;
  /** Most recent provider-observed active context-window occupancy. */
  lastContextInputTokens?: number;
  /** Host estimate of the full next provider request (system + history + tool schema + incoming input). */
  estimatedNextRequestTokens?: number;
};

/**
 * Resolve activation and the effective reserve. Reserve precedence (plan §6):
 * explicit `reserveOutputTokens` → effective turn `maxTokens` (turn override
 * then model generation default) → `limits.maxOutputTokens` → zero. An explicit
 * reserve greater than or equal to the context window, or any statically known
 * limit that makes the effective input budget non-positive, deactivates rather
 * than being silently clamped.
 */
export function resolveAutoCompactActivation(inputs: BudgetInputs): AutoCompactActivation {
  const { config, limits, generation, turnMaxTokens } = inputs;
  if (!config) return { kind: "inactive", reason: "missing-config" };
  if (config.enabled === false) return { kind: "inactive", reason: "disabled" };
  const threshold = config.threshold;
  if (threshold === undefined || Number.isNaN(threshold)) return { kind: "inactive", reason: "missing-threshold" };
  if (!(threshold > 0 && threshold < 1)) return { kind: "inactive", reason: "invalid-threshold" };
  const contextWindow = limits?.contextWindow;
  if (contextWindow === undefined || !Number.isInteger(contextWindow) || contextWindow <= 0) {
    return { kind: "inactive", reason: "missing-context-window" };
  }
  const reserve = resolveReserve(config, generation, limits?.maxOutputTokens, turnMaxTokens);
  if (reserve.explicit && (reserve.tokens < 0 || reserve.tokens >= contextWindow)) {
    return { kind: "inactive", reason: "invalid-reserve" };
  }
  const effectiveInputBudget = contextWindow - reserve.tokens;
  if (effectiveInputBudget <= 0) return { kind: "inactive", reason: "invalid-reserve" };
  const softTriggerTokens = Math.floor(Math.min(contextWindow * threshold, effectiveInputBudget));
  const hardInputCeilingTokens = effectiveInputBudget;
  return {
    kind: "active",
    contextWindow,
    softTriggerTokens,
    hardInputCeilingTokens,
    reserveTokens: reserve.tokens,
    reserveSource: reserve.source,
    threshold,
  };
}

function resolveReserve(
  config: AutoCompactLimits,
  generation: GenerationDefaults | undefined,
  modelMaxOutputTokens: number | undefined,
  turnMaxTokens: number | undefined,
): { tokens: number; source: ReserveSource; explicit: boolean } {
  if (config.reserveOutputTokens !== undefined) {
    return { tokens: config.reserveOutputTokens, source: "explicit", explicit: true };
  }
  if (turnMaxTokens !== undefined) return { tokens: turnMaxTokens, source: "generation-maxTokens", explicit: false };
  if (generation?.maxTokens !== undefined) return { tokens: generation.maxTokens, source: "generation-maxTokens", explicit: false };
  if (modelMaxOutputTokens !== undefined) return { tokens: modelMaxOutputTokens, source: "model-maxOutputTokens", explicit: false };
  return { tokens: 0, source: "zero", explicit: false };
}

/**
 * Decide whether the next provider request needs compaction. The provider's
 * most recent `contextInputTokens` is the primary oracle, with the host's full
 * next-request estimate added as growth (the new turn's records, system prompt,
 * tool schema, and pending input that were not in the observation). If only the
 * estimate is available it is used directly. If neither is available the result
 * is `degraded`: do not claim protection, allow the request, let the user
 * compact manually. Equality at the soft threshold triggers; equality at the
 * hard ceiling is still sendable (the output reserve was already deducted).
 */
export function evaluateBudgetCheck(inputs: BudgetInputs): BudgetCheckResult {
  const activation = resolveAutoCompactActivation(inputs);
  if (activation.kind === "inactive") return { kind: "inactive", reason: activation.reason };
  const projected = projectOccupancy(inputs);
  if (projected === undefined) return { kind: "degraded" };
  const { softTriggerTokens, hardInputCeilingTokens } = activation;
  if (projected.value < softTriggerTokens) return { kind: "below", projectedTokens: projected.value, usageSource: projected.source };
  if (projected.value <= hardInputCeilingTokens) {
    return { kind: "soft-trigger", projectedTokens: projected.value, usageSource: projected.source, softTriggerTokens, hardInputCeilingTokens };
  }
  return { kind: "hard-ceiling", projectedTokens: projected.value, usageSource: projected.source, softTriggerTokens, hardInputCeilingTokens };
}

function projectOccupancy(inputs: BudgetInputs): { value: number; source: Exclude<UsageSource, "unknown"> } | undefined {
  const provider = inputs.lastContextInputTokens;
  const estimate = inputs.estimatedNextRequestTokens;
  if (typeof provider === "number" && provider > 0 && typeof estimate === "number") {
    // The provider-observed occupancy is the authoritative floor; the estimate
    // covers growth the provider has not seen. Whichever value is larger
    // determines the projection, and the source reflects which one did so a
    // consumer never mistakes an estimate-derived value for provider-authoritative.
    const value = Math.max(provider, estimate);
    return { value, source: estimate > provider ? "estimated" : "provider" };
  }
  if (typeof provider === "number" && provider > 0) return { value: provider, source: "provider" };
  if (typeof estimate === "number") return { value: estimate, source: "estimated" };
  return undefined;
}

/**
 * Provider-neutral fallback estimator (plan §6): an explicitly approximate,
 * upper-biased heuristic of `ceil(utf8 bytes / 2)` plus fixed per-message and
 * per-tool-envelope overhead. It excludes base64 image materialization from the
 * transcript size (image cost is unknown without a provider-specific estimator).
 * Estimated values are suitable for early compaction but must be displayed as
 * estimates; they are not a promise that the provider will accept the request.
 */
export function estimateRequestTokens(messages: ResumedMessage[], systemPrompt?: string): number {
  let bytes = 0;
  let overhead = 0;
  if (systemPrompt) bytes += Buffer.byteLength(systemPrompt, "utf8");
  for (const message of messages) {
    overhead += 4;
    bytes += Buffer.byteLength(message.content, "utf8");
    if (message.toolCalls) {
      for (const call of message.toolCalls) {
        bytes += Buffer.byteLength(call.arguments, "utf8");
        overhead += 4;
      }
    }
    // Images carry only metadata references in the transcript; their base64
    // cost is unknown without a provider-specific estimator, so it is not
    // counted here.
  }
  return Math.ceil(bytes / 2) + overhead;
}
