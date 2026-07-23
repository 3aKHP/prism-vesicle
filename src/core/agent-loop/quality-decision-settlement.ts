import type { VesicleMessage } from "../../providers/shared/types";
import {
  type QualityDecisionPoint,
  type QualityEvent,
  type QualityWarning,
} from "../quality";
import {
  createSessionStore,
  loadSessionSnapshot,
  type SessionSnapshot,
  type SessionStore,
} from "../session/store";
import {
  assertExperimentalJudgeIdentity,
  assertQualityIdentity,
  hydrateQualityState,
  runQualityContinuation,
  toVesicleMessage,
  type QualityContinuationOptions,
} from "./quality-continuation-bootstrap";
import { loadContinuationContext } from "./continuation-context";
import type { QualityDecisionResolution, RunPromptResult } from "./types";

export async function retryQualityDecision(
  options: QualityContinuationOptions,
  point: QualityDecisionPoint,
): Promise<RunPromptResult> {
  const context = await loadContinuationContext(options);
  assertQualityIdentity(context.harness?.quality, point.qualityState);
  assertExperimentalJudgeIdentity(context.experimentalQuality, point.qualityState.experimentalJudge);
  const snapshot = await loadSessionSnapshot(context.rootDir, options.sessionId, {
    synthesizeDanglingToolResults: false,
  });
  const messages = snapshot.messages.map(toVesicleMessage);
  const feedback = qualityDecisionFeedback(point);
  await context.session.append({
    role: "system",
    content: "",
    metadata: {
      kind: "quality-retry-intent",
      warningId: point.warning.id,
      attempt: point.qualityState.attempts + 1,
    },
  });
  if (point.phase === "before-mutations") {
    await appendRejectedCandidate(context.session, messages, snapshot, point, feedback);
  } else {
    await appendFeedbackForUnansweredCalls(context.session, messages, snapshot, point, feedback);
  }
  return runQualityContinuation({
    options,
    context,
    messages,
    qualityState: hydrateQualityState(point.qualityState, {
      warningId: point.warning.id,
      warningTargetIds: point.warning.targets.map((target) => target.id),
      candidate: point.candidate,
    }),
  });
}

export async function settleQualityDecision(
  rootDir: string,
  sessionId: string,
  snapshot: SessionSnapshot,
  point: QualityDecisionPoint,
  resolution: Exclude<QualityDecisionResolution, "retry">,
): Promise<void> {
  const session = await createSessionStore(rootDir, sessionId);
  const records: Parameters<typeof session.appendMany>[0] = [];
  if (resolution === "accept") {
    records.push(...acceptedCandidateRecords(point));
  } else if (point.candidateRecorded || point.candidate.toolCalls.length > 0) {
    if (!point.candidateRecorded) {
      const candidate = assistantCandidateRecord(point.candidate);
      records.push({
        ...candidate,
        metadata: {
          ...candidate.metadata,
          kind: "quality-rejected-candidate",
          engine: point.request.producer,
          warningId: point.warning.id,
        },
      });
    }
    records.push(...unansweredCandidateResults(snapshot, point, "Quality decision stopped by the user."));
  }
  records.push(
    qualityResolutionRecord(point.warning, resolution),
    { role: "system", content: "", metadata: { kind: "quality-check-cleared", warningId: point.warning.id } },
  );
  await session.appendMany(records);
}

export async function settleInterruptedQualityRewrite(
  rootDir: string,
  sessionId: string,
  snapshot: SessionSnapshot,
  resolution: Exclude<QualityDecisionResolution, "retry">,
): Promise<void> {
  const pending = snapshot.pendingQualityRewrite!;
  const lastEvent = [...snapshot.qualityEvents].reverse().find((event) => event.producer === pending.producer);
  const warning = interruptedWarning(pending.producer, pending.attempts, lastEvent, pending.targets);
  const session = await createSessionStore(rootDir, sessionId);
  const records: Parameters<typeof session.appendMany>[0] = [{
    role: "system",
    content: "The interrupted automatic quality revision was ended by the user. The current version remains unconfirmed.",
    metadata: { kind: "quality-warning", qualityWarning: warning },
  }];
  if (pending.candidate) {
    records.push(...settledInterruptedCandidateRecords(snapshot, pending.candidate, resolution));
  }
  records.push(
    qualityResolutionRecord(warning, resolution),
    { role: "system", content: "", metadata: { kind: "quality-check-cleared", warningId: warning.id } },
  );
  await session.appendMany(records);
}

async function appendRejectedCandidate(
  session: SessionStore,
  messages: VesicleMessage[],
  snapshot: SessionSnapshot,
  point: QualityDecisionPoint,
  feedback: string,
): Promise<void> {
  const calls = point.candidate.toolCalls;
  if (calls.length === 0) {
    messages.push({ role: "user", content: feedback });
    await session.append({
      role: "user",
      content: feedback,
      metadata: { kind: "quality-rewrite-feedback", warningId: point.warning.id, qualityRewrite: point.qualityState },
    });
    return;
  }
  const recordedAssistantCalls = durableAssistantCallIds(snapshot);
  const answered = durableAnsweredCallIds(snapshot);
  const records: Parameters<typeof session.appendMany>[0] = [];
  if (!calls.every((call) => recordedAssistantCalls.has(call.id))) {
    messages.push({ role: "assistant", content: point.candidate.content, toolCalls: calls });
    records.push({
      role: "assistant",
      content: point.candidate.content,
      metadata: {
        kind: "quality-rejected-candidate",
        engine: point.request.producer,
        providerResponseId: point.candidate.responseId,
        warningId: point.warning.id,
        toolCalls: calls,
      },
    });
  }
  for (const call of calls.filter((candidate) => !answered.has(candidate.id))) {
    setInMemoryToolResult(messages, call.id, feedback);
    records.push({
      role: "tool" as const,
      content: JSON.stringify({ ok: false, result: feedback }),
      metadata: {
        kind: "quality-rewrite-feedback",
        name: call.name,
        ok: false,
        toolCallId: call.id,
        warningId: point.warning.id,
        qualityRewrite: point.qualityState,
      },
    });
  }
  await session.appendMany(records);
}

async function appendFeedbackForUnansweredCalls(
  session: SessionStore,
  messages: VesicleMessage[],
  snapshot: SessionSnapshot,
  point: QualityDecisionPoint,
  feedback: string,
): Promise<void> {
  const answered = durableAnsweredCallIds(snapshot);
  const calls = point.candidate.toolCalls.filter((call) => !answered.has(call.id));
  if (calls.length === 0) {
    messages.push({ role: "user", content: feedback });
    await session.append({
      role: "user",
      content: feedback,
      metadata: { kind: "quality-rewrite-feedback", warningId: point.warning.id, qualityRewrite: point.qualityState },
    });
    return;
  }
  for (const call of calls) setInMemoryToolResult(messages, call.id, feedback);
  await session.appendMany(calls.map((call) => ({
    role: "tool" as const,
    content: JSON.stringify({ ok: false, result: feedback }),
    metadata: {
      kind: "quality-rewrite-feedback",
      name: call.name,
      ok: false,
      toolCallId: call.id,
      warningId: point.warning.id,
      qualityRewrite: point.qualityState,
    },
  })));
}

function acceptedCandidateRecords(point: QualityDecisionPoint): Parameters<SessionStore["appendMany"]>[0] {
  const records: Parameters<SessionStore["appendMany"]>[0] = [];
  if (!point.candidateRecorded) records.push(assistantCandidateRecord(point.candidate));
  if (point.phase === "before-mutations") {
    for (const call of point.candidate.toolCalls) {
      if (isDeferredInteractionCall(call.name)) continue;
      records.push({
        role: "tool",
        content: JSON.stringify({ ok: false, result: "Tool was not executed while a quality decision was pending. Retry it after the interaction." }),
        metadata: { kind: "quality-decision-deferred-tool", name: call.name, ok: false, toolCallId: call.id },
      });
    }
  }
  return records;
}

function unansweredCandidateResults(
  snapshot: SessionSnapshot,
  point: QualityDecisionPoint,
  message: string,
): Parameters<SessionStore["appendMany"]>[0] {
  const answered = durableAnsweredCallIds(snapshot);
  return point.candidate.toolCalls.filter((call) => !answered.has(call.id)).map((call) => ({
    role: "tool" as const,
    content: JSON.stringify({ ok: false, result: message }),
    metadata: { kind: "quality-decision-stopped-tool", name: call.name, ok: false, toolCallId: call.id },
  }));
}

function settledInterruptedCandidateRecords(
  snapshot: SessionSnapshot,
  candidate: QualityDecisionPoint["candidate"],
  resolution: Exclude<QualityDecisionResolution, "retry">,
): Parameters<SessionStore["appendMany"]>[0] {
  const records: Parameters<SessionStore["appendMany"]>[0] = [];
  const recordedAssistantCalls = durableAssistantCallIds(snapshot);
  const candidateRecorded = candidate.toolCalls.length > 0
    ? candidate.toolCalls.every((call) => recordedAssistantCalls.has(call.id))
    : snapshot.records.some((record) => record.role === "assistant"
      && record.metadata?.providerResponseId === candidate.responseId);
  if (resolution === "accept" && !candidateRecorded && (candidate.content.trim() || candidate.toolCalls.length > 0)) {
    records.push(assistantCandidateRecord(candidate));
  }
  const answered = durableAnsweredCallIds(snapshot);
  for (const call of candidate.toolCalls) {
    if (answered.has(call.id) || (resolution === "accept" && isDeferredInteractionCall(call.name))) continue;
    records.push({
      role: "tool",
      content: JSON.stringify({
        ok: false,
        result: resolution === "accept"
          ? "Tool was not executed while a quality decision was pending. Retry it after the interaction."
          : "Quality decision stopped by the user.",
      }),
      metadata: {
        kind: resolution === "accept" ? "quality-decision-deferred-tool" : "quality-decision-stopped-tool",
        name: call.name,
        ok: false,
        toolCallId: call.id,
      },
    });
  }
  return records;
}

function durableAnsweredCallIds(snapshot: SessionSnapshot): Set<string> {
  return new Set(snapshot.records.flatMap((record) =>
    record.role === "tool" && typeof record.metadata?.toolCallId === "string"
      ? [record.metadata.toolCallId]
      : []
  ));
}

function durableAssistantCallIds(snapshot: SessionSnapshot): Set<string> {
  return new Set(snapshot.records.flatMap((record) => {
    if (record.role !== "assistant" || !Array.isArray(record.metadata?.toolCalls)) return [];
    return (record.metadata.toolCalls as Array<{ id?: unknown }>).flatMap((call) =>
      typeof call.id === "string" ? [call.id] : []
    );
  }));
}

function setInMemoryToolResult(messages: VesicleMessage[], toolCallId: string, feedback: string): void {
  const content = JSON.stringify({ ok: false, result: feedback });
  const existing = messages.find((message) => message.role === "tool" && message.toolCallId === toolCallId);
  if (existing) existing.content = content;
  else messages.push({ role: "tool", toolCallId, content });
}

function isDeferredInteractionCall(name: string): boolean {
  return name === "request_confirmation" || name === "ask_user_question" || name === "request_engine_switch";
}

function assistantCandidateRecord(candidate: QualityDecisionPoint["candidate"]) {
  return {
    role: "assistant" as const,
    content: candidate.content,
    metadata: {
      providerResponseId: candidate.responseId,
      ...(candidate.reasoningContent ? { reasoningContent: candidate.reasoningContent } : {}),
      ...(candidate.thinkingBlocks ? { thinkingBlocks: candidate.thinkingBlocks } : {}),
      ...(candidate.usage ? { usage: candidate.usage } : {}),
      ...(candidate.toolCalls.length > 0 ? { toolCalls: candidate.toolCalls } : {}),
    },
  };
}

function qualityResolutionRecord(
  warning: QualityWarning,
  resolution: Exclude<QualityDecisionResolution, "retry">,
) {
  const value = resolution === "accept" ? "accepted-by-user" : "stopped-by-user";
  return {
    role: "system" as const,
    content: resolution === "accept"
      ? "User chose to use the current version with its quality warning."
      : "User stopped this quality revision without further provider work.",
    metadata: {
      kind: "quality-resolution",
      qualityResolution: {
        warningId: warning.id,
        resolution: value,
        targetIds: warning.targets.map((target) => target.id),
      },
    },
  };
}

function interruptedWarning(
  producer: QualityWarning["producer"],
  attempt: number,
  event: QualityEvent | undefined,
  artifactTargets: Array<{ id: string; path: string; postImageHash: string; bytes: number }>,
): QualityWarning {
  const eventTargets = event?.targets.filter((target) => target.status === "rewrite-required" || target.status === "warning") ?? [];
  const targets: QualityWarning["targets"] = eventTargets.length > 0 ? eventTargets.map((target) => ({ ...target, status: "warning" as const }))
    : artifactTargets.map((target) => ({
        id: target.id,
        kind: "artifact-post-image" as const,
        path: target.path,
        candidateHash: target.postImageHash,
        bytes: target.bytes,
        status: "warning" as const,
        findingIds: event?.findingIds ?? [],
        findings: [],
      }));
  if (targets.length === 0 && event) {
    targets.push({
      id: `assistant:${event.candidateHash}`,
      kind: "assistant-response",
      candidateHash: event.candidateHash,
      status: "warning",
      findingIds: event.findingIds,
      findings: [],
    });
  }
  return {
    id: `quality-warning_${crypto.randomUUID()}`,
    guard: "anti-ai-flavor",
    reason: "user-abandoned",
    producer,
    attempt,
    targets,
  };
}

function qualityDecisionFeedback(point: QualityDecisionPoint): string {
  return JSON.stringify({
    category: "quality_rewrite_required",
    guard: "anti-ai-flavor",
    userAuthorizedAttempt: point.qualityState.attempts + 1,
    targets: point.warning.targets.map((target) => ({
      targetId: target.id,
      ...(target.path ? { path: target.path } : {}),
      findings: target.findings.map((finding) => ({
        ruleId: finding.ruleId,
        evidence: finding.evidence,
        instruction: "Rewrite the affected prose while preserving facts, point of view, character logic, beats, required format, and target paths.",
      })),
    })),
  });
}
