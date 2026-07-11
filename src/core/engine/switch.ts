import type { ToolCall, ToolDefinition } from "../tools";
import { engineIds } from "./profile";
import type { EngineId } from "./profile";

export type EngineSwitchRequest = {
  targetEngine: EngineId;
  reason: string;
  handoffSummary: string;
  recommendedNextAction?: string;
};

export function parseEngineSwitchRequest(call: ToolCall): EngineSwitchRequest {
  if (call.name !== "request_engine_switch") {
    throw new Error(`parseEngineSwitchRequest called on non-engine-switch tool: ${call.name}`);
  }
  const args = JSON.parse(call.arguments || "{}") as Partial<EngineSwitchRequest>;
  if (typeof args.targetEngine !== "string" || !(engineIds as readonly string[]).includes(args.targetEngine)) {
    throw new Error(`request_engine_switch requires targetEngine to be one of: ${engineIds.join(", ")}.`);
  }
  if (typeof args.reason !== "string" || args.reason.trim() === "") {
    throw new Error("request_engine_switch requires a non-empty `reason` string.");
  }
  if (typeof args.handoffSummary !== "string" || args.handoffSummary.trim() === "") {
    throw new Error("request_engine_switch requires a non-empty `handoffSummary` string.");
  }
  if (args.recommendedNextAction !== undefined && typeof args.recommendedNextAction !== "string") {
    throw new Error("request_engine_switch `recommendedNextAction` must be a string when provided.");
  }
  return {
    targetEngine: args.targetEngine as EngineId,
    reason: args.reason,
    handoffSummary: args.handoffSummary,
    ...(args.recommendedNextAction ? { recommendedNextAction: args.recommendedNextAction } : {}),
  };
}

export const engineSwitchToolDefinition: ToolDefinition = {
  type: "function",
  function: {
    name: "request_engine_switch",
    description:
      "Pause the workflow and ask the user to confirm switching to another Prism engine profile. Use this when a different engine should own the next workflow step. The host will not switch silently: confirmed switches take effect on future turns, while rejection is returned to the current engine so it can discuss or revise the handoff.",
    parameters: {
      type: "object",
      properties: {
        targetEngine: {
          type: "string",
          enum: [...engineIds],
          description: "The Prism engine profile that should handle future turns.",
        },
        reason: {
          type: "string",
          description: "Why this engine switch is appropriate now.",
        },
        handoffSummary: {
          type: "string",
          description:
            "Compact handoff state for the target engine: relevant artifacts, decisions, current workflow state, and what continuity must be preserved.",
        },
        recommendedNextAction: {
          type: "string",
          description: "Optional concrete next action the target engine should take after the user confirms.",
        },
      },
      required: ["targetEngine", "reason", "handoffSummary"],
      additionalProperties: false,
    },
  },
};
