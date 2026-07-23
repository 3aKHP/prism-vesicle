import type { ExperimentalQualityProfile } from "../../config/quality";
import type { VesicleMessage, VesicleResponse } from "../../providers/shared/types";
import type { EngineProfile } from "../engine/profile";
import {
  isQualityArtifactMutationCall,
  qualityModeForEngine,
  qualityRewriteFeedback,
  recordQualityEvent,
  shouldBufferQualityOutput,
  type BoundQualityEvaluation,
  type QualityDecisionPoint,
  type QualityRuntimeContext,
  type QualityTargetWarningReason,
  type QualityWarning,
} from "../quality";
import { loadSessionSnapshot, type SessionStore } from "../session/store";
import type { ToolCall } from "../tools";
import {
  durableQualityState,
  qualityDecisionCandidate,
  qualityFindingCount,
  type QualityRoundState,
} from "./quality-round-state";
import { failedToolResult, recordToolResult } from "./tool-result-recorder";
import type { AgentLoopEvent, RunPromptResult } from "./types";

export type QualityRoundRecordingContext = {
  rootDir: string;
  runtime?: QualityRuntimeContext;
  experimentalQuality?: ExperimentalQualityProfile;
  state: QualityRoundState;
  responseMessages: VesicleMessage[];
  session: SessionStore;
  profile: EngineProfile;
  model: string;
  onEvent?: (event: AgentLoopEvent) => void;
};

export async function recordQualityEvaluation(
  context: QualityRoundRecordingContext,
  result: BoundQualityEvaluation,
): Promise<void> {
  if (result.action !== "ask-user" && result.event.targets.some((target) => target.warningReason)) {
    await recordInconclusiveWarnings(context, result);
  }
  if (result.outcome !== "inconclusive") await resolveQualityWarnings(context, result);
  if (result.decision !== "rewrite") {
    await recordQualityEvent(context.session, result);
    emitQualityStatus(result, context.state, context.onEvent);
  }
}

export async function recordQualityRewriteResult(
  context: QualityRoundRecordingContext,
  result: BoundQualityEvaluation,
): Promise<void> {
  await recordQualityEvent(context.session, result);
  emitQualityStatus(result, context.state, context.onEvent);
}

export async function recordPendingQualityCheck(
  context: QualityRoundRecordingContext,
  response: VesicleResponse,
  executableCalls: ToolCall[],
): Promise<void> {
  if (!context.runtime
    || !executableCalls.some((call) => isQualityArtifactMutationCall(call, context.profile.id))
    || !isBuffered(context)) return;
  context.state.candidate = qualityDecisionCandidate(response);
  const pending = persistedQualityState(context);
  if (!pending) return;
  await context.session.append({
    role: "system",
    content: "",
    metadata: {
      kind: "quality-check-pending",
      qualityRewrite: pending,
    },
  });
}

export async function recordPostMutationQualityRewrite(
  context: QualityRoundRecordingContext,
  response: VesicleResponse,
  interactionCalls: ToolCall[],
  result: BoundQualityEvaluation,
): Promise<void> {
  context.state.candidate = qualityDecisionCandidate(response);
  const persistedState = persistedQualityState(context);
  if (!persistedState) throw new Error("Quality rewrite state is unavailable under the active Guard.");
  const feedback = qualityRewriteFeedback(result);
  for (const call of interactionCalls) {
    await recordToolResult({
      result: failedToolResult(call.id, call.name, feedback),
      messages: context.responseMessages,
      session: context.session,
      metadata: {
        kind: "quality-rewrite-feedback",
        candidateHash: result.evaluation.candidateHash,
        qualityRewrite: { ...persistedState, candidateParts: [] },
      },
      emitEvent: false,
    });
  }
}

export async function pauseForQualityDecision(
  context: QualityRoundRecordingContext,
  response: VesicleResponse,
  result: BoundQualityEvaluation,
  phase: QualityDecisionPoint["phase"],
  candidateRecorded: boolean,
): Promise<Extract<RunPromptResult, { kind: "needs_quality_decision" }>> {
  const warningTargets = result.event.targets.filter((target) =>
    target.status === "warning" && !target.warningReason
  );
  const warningId = context.state.warningId ?? `quality-warning_${crypto.randomUUID()}`;
  context.state.warningId = warningId;
  context.state.warningTargetIds = warningTargets.map((target) => target.id);
  context.state.candidate = qualityDecisionCandidate(response);
  const state = persistedQualityState(context);
  if (!state) throw new Error("Quality decision state is unavailable under the active Guard.");
  state.candidateParts = [];
  const warning: QualityWarning = {
    id: warningId,
    guard: "anti-ai-flavor",
    reason: "exhausted",
    producer: context.profile.id,
    attempt: context.state.attempts,
    targets: warningTargets,
  };
  const request = {
    id: warningId,
    reason: "exhausted" as const,
    producer: context.profile.id,
    findingCount: warningTargets.reduce((count, target) => count + target.findingIds.length, 0),
    targets: warningTargets.map((target) => ({
      id: target.id,
      ...(target.path ? { path: target.path } : {}),
      findingIds: [...target.findingIds],
    })),
    canRetry: true,
  };
  const point: QualityDecisionPoint = {
    request,
    warning,
    qualityState: state,
    candidate: context.state.candidate,
    phase,
    candidateRecorded,
  };
  await context.session.append({
    role: "system",
    content: qualityWarningText(warning),
    metadata: {
      kind: "quality-warning",
      qualityWarning: warning,
      qualityDecision: point,
    },
  });
  return {
    kind: "needs_quality_decision",
    sessionId: context.session.sessionId,
    sessionPath: context.session.sessionPath,
    profile: context.profile,
    decision: request,
    assistantContent: response.content,
    messages: context.responseMessages,
  };
}

export async function recordRejectedQualityRound(
  context: QualityRoundRecordingContext,
  response: VesicleResponse,
  result: BoundQualityEvaluation,
): Promise<void> {
  const calls = response.toolCalls ?? [];
  const persistedState = persistedQualityState(context);
  if (!persistedState) throw new Error("Quality rewrite state is unavailable under the active Guard.");
  const rewriteState = {
    ...persistedState,
    candidateParts: [],
    candidate: qualityDecisionCandidate(response),
  };
  if (calls.length > 0) {
    const feedback = qualityRewriteFeedback(result);
    const assistantMessage: VesicleMessage = { role: "assistant", content: "", toolCalls: calls };
    const toolMessages: VesicleMessage[] = calls.map((call) => ({
      role: "tool",
      toolCallId: call.id,
      content: JSON.stringify({ ok: false, result: feedback }),
    }));
    await context.session.appendMany([
      {
        role: "assistant",
        content: "",
        metadata: {
          kind: "quality-rejected-candidate",
          engine: context.profile.id,
          model: context.model,
          providerResponseId: response.id,
          candidateHash: result.evaluation.candidateHash,
          toolCalls: calls,
        },
      },
      ...calls.map((call) => ({
        role: "tool" as const,
        content: JSON.stringify({ ok: false, result: feedback }),
        metadata: {
          name: call.name,
          ok: false,
          toolCallId: call.id,
          kind: "quality-rewrite-feedback",
          candidateHash: result.evaluation.candidateHash,
          qualityRewrite: rewriteState,
        },
      })),
    ]);
    context.responseMessages.push(assistantMessage, ...toolMessages);
    return;
  }
  const feedback = qualityRewriteFeedback(result, true);
  context.responseMessages.push({ role: "user", content: feedback });
  await context.session.appendMany([{
    role: "user",
    content: feedback,
    metadata: { kind: "quality-rewrite-feedback", candidateHash: result.evaluation.candidateHash, qualityRewrite: rewriteState },
  }]);
}

function persistedQualityState(context: QualityRoundRecordingContext) {
  return durableQualityState({
    runtime: context.runtime,
    producer: context.profile.id,
    experimentalQuality: context.experimentalQuality,
    state: context.state,
    buffered: isBuffered(context),
  });
}

function isBuffered(context: QualityRoundRecordingContext): boolean {
  return shouldBufferQualityOutput(qualityModeForEngine(context.runtime, context.profile.id));
}

function emitQualityStatus(
  result: BoundQualityEvaluation,
  state: QualityRoundState,
  onEvent?: (event: AgentLoopEvent) => void,
): void {
  onEvent?.({
    type: "quality_status",
    phase: result.action === "rewrite" ? "rewriting"
      : result.action === "ask-user" ? "exhausted"
        : result.outcome === "inconclusive" ? "inconclusive"
          : result.action === "observe" ? "observed"
            : result.outcome === "findings" ? "findings"
              : "clean",
    attempt: state.attempts,
    findingCount: qualityFindingCount(result),
    findings: result.event.targets.flatMap((target) => target.findings.map((finding) => ({
      ...finding,
      ...(target.path ? { targetPath: target.path } : {}),
    }))).slice(0, 8),
    warningReasons: [...new Set(result.event.targets.flatMap((target) =>
      target.warningReason ? [target.warningReason] : []
    ))],
  });
}

async function resolveQualityWarnings(
  context: QualityRoundRecordingContext,
  result: BoundQualityEvaluation,
): Promise<void> {
  const snapshot = await loadSessionSnapshot(context.rootDir, context.session.sessionId, {
    synthesizeDanglingToolResults: false,
  });
  const cleanTargetIds = new Set(result.event.targets
    .filter((target) => target.status === "clean" || target.status === "findings")
    .map((target) => target.id));
  for (const warning of snapshot.qualityWarnings) {
    const targetIds = warning.targets
      .filter((target) => cleanTargetIds.has(target.id)
        || (warning.id === context.state.warningId
          && target.kind === "assistant-response"
          && (result.outcome === "clean" || result.outcome === "findings")))
      .map((target) => target.id);
    if (targetIds.length === 0) continue;
    await context.session.append({
      role: "system",
      content: "",
      metadata: {
        kind: "quality-resolution",
        qualityResolution: {
          warningId: warning.id,
          resolution: "revised-clean",
          targetIds,
        },
      },
    });
  }
}

async function recordInconclusiveWarnings(
  context: QualityRoundRecordingContext,
  result: BoundQualityEvaluation,
): Promise<void> {
  const snapshot = await loadSessionSnapshot(context.rootDir, context.session.sessionId, {
    synthesizeDanglingToolResults: false,
  });
  let reusedPendingWarning = false;
  for (const reason of [
    "target-unreadable", "target-oversize", "detector-budget-exhausted",
    "judge-invalid", "judge-timeout", "judge-unavailable",
  ] as const) {
    const existing = new Set(snapshot.qualityWarnings
      .filter((warning) => warning.id !== context.state.warningId && warning.reason === reason)
      .flatMap((warning) => warning.targets.map((target) => target.id)));
    const targets = result.event.targets.filter((target) =>
      target.warningReason === reason
      && !existing.has(target.id)
    );
    if (targets.length === 0) continue;
    const warning: QualityWarning = {
      id: context.state.warningId && !reusedPendingWarning
        ? context.state.warningId
        : `quality-warning_${crypto.randomUUID()}`,
      guard: "anti-ai-flavor",
      reason,
      producer: context.profile.id,
      attempt: result.event.attempt,
      targets,
    };
    await context.session.append({
      role: "system",
      content: inconclusiveWarningText(reason, targets.length),
      metadata: { kind: "quality-warning", qualityWarning: warning },
    });
    if (warning.id === context.state.warningId) reusedPendingWarning = true;
  }
  if (reusedPendingWarning && context.state.warningId) {
    await context.session.append({
      role: "system",
      content: "",
      metadata: { kind: "quality-check-cleared", warningId: context.state.warningId },
    });
  } else if (context.state.warningId) {
    const pendingWarning = snapshot.qualityWarnings.find((warning) => warning.id === context.state.warningId);
    const unresolvedTargetIds = new Set(result.event.targets
      .filter((target) => target.status === "warning")
      .map((target) => target.id));
    const resolvedTargetIds = pendingWarning?.targets
      .filter((target) => !unresolvedTargetIds.has(target.id))
      .map((target) => target.id) ?? [];
    await context.session.appendMany([
      ...(resolvedTargetIds.length > 0 ? [{
        role: "system" as const,
        content: "",
        metadata: {
          kind: "quality-resolution",
          qualityResolution: {
            warningId: context.state.warningId,
            resolution: "revised-clean",
            targetIds: resolvedTargetIds,
          },
        },
      }] : []),
      {
        role: "system",
        content: "",
        metadata: { kind: "quality-check-cleared", warningId: context.state.warningId },
      },
    ]);
  }
}

function qualityWarningText(warning: QualityWarning): string {
  const paths = warning.targets.flatMap((target) => target.path ? [target.path] : []);
  const findings = [...new Set(warning.targets.flatMap((target) => target.findingIds))];
  return [
    `Automatic quality revision is exhausted with ${findings.length} blocking finding${findings.length === 1 ? "" : "s"}.`,
    ...(paths.length > 0 ? [`Targets: ${paths.join(", ")}.`] : []),
    `Rules: ${findings.join(", ") || "unknown"}.`,
    "The current version has not been confirmed clean. Choose another revision, use it with the warning, or stop.",
  ].join(" ");
}

function inconclusiveWarningText(reason: QualityTargetWarningReason, targetCount: number): string {
  const detail = reason === "target-oversize"
    ? "over the quality check size limit"
    : reason === "detector-budget-exhausted"
      ? "over the deterministic check work limit"
      : reason === "judge-invalid"
        ? "returned an invalid Semantic Judge result"
        : reason === "judge-timeout"
          ? "not checked before the Semantic Judge timeout"
          : reason === "judge-unavailable"
            ? "not checked because the Semantic Judge provider was unavailable"
            : "not readable as a guarded UTF-8 file";
  return `${targetCount} quality target${targetCount === 1 ? " was" : "s were"} ${detail}. The content was delivered without a clean quality result.`;
}
