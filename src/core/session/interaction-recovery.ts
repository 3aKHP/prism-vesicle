import { parseEngineSwitchRequest, type EngineSwitchRequest } from "../engine/switch";
import { parseGateRequest, type GateRequest } from "../gate/types";
import { parseHarnessDelegationDecision, type HarnessDelegationDecision } from "../harness/driver";
import { parsePermissionRequest, type PermissionRequest } from "../permissions";
import { parseUserQuestionRequest, type UserQuestionRequest } from "../user-question/types";
import type { ResumedToolCall, SessionRecord } from "./record-model";

export type PendingDelegationRetry = {
  intentId: string;
  interactionId: string;
  failedRunId: string;
  delegationId: string;
  attempt: number;
  retryCallId: string;
};

export type SessionInteractionRecovery = {
  pendingGate?: { gate: GateRequest; toolCallId: string; assistantContent: string };
  pendingEngineSwitch?: { request: EngineSwitchRequest; toolCallId: string; assistantContent: string };
  pendingUserQuestion?: {
    question: UserQuestionRequest;
    toolCallId: string;
    assistantContent: string;
    delegationDecision?: HarnessDelegationDecision;
  };
  pendingPermission?: PermissionRequest;
  pendingDelegationRetry?: PendingDelegationRetry;
  pendingDelegationDecisionRecovery?: HarnessDelegationDecision;
};

export function recoverSessionInteractions(records: SessionRecord[]): SessionInteractionRecovery {
  const answeredToolCallIds = new Set(records.flatMap((record) =>
    record.role === "tool" && typeof record.metadata?.toolCallId === "string"
      ? [record.metadata.toolCallId]
      : []
  ));
  return {
    ...recoverPendingToolCalls(records, answeredToolCallIds),
    ...recoverPendingPermission(records),
    ...recoverPendingDelegationRetry(records, answeredToolCallIds),
    ...recoverPendingDelegationDecision(records),
  };
}

function recoverPendingToolCalls(
  records: SessionRecord[],
  answeredToolCallIds: Set<string>,
): Pick<SessionInteractionRecovery, "pendingGate" | "pendingEngineSwitch" | "pendingUserQuestion"> {
  const record = [...records].reverse().find((candidate) => candidate.role === "assistant");
  if (!record) return {};
  const toolCalls = record.metadata?.toolCalls as ResumedToolCall[] | undefined;
  const gateCall = toolCalls?.find((call) => call.name === "request_confirmation" && !answeredToolCallIds.has(call.id));
  const switchCall = toolCalls?.find((call) => call.name === "request_engine_switch" && !answeredToolCallIds.has(call.id));
  const questionCall = toolCalls?.find((call) => call.name === "ask_user_question" && !answeredToolCallIds.has(call.id));
  let pendingGate: SessionInteractionRecovery["pendingGate"];
  let pendingEngineSwitch: SessionInteractionRecovery["pendingEngineSwitch"];
  let pendingUserQuestion: SessionInteractionRecovery["pendingUserQuestion"];
  try {
    if (gateCall) pendingGate = { gate: parseGateRequest(gateCall), toolCallId: gateCall.id, assistantContent: record.content };
  } catch {
    // Malformed pending calls cannot be restored as host interactions.
  }
  try {
    if (switchCall) pendingEngineSwitch = { request: parseEngineSwitchRequest(switchCall), toolCallId: switchCall.id, assistantContent: record.content };
  } catch {
    // Malformed pending calls cannot be restored as host interactions.
  }
  try {
    if (questionCall) {
      const delegationDecision = record.metadata?.kind === "delegation-decision-point"
        ? parseHarnessDelegationDecision(record.metadata.decision)
        : undefined;
      pendingUserQuestion = {
        question: delegationDecision?.question ?? parseUserQuestionRequest(questionCall),
        toolCallId: questionCall.id,
        assistantContent: record.content,
        ...(delegationDecision ? { delegationDecision } : {}),
      };
    }
  } catch {
    // Malformed pending calls cannot be restored as host interactions.
  }
  return {
    ...(pendingGate ? { pendingGate } : {}),
    ...(pendingEngineSwitch ? { pendingEngineSwitch } : {}),
    ...(pendingUserQuestion ? { pendingUserQuestion } : {}),
  };
}

function recoverPendingPermission(records: SessionRecord[]): Pick<SessionInteractionRecovery, "pendingPermission"> {
  const resolved = new Set<string>();
  for (const record of records) {
    if (record.metadata?.kind !== "permission-resolution") continue;
    const requestId = record.metadata.requestId;
    if (typeof requestId === "string") resolved.add(requestId);
  }
  for (let index = records.length - 1; index >= 0; index--) {
    const record = records[index];
    if (record.metadata?.kind !== "permission-request") continue;
    const request = parsePermissionRequest(record.metadata.request);
    if (request && !resolved.has(request.id)) return { pendingPermission: request };
  }
  return {};
}

function recoverPendingDelegationRetry(
  records: SessionRecord[],
  answeredToolCallIds: Set<string>,
): Pick<SessionInteractionRecovery, "pendingDelegationRetry"> {
  const intents = new Map<string, PendingDelegationRetry>();
  const authorized = new Set<string>();
  for (const record of records) {
    if (record.metadata?.kind === "delegation-retry-intent") {
      const intent = parsePendingDelegationRetry(record.metadata.retryIntent);
      if (intent) intents.set(intent.intentId, intent);
    }
    const retryIntentId = record.metadata?.retryIntentId;
    if (typeof retryIntentId !== "string") continue;
    if (record.metadata?.kind === "delegation-decision-resolution" && record.metadata.optionId === "retry") {
      authorized.add(retryIntentId);
    }
  }
  const pending = [...intents.values()].reverse().find((intent) =>
    authorized.has(intent.intentId) && !answeredToolCallIds.has(intent.retryCallId)
  );
  return pending ? { pendingDelegationRetry: pending } : {};
}

function recoverPendingDelegationDecision(
  records: SessionRecord[],
): Pick<SessionInteractionRecovery, "pendingDelegationDecisionRecovery"> {
  const persisted = new Map<string, HarnessDelegationDecision>();
  const restored = new Set<string>();
  for (const record of records) {
    if (record.role === "tool" && record.metadata?.delegationDecision) {
      try {
        const decision = parseHarnessDelegationDecision(record.metadata.delegationDecision);
        persisted.set(decision.failed.runId, decision);
      } catch {
        // Invalid host metadata cannot be restored as an executable decision.
      }
    }
    if (record.role === "assistant" && record.metadata?.kind === "delegation-decision-point") {
      try {
        restored.add(parseHarnessDelegationDecision(record.metadata.decision).failed.runId);
      } catch {
        // The malformed decision point remains unusable and does not mask recovery.
      }
    }
  }
  const pending = [...persisted.values()].reverse().find((decision) => !restored.has(decision.failed.runId));
  return pending ? { pendingDelegationDecisionRecovery: pending } : {};
}

function parsePendingDelegationRetry(value: unknown): PendingDelegationRetry | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const source = value as Record<string, unknown>;
  if (typeof source.id !== "string"
    || typeof source.interactionId !== "string"
    || typeof source.failedRunId !== "string"
    || typeof source.delegationId !== "string"
    || !Number.isInteger(source.attempt)
    || Number(source.attempt) < 1
    || typeof source.retryCallId !== "string") return undefined;
  return {
    intentId: source.id,
    interactionId: source.interactionId,
    failedRunId: source.failedRunId,
    delegationId: source.delegationId,
    attempt: Number(source.attempt),
    retryCallId: source.retryCallId,
  };
}
