import type { RunPromptResult } from "../core/agent-loop/run";
import type { EngineId } from "../core/engine/profile";
import type { EngineSwitchRequest } from "../core/engine/switch";
import type { GateRequest, GateResolution } from "../core/gate/types";
import type { PermissionResolution } from "../core/permissions";
import type { UserQuestionAnswer } from "../core/user-question/types";

type PendingGate = Extract<RunPromptResult, { kind: "needs_user" }>;

export type PendingGateState = Omit<PendingGate, "profile"> & {
  engine: EngineId;
  profile?: PendingGate["profile"];
};

type PendingEngineSwitch = Extract<RunPromptResult, { kind: "needs_engine_switch" }>;

export type PendingEngineSwitchState = Omit<PendingEngineSwitch, "profile"> & {
  profile?: PendingEngineSwitch["profile"];
};

type PendingUserQuestion = Extract<RunPromptResult, { kind: "needs_user_question" }>;

export type PendingUserQuestionState = Omit<PendingUserQuestion, "profile"> & {
  engine: EngineId;
  profile?: PendingUserQuestion["profile"];
};

type PendingPermission = Extract<RunPromptResult, { kind: "needs_permission" }>;

export type PendingPermissionState = Omit<PendingPermission, "profile"> & {
  engine: EngineId;
  profile?: PendingPermission["profile"];
};

type PendingQualityDecision = Extract<RunPromptResult, { kind: "needs_quality_decision" }>;

export type PendingQualityDecisionState = Omit<PendingQualityDecision, "profile"> & {
  engine: EngineId;
  profile?: PendingQualityDecision["profile"];
};

export type TuiKeyEvent = {
  name?: string;
  ctrl?: boolean;
  shift?: boolean;
  meta?: boolean;
  option?: boolean;
  sequence?: string;
  raw?: string;
  preventDefault?: () => void;
  stopPropagation?: () => void;
};

export function engineSwitchGateRequest(currentEngine: EngineId, request: EngineSwitchRequest): GateRequest {
  const lines = [
    `Current Engine: ${currentEngine}`,
    `Target Engine: ${request.targetEngine}`,
    "",
    `Reason: ${request.reason}`,
    "",
    `Handoff Summary: ${request.handoffSummary}`,
  ];
  if (request.recommendedNextAction) {
    lines.push("", `Recommended Next Action: ${request.recommendedNextAction}`);
  }
  return {
    gate: "engine-switch",
    summary: lines.join("\n"),
    options: [
      { label: `Confirm - switch to ${request.targetEngine}`, decision: "confirm" },
      { label: `Reject - stay on ${currentEngine} and discuss`, decision: "reject" },
    ],
  };
}

export function permissionResolutionFromGate(resolution: GateResolution): PermissionResolution {
  const resolvedAt = new Date().toISOString();
  return resolution.decision === "confirm"
    ? { decision: "allow_once", resolvedAt }
    : {
        decision: "reject",
        resolvedAt,
        ...(resolution.feedback ? { feedback: resolution.feedback } : {}),
      };
}

export function displayUserQuestionAnswer(header: string, answer: UserQuestionAnswer): string {
  if (answer.kind === "skip") return `[question:${header}] skipped`;
  if (answer.kind === "freeform") return `[question:${header}] ${answer.freeformText ?? answer.label}`;
  return `[question:${header}] ${answer.label}`;
}
