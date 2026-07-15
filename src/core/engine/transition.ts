import type { EngineId } from "./profile";
import type { EngineSwitchRequest } from "./switch";

export const ENGINE_HANDOFF_KIND = "engine-handoff";

export const engineContextPolicies = ["preserve_full", "summary", "fresh"] as const;
export type EngineContextPolicy = typeof engineContextPolicies[number];

export type EngineTransitionSource = "manual" | "model_request";
export type EngineTransitionDecision = "direct" | "confirmed" | "rejected";

export type EngineTransition = {
  source: EngineTransitionSource;
  decision: EngineTransitionDecision;
  fromEngine: EngineId;
  toEngine: EngineId;
  reason: string;
  handoffSummary: string;
  recommendedNextAction?: string;
  contextPolicy: EngineContextPolicy;
  /**
   * Holds a compacted continuation brief when the transition uses summary
   * context. Fresh context remains reserved for a future explicit
   * context-discard workflow.
   */
  contextSummary?: string;
};

export type EngineTransitionOptions = {
  contextPolicy?: EngineContextPolicy;
  handoffSummary?: string;
  recommendedNextAction?: string;
  contextSummary?: string;
};

export function createManualEngineTransition(
  fromEngine: EngineId,
  toEngine: EngineId,
  options: EngineTransitionOptions = {},
): EngineTransition {
  const contextPolicy = options.contextPolicy ?? "preserve_full";
  return {
    source: "manual",
    decision: "direct",
    fromEngine,
    toEngine,
    reason: `User manually switched engine from ${fromEngine} to ${toEngine}.`,
    handoffSummary: options.handoffSummary?.trim() || [
      `The user manually switched engine from ${fromEngine} to ${toEngine}.`,
      "No model-authored handoff summary was provided.",
      `Conversation context policy: ${contextPolicy}.`,
    ].join(" "),
    ...(options.recommendedNextAction ? { recommendedNextAction: options.recommendedNextAction } : {}),
    contextPolicy,
    ...(options.contextSummary ? { contextSummary: options.contextSummary } : {}),
  };
}

export function createModelEngineTransition(
  fromEngine: EngineId,
  request: EngineSwitchRequest,
  decision: Extract<EngineTransitionDecision, "confirmed" | "rejected">,
  options: EngineTransitionOptions = {},
): EngineTransition {
  const contextPolicy = options.contextPolicy ?? "preserve_full";
  return {
    source: "model_request",
    decision,
    fromEngine,
    toEngine: request.targetEngine,
    reason: request.reason,
    handoffSummary: options.handoffSummary?.trim() || request.handoffSummary,
    ...(options.recommendedNextAction ?? request.recommendedNextAction
      ? { recommendedNextAction: options.recommendedNextAction ?? request.recommendedNextAction }
      : {}),
    contextPolicy,
    ...(options.contextSummary ? { contextSummary: options.contextSummary } : {}),
  };
}

export function renderEngineHandoffPacket(transition: EngineTransition): string {
  const lines = [
    "[engine_handoff]",
    `Source: ${transition.source}`,
    `Decision: ${transition.decision}`,
    `From Engine: ${transition.fromEngine}`,
    `To Engine: ${transition.toEngine}`,
    `Context Policy: ${transition.contextPolicy}`,
    `Reason: ${boundedField(transition.reason)}`,
    "Handoff Summary:",
    boundedField(transition.handoffSummary),
  ];
  if (transition.contextSummary) {
    lines.push("Context Summary:", boundedField(transition.contextSummary));
  }
  if (transition.recommendedNextAction) {
    lines.push("Recommended Next Action:", boundedField(transition.recommendedNextAction));
  }
  lines.push("[/engine_handoff]");
  return lines.join("\n");
}

function boundedField(value: string): string {
  const normalized = value.replace(/\r\n?/g, "\n").trim();
  const maxLength = 6000;
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, maxLength - 20)}\n...[truncated]`;
}
