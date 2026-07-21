import type { VesicleMessage } from "../../providers/shared/types";
import type { AgentManager } from "../agents/manager";
import { FileCheckpointManager } from "../checkpoints/file-history";
import type { ToolPermissionBroker } from "../permissions";
import { createSessionStore, loadSessionSnapshot } from "../session/store";
import {
  assertSessionHarnessIdentity,
  requireProjectHarnessRuntime,
  resolveProjectHarnessRuntime,
} from "../harness/activation";
import type { ContinuationContextOptions } from "./continuation-context";
import { loadContinuationContext } from "./continuation-context";
import { runLoop } from "./turn-loop";
import {
  durableQualityTargets,
  evaluateBoundQualityTargets,
  hydrateQualityTargets,
  qualityModeForEngine,
  readQualityArtifactTargets,
  recordQualityEvent,
  type QualityDecisionPoint,
  type QualityEvent,
  type QualityRuntimeContext,
  type QualityWarning,
} from "../quality";
import type {
  AgentLoopEvent,
  QualityDecisionResolution,
  ResolveQualityDecisionResult,
  RunPromptResult,
} from "./types";

type ResumeQualityRewriteOptions = ContinuationContextOptions & {
  permissionBroker?: ToolPermissionBroker;
  signal?: AbortSignal;
  onEvent?: (event: AgentLoopEvent) => void;
  agentManager?: AgentManager;
};

type ResolveQualityDecisionOptions = ResumeQualityRewriteOptions & {
  resolution: QualityDecisionResolution;
};

export async function resumeQualityRewrite(options: ResumeQualityRewriteOptions): Promise<RunPromptResult> {
  const snapshot = await loadSessionSnapshot(options.rootDir ?? process.cwd(), options.sessionId, {
    synthesizeDanglingToolResults: false,
  });
  const pending = snapshot.pendingQualityRewrite;
  if (!pending) throw new Error("Session does not have a pending Output Quality Guard rewrite.");
  if (snapshot.pendingPermission) {
    throw new Error("Pending tool permission must be resolved before the Output Quality Guard rewrite can continue.");
  }
  if (pending.producer !== options.engine) throw new Error("Pending quality rewrite Engine does not match the requested continuation.");
  const context = await loadContinuationContext(options);
  const quality = context.harness?.quality;
  if (!quality
    || quality.packId !== pending.packId
    || quality.packVersion !== pending.packVersion
    || quality.manifestSha256 !== pending.manifestSha256
    || quality.ruleManifest.version !== pending.ruleVersion
    || quality.ruleManifest.sourceHash !== pending.ruleSourceHash) {
    throw new Error("Pending quality rewrite cannot resume without the same verified Harness and Rule Pack identity.");
  }
  assertExperimentalJudgeIdentity(context.experimentalQuality, pending.experimentalJudge);
  return runLoop({
    rootDir: context.rootDir,
    config: context.config,
    provider: context.provider,
    systemPrompt: context.systemPrompt,
    tools: context.toolSurface.definitions,
    mcpRegistry: context.toolSurface.mcp,
    messages: snapshot.messages.map(toVesicleMessage),
    session: context.session,
    profile: context.profile,
    generation: context.generation,
    checkpoint: await FileCheckpointManager.resumeLatest(context.rootDir, context.session),
    signal: options.signal,
    onEvent: options.onEvent,
    agentManager: options.agentManager,
    permission: context.permission,
    permissionBroker: options.permissionBroker,
    harness: context.harness,
    assets: context.assets,
    experimentalQuality: context.experimentalQuality,
    qualityState: {
      attempts: pending.attempts,
      rejectedHashes: new Set(pending.rejectedHashes),
      candidateParts: pending.candidateParts,
      targets: hydrateQualityTargets(pending.targets),
      warningId: pending.warningId,
      warningTargetIds: pending.warningTargetIds,
      candidate: pending.candidate,
      experimentalJudge: pending.experimentalJudge,
    },
  });
}

export async function resolveQualityDecision(
  options: ResolveQualityDecisionOptions,
): Promise<ResolveQualityDecisionResult> {
  const rootDir = options.rootDir ?? process.cwd();
  let snapshot = await loadSessionSnapshot(rootDir, options.sessionId, {
    synthesizeDanglingToolResults: false,
  });
  const activeQuality = await activeQualityRuntime(options, snapshot);
  if (activeQuality && snapshot.pendingQualityDecision) {
    snapshot = await refreshQualityDecisionArtifacts(rootDir, options.sessionId, activeQuality);
  }
  const point = snapshot.pendingQualityDecision;
  const rewrite = snapshot.pendingQualityRewrite;
  if (!point && !rewrite && activeQuality) {
    return { kind: "quality_resolved", sessionId: options.sessionId, resolution: options.resolution === "stop" ? "stop" : "accept" };
  }
  if (!point && !rewrite) throw new Error("Session does not have a pending Output Quality Guard decision.");
  const producer = point?.request.producer ?? rewrite!.producer;
  if (producer !== options.engine) throw new Error("Pending quality decision Engine does not match the requested continuation.");

  if (options.resolution === "retry") {
    return point ? retryQualityDecision(options, point) : resumeQualityRewrite(options);
  }
  if (point) {
    await settleQualityDecision(rootDir, options.sessionId, snapshot, point, options.resolution);
  } else {
    await settleInterruptedQualityRewrite(rootDir, options.sessionId, snapshot, options.resolution);
  }
  return { kind: "quality_resolved", sessionId: options.sessionId, resolution: options.resolution };
}

export async function refreshQualityDecisionArtifacts(
  rootDir: string,
  sessionId: string,
  quality: QualityRuntimeContext,
): Promise<Awaited<ReturnType<typeof loadSessionSnapshot>>> {
  const snapshot = await loadSessionSnapshot(rootDir, sessionId, { synthesizeDanglingToolResults: false });
  const point = snapshot.pendingQualityDecision;
  if (!point || point.request.reason !== "exhausted" || point.qualityState.targets.length === 0) return snapshot;
  assertQualityIdentity(quality, point.qualityState);
  const targets = hydrateQualityTargets(point.qualityState.targets);
  const reads = await readQualityArtifactTargets(rootDir, targets);
  const previous = new Map(snapshot.qualityWarnings
    .flatMap((warning) => warning.targets)
    .map((target) => [target.id, target]));
  const changed = reads.some(({ target, warningReason }) => {
    const prior = previous.get(target.id);
    return Boolean(prior)
      && (prior!.warningReason !== warningReason || prior!.candidateHash !== target.postImageHash);
  });
  if (!changed) return snapshot;

  const state = {
    attempts: Math.max(2, point.qualityState.attempts),
    rejectedHashes: new Set(point.qualityState.rejectedHashes),
    targets,
  };
  const result = evaluateBoundQualityTargets({
    runtime: quality,
    producer: point.request.producer,
    mode: qualityModeForEngine(quality, point.request.producer),
    targets: reads,
    attempt: state.attempts,
    state,
  });
  if (!result) return snapshot;
  const session = await createSessionStore(rootDir, sessionId);
  await recordQualityEvent(session, result);

  if (result.action === "ask-user") {
    const cleanTargetIds = new Set(result.event.targets
      .filter((target) => target.status === "clean" || target.status === "findings")
      .map((target) => target.id));
    for (const existingWarning of snapshot.qualityWarnings) {
      if (existingWarning.id === point.warning.id) continue;
      const resolvedTargetIds = existingWarning.targets
        .filter((target) => cleanTargetIds.has(target.id))
        .map((target) => target.id);
      if (resolvedTargetIds.length === 0) continue;
      await session.append({
        role: "system",
        content: "",
        metadata: {
          kind: "quality-resolution",
          qualityResolution: {
            warningId: existingWarning.id,
            resolution: "revised-clean",
            targetIds: resolvedTargetIds,
          },
        },
      });
    }
    const warningTargets = result.event.targets.filter((target) =>
      target.status === "warning" && !target.warningReason
    );
    const warning: QualityWarning = {
      id: point.warning.id,
      guard: "anti-ai-flavor",
      reason: "exhausted",
      producer: point.request.producer,
      attempt: state.attempts,
      targets: warningTargets,
    };
    const refreshedPoint: QualityDecisionPoint = {
      ...point,
      request: {
        ...point.request,
        findingCount: warningTargets.reduce((count, target) => count + target.findingIds.length, 0),
        targets: warningTargets.map((target) => ({
          id: target.id,
          ...(target.path ? { path: target.path } : {}),
          findingIds: [...target.findingIds],
        })),
      },
      warning,
      qualityState: {
        ...point.qualityState,
        attempts: state.attempts,
        rejectedHashes: [...state.rejectedHashes],
        targets: durableQualityTargets(targets),
      },
    };
    await session.append({
      role: "system",
      content: "The guarded artifact changed outside the pending decision and was checked again. The current revision still has blocking findings.",
      metadata: { kind: "quality-warning", qualityWarning: warning, qualityDecision: refreshedPoint },
    });
  } else {
    if (result.outcome === "inconclusive") {
      const unresolvedTargetIds = new Set(result.event.targets
        .filter((target) => target.status === "warning")
        .map((target) => target.id));
      const resolvedTargetIds = point.warning.targets
        .filter((target) => !unresolvedTargetIds.has(target.id))
        .map((target) => target.id);
      await session.appendMany([
        ...(resolvedTargetIds.length > 0 ? [{
          role: "system" as const,
          content: "",
          metadata: {
            kind: "quality-resolution",
            qualityResolution: {
              warningId: point.warning.id,
              resolution: "revised-clean",
              targetIds: resolvedTargetIds,
            },
          },
        }] : []),
        {
          role: "system",
          content: "",
          metadata: { kind: "quality-check-cleared", warningId: point.warning.id },
        },
      ]);
      let reusedPointWarning = false;
      for (const reason of ["target-unreadable", "target-oversize", "detector-budget-exhausted"] as const) {
        const existingTargetIds = new Set(snapshot.qualityWarnings
          .filter((warning) => warning.id !== point.warning.id && warning.reason === reason)
          .flatMap((warning) => warning.targets.map((target) => target.id)));
        const warningTargets = result.event.targets.filter((target) =>
          target.warningReason === reason && !existingTargetIds.has(target.id)
        );
        if (warningTargets.length === 0) continue;
        const warning: QualityWarning = {
          id: !reusedPointWarning ? point.warning.id : `quality-warning_${crypto.randomUUID()}`,
          guard: "anti-ai-flavor",
          reason,
          producer: point.request.producer,
          attempt: state.attempts,
          targets: warningTargets,
        };
        await session.append({
          role: "system",
          content: "The guarded artifact changed outside the pending decision, but its current revision could not be checked conclusively.",
          metadata: { kind: "quality-warning", qualityWarning: warning },
        });
        reusedPointWarning = true;
      }
    } else {
      await session.appendMany([
        {
          role: "system",
          content: "",
          metadata: {
            kind: "quality-resolution",
            qualityResolution: {
              warningId: point.warning.id,
              resolution: "revised-clean",
              targetIds: point.warning.targets.map((target) => target.id),
            },
          },
        },
        { role: "system", content: "", metadata: { kind: "quality-check-cleared", warningId: point.warning.id } },
      ]);
    }
  }
  return loadSessionSnapshot(rootDir, sessionId, { synthesizeDanglingToolResults: false });
}

async function activeQualityRuntime(
  options: ResolveQualityDecisionOptions,
  snapshot: Awaited<ReturnType<typeof loadSessionSnapshot>>,
): Promise<QualityRuntimeContext | undefined> {
  const pending = snapshot.pendingQualityDecision?.qualityState ?? snapshot.pendingQualityRewrite;
  if (!pending) return undefined;
  try {
    if (options.harness) {
      assertSessionHarnessIdentity(snapshot.harness, options.harness.identity);
      return matchesQualityIdentity(options.harness.quality, pending) ? options.harness.quality : undefined;
    }
    const project = requireProjectHarnessRuntime(await resolveProjectHarnessRuntime(options.rootDir ?? process.cwd()));
    assertSessionHarnessIdentity(snapshot.harness, project.harness.identity);
    return matchesQualityIdentity(project.harness.quality, pending) ? project.harness.quality : undefined;
  } catch {
    return undefined;
  }
}

async function retryQualityDecision(
  options: ResolveQualityDecisionOptions,
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
  return runLoop({
    rootDir: context.rootDir,
    config: context.config,
    provider: context.provider,
    systemPrompt: context.systemPrompt,
    tools: context.toolSurface.definitions,
    mcpRegistry: context.toolSurface.mcp,
    messages,
    session: context.session,
    profile: context.profile,
    generation: context.generation,
    checkpoint: await FileCheckpointManager.resumeLatest(context.rootDir, context.session),
    signal: options.signal,
    onEvent: options.onEvent,
    agentManager: options.agentManager,
    permission: context.permission,
    permissionBroker: options.permissionBroker,
    harness: context.harness,
    assets: context.assets,
    experimentalQuality: context.experimentalQuality,
    qualityState: {
      attempts: point.qualityState.attempts,
      rejectedHashes: new Set(point.qualityState.rejectedHashes),
      candidateParts: point.qualityState.candidateParts,
      targets: hydrateQualityTargets(point.qualityState.targets),
      warningId: point.warning.id,
      warningTargetIds: point.warning.targets.map((target) => target.id),
      candidate: point.candidate,
      experimentalJudge: point.qualityState.experimentalJudge,
    },
  });
}

async function settleQualityDecision(
  rootDir: string,
  sessionId: string,
  snapshot: Awaited<ReturnType<typeof loadSessionSnapshot>>,
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

async function settleInterruptedQualityRewrite(
  rootDir: string,
  sessionId: string,
  snapshot: Awaited<ReturnType<typeof loadSessionSnapshot>>,
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
  session: Awaited<ReturnType<typeof createSessionStore>>,
  messages: VesicleMessage[],
  snapshot: Awaited<ReturnType<typeof loadSessionSnapshot>>,
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
  session: Awaited<ReturnType<typeof createSessionStore>>,
  messages: VesicleMessage[],
  snapshot: Awaited<ReturnType<typeof loadSessionSnapshot>>,
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

function acceptedCandidateRecords(point: QualityDecisionPoint): Parameters<Awaited<ReturnType<typeof createSessionStore>>["appendMany"]>[0] {
  const records: Parameters<Awaited<ReturnType<typeof createSessionStore>>["appendMany"]>[0] = [];
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
  snapshot: Awaited<ReturnType<typeof loadSessionSnapshot>>,
  point: QualityDecisionPoint,
  message: string,
): Parameters<Awaited<ReturnType<typeof createSessionStore>>["appendMany"]>[0] {
  const answered = durableAnsweredCallIds(snapshot);
  return point.candidate.toolCalls.filter((call) => !answered.has(call.id)).map((call) => ({
    role: "tool" as const,
    content: JSON.stringify({ ok: false, result: message }),
    metadata: { kind: "quality-decision-stopped-tool", name: call.name, ok: false, toolCallId: call.id },
  }));
}

function settledInterruptedCandidateRecords(
  snapshot: Awaited<ReturnType<typeof loadSessionSnapshot>>,
  candidate: QualityDecisionPoint["candidate"],
  resolution: Exclude<QualityDecisionResolution, "retry">,
): Parameters<Awaited<ReturnType<typeof createSessionStore>>["appendMany"]>[0] {
  const records: Parameters<Awaited<ReturnType<typeof createSessionStore>>["appendMany"]>[0] = [];
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

function durableAnsweredCallIds(snapshot: Awaited<ReturnType<typeof loadSessionSnapshot>>): Set<string> {
  return new Set(snapshot.records.flatMap((record) =>
    record.role === "tool" && typeof record.metadata?.toolCallId === "string"
      ? [record.metadata.toolCallId]
      : []
  ));
}

function durableAssistantCallIds(snapshot: Awaited<ReturnType<typeof loadSessionSnapshot>>): Set<string> {
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

function assertQualityIdentity(
  quality: QualityRuntimeContext | undefined,
  pending: QualityDecisionPoint["qualityState"],
): void {
  if (!matchesQualityIdentity(quality, pending)) {
    throw new Error(
      `Pending quality decision requires ${pending.packId}@${pending.packVersion} `
      + `with Rule Pack ${pending.ruleVersion}; the active verified identity does not match.`,
    );
  }
}

function assertExperimentalJudgeIdentity(
  profile: Awaited<ReturnType<typeof loadContinuationContext>>["experimentalQuality"],
  pending: QualityDecisionPoint["qualityState"]["experimentalJudge"],
): void {
  if (!pending) return;
  if (!profile
    || profile.mode !== pending.mode
    || profile.providerId !== pending.providerId
    || profile.modelId !== pending.modelId
    || profile.protocol !== pending.protocol
    || profile.judgeTimeoutMs !== pending.judgeTimeoutMs
    || profile.configIdentity !== pending.configIdentity) {
    throw new Error("Pending experimental Semantic Judge rewrite cannot resume after quality profile configuration drift. Accept or stop it, or restore the exact profile before retrying.");
  }
}

function matchesQualityIdentity(
  quality: QualityRuntimeContext | undefined,
  pending: QualityDecisionPoint["qualityState"],
): quality is QualityRuntimeContext {
  return Boolean(quality
    && quality.packId === pending.packId
    && quality.packVersion === pending.packVersion
    && quality.manifestSha256 === pending.manifestSha256
    && quality.ruleManifest.version === pending.ruleVersion
    && quality.ruleManifest.sourceHash === pending.ruleSourceHash);
}

function toVesicleMessage(message: Awaited<ReturnType<typeof loadSessionSnapshot>>["messages"][number]): VesicleMessage {
  return {
    role: message.role,
    content: message.content,
    ...(message.kind ? { kind: message.kind } : {}),
    ...(message.reasoningContent ? { reasoningContent: message.reasoningContent } : {}),
    ...(message.thinkingBlocks ? { thinkingBlocks: message.thinkingBlocks } : {}),
    ...(message.toolCallId ? { toolCallId: message.toolCallId } : {}),
    ...(message.toolCalls ? { toolCalls: message.toolCalls } : {}),
    ...(message.images ? { images: message.images } : {}),
  };
}
