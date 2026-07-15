import type { VesicleMessage } from "../../providers/shared/types";
import type { EngineProfile } from "../engine/profile";
import { parseEngineSwitchRequest } from "../engine/switch";
import { parseGateRequest } from "../gate/types";
import { createPermissionRequest } from "../permissions";
import type { PermissionRuntimeOptions } from "../permissions";
import type { SessionStore } from "../session/store";
import type { ToolCall } from "../tools";
import { parseUserQuestionRequest } from "../user-question/types";
import type { AgentLoopEvent, RunPromptResult } from "./types";
import type { DurableQualityState } from "../quality";
import type { ToolRoundPlan } from "./tool-round-planner";
import { failedToolResult, recordToolResult } from "./tool-result-recorder";

type ResolveInteractionPauseOptions = {
  plan: ToolRoundPlan;
  messages: VesicleMessage[];
  session: SessionStore;
  profile: EngineProfile;
  assistantContent: string;
  permission: PermissionRuntimeOptions;
  onEvent?: (event: AgentLoopEvent) => void;
  qualityState?: DurableQualityState;
};

type PauseResolution = { result?: RunPromptResult; anyFailed: boolean };

export async function resolveInteractionPause(
  options: ResolveInteractionPauseOptions,
): Promise<PauseResolution> {
  if (options.plan.permissionRequiredCalls.length > 0) return pauseForPermission(options);
  if (options.plan.interactiveCalls.length === 0) return { anyFailed: false };

  const [primary, ...extras] = options.plan.interactiveCalls;
  await recordRedirects(
    options,
    extras,
    "Only one interactive request may be open at a time. The primary request is pending user resolution.",
    "extra-interactive-redirect",
  );
  return resolvePrimaryInteraction(options, primary);
}

async function pauseForPermission(options: ResolveInteractionPauseOptions): Promise<PauseResolution> {
  await recordRedirects(
    options,
    options.plan.interactiveCalls,
    "A tool permission request is pending. Retry this interactive request after the permission-controlled tool round completes.",
    "permission-pending-redirect",
  );
  const [primary, ...remainingToolCalls] = options.plan.permissionRequiredCalls;
  const request = {
    ...createPermissionRequest(
      options.session.sessionId,
      primary,
      options.permission.mode,
      options.permission.shellInterpreter,
    ),
    ...(options.qualityState ? { qualityState: options.qualityState } : {}),
  };
  await options.session.append({
    role: "system",
    content: `Permission required for ${primary.name}.`,
    metadata: { kind: "permission-request", request },
  });
  options.onEvent?.({ type: "permission_pending", request });
  return {
    anyFailed: false,
    result: {
      kind: "needs_permission",
      sessionId: options.session.sessionId,
      sessionPath: options.session.sessionPath,
      profile: options.profile,
      request,
      remainingToolCalls,
      assistantContent: options.assistantContent,
      messages: options.messages,
    },
  };
}

function resolvePrimaryInteraction(
  options: ResolveInteractionPauseOptions,
  primary: ToolCall,
): Promise<PauseResolution> | PauseResolution {
  if (primary.name === "request_engine_switch") return pauseForEngineSwitch(options, primary);
  if (primary.name === "ask_user_question") return pauseForUserQuestion(options, primary);
  return pauseForGate(options, primary);
}

function pauseForEngineSwitch(options: ResolveInteractionPauseOptions, primary: ToolCall): PauseResolution {
  const request = parseEngineSwitchRequest(primary);
  options.onEvent?.({ type: "engine_switch_pending", targetEngine: request.targetEngine });
  return {
    anyFailed: false,
    result: {
      kind: "needs_engine_switch",
      sessionId: options.session.sessionId,
      sessionPath: options.session.sessionPath,
      profile: options.profile,
      request,
      toolCallId: primary.id,
      assistantContent: options.assistantContent,
      messages: options.messages,
    },
  };
}

function pauseForUserQuestion(options: ResolveInteractionPauseOptions, primary: ToolCall): PauseResolution {
  const question = parseUserQuestionRequest(primary);
  options.onEvent?.({ type: "user_question_pending", header: question.header });
  return {
    anyFailed: false,
    result: {
      kind: "needs_user_question",
      sessionId: options.session.sessionId,
      sessionPath: options.session.sessionPath,
      profile: options.profile,
      question,
      toolCallId: primary.id,
      assistantContent: options.assistantContent,
      messages: options.messages,
    },
  };
}

async function pauseForGate(options: ResolveInteractionPauseOptions, primary: ToolCall): Promise<PauseResolution> {
  const gate = parseGateRequest(primary);
  if (options.profile.stopGates.includes(gate.gate)) {
    options.onEvent?.({ type: "gate_pending", gate: gate.gate });
    return {
      anyFailed: false,
      result: {
        kind: "needs_user",
        sessionId: options.session.sessionId,
        sessionPath: options.session.sessionPath,
        profile: options.profile,
        gate,
        toolCallId: primary.id,
        assistantContent: options.assistantContent,
        messages: options.messages,
      },
    };
  }
  await recordToolResult({
    result: failedToolResult(
      primary.id,
      primary.name,
      `Gate "${gate.gate}" is not declared by engine "${options.profile.id}". Declared gates: ${options.profile.stopGates.join(", ") || "(none)"}.`,
    ),
    messages: options.messages,
    session: options.session,
    metadata: { reason: "undeclared-gate" },
    emitEvent: false,
  });
  return { anyFailed: true };
}

async function recordRedirects(
  options: ResolveInteractionPauseOptions,
  calls: ToolCall[],
  content: string,
  reason: string,
): Promise<void> {
  for (const call of calls) {
    await recordToolResult({
      result: failedToolResult(call.id, call.name, content),
      messages: options.messages,
      session: options.session,
      metadata: { reason },
      emitEvent: false,
    });
  }
}
