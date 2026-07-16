import type { VesicleConfig } from "../../config/env";
import type { McpRegistry } from "../../mcp/registry";
import { createProvider } from "../../providers";
import type { VesicleMessage, VesicleRequest, VesicleResponse } from "../../providers/shared/types";
import type { AgentManager } from "../agents/manager";
import type { FileCheckpointManager } from "../checkpoints/file-history";
import type { EngineProfile } from "../engine/profile";
import { defaultPermissionRuntime } from "../permissions";
import type { PermissionRuntimeOptions, ToolPermissionBroker } from "../permissions";
import { getProcessManager, type ProcessManager } from "../process/manager";
import { loadSessionSnapshot, type SessionStore } from "../session/store";
import type { ToolCall, ToolDefinition } from "../tools";
import { createTurnAgentManager } from "./agent-manager";
import { recordAssistantToolCalls } from "./assistant-recorder";
import { resolveInteractionPause } from "./interaction-pause";
import { completeProviderRound, emitAssistantResponse } from "./provider-round";
import { executeToolRound } from "./tool-round-executor";
import { failedToolResult, recordToolResult } from "./tool-result-recorder";
import { planToolRound } from "./tool-round-planner";
import { finalizeTurn } from "./turn-finalizer";
import type { AgentLoopEvent, RunPromptResult } from "./types";
import type { HarnessRuntimeContext } from "../harness/driver";
import type { AssetResolver } from "../runtime/assets";
import {
  evaluateBoundQuality,
  evaluateBoundQualityTargets,
  durableQualityTargets,
  isQualityBoundary,
  isQualityArtifactMutationCall,
  qualityCandidateParts,
  qualityModeForEngine,
  qualityArtifactTargetFromResult,
  readQualityArtifactTargets,
  qualityRewriteFeedback,
  recordQualityEvent,
  shouldBufferQualityOutput,
  type BoundQualityEvaluation,
  type QualityDecisionCandidate,
  type QualityDecisionPoint,
  type QualityRewriteState,
  type QualityWarning,
  upsertQualityArtifactTarget,
} from "../quality";

const maxToolIterations = 40;
const maxConsecutiveFailedTools = 4;

export type RunLoopArgs = {
  rootDir: string;
  config: VesicleConfig;
  provider: ReturnType<typeof createProvider>;
  systemPrompt: string;
  tools: ToolDefinition[];
  mcpRegistry: McpRegistry;
  messages: VesicleMessage[];
  session: SessionStore;
  profile: EngineProfile;
  generation?: VesicleRequest["generation"];
  checkpoint?: FileCheckpointManager;
  signal?: AbortSignal;
  onEvent?: (event: AgentLoopEvent) => void;
  agentManager?: AgentManager;
  permission?: PermissionRuntimeOptions;
  permissionBroker?: ToolPermissionBroker;
  harness?: HarnessRuntimeContext;
  assets?: AssetResolver;
  qualityState?: QualityRewriteState;
};

type LoopRuntime = {
  agentManager: AgentManager;
  processManager: ProcessManager;
  permission: PermissionRuntimeOptions;
  trackCheckpointMutation: (paths: string[]) => Promise<void>;
  quality: QualityRewriteState & { proseParts: string[]; mutationParts: string[]; targets: NonNullable<QualityRewriteState["targets"]> };
  lastQuality?: { outcome: BoundQualityEvaluation["outcome"]; findingCount: number };
};

export async function runLoop(args: RunLoopArgs): Promise<RunPromptResult> {
  const runtime = createLoopRuntime(args);
  let response: VesicleResponse | undefined;
  let consecutiveFailures = 0;

  for (let iteration = 0; iteration < maxToolIterations; iteration++) {
    const round = await advanceRound(args, runtime, iteration);
    response = round.response;
    if (round.pause) return round.pause;
    if (!round.hadToolCalls) break;

    consecutiveFailures = round.anyFailed ? consecutiveFailures + 1 : 0;
    if (consecutiveFailures >= maxConsecutiveFailedTools) {
      await recordNoProgressBreak(args.session, consecutiveFailures);
      break;
    }
  }

  if (!response) throw new Error("Provider did not return a response.");
  return finalizeTurn({
    response,
    messages: args.messages,
    session: args.session,
    profile: args.profile,
    model: args.config.model,
    onEvent: args.onEvent,
    quality: runtime.lastQuality,
  });
}

async function advanceRound(
  args: RunLoopArgs,
  runtime: LoopRuntime,
  iteration: number,
): Promise<{ response: VesicleResponse; pause?: RunPromptResult; hadToolCalls: boolean; anyFailed: boolean }> {
  const response = await completeProviderRound({
    rootDir: args.rootDir,
    provider: args.provider,
    providerId: args.config.providerId,
    model: args.config.model,
    visionEnabled: args.config.capabilities?.vision === true,
    systemPrompt: args.systemPrompt,
    tools: args.tools,
    generation: args.generation,
    messages: args.messages,
    session: args.session,
    processManager: runtime.processManager,
    iteration,
    bufferAssistant: shouldBufferQualityOutput(qualityModeForEngine(args.harness?.quality, args.profile.id)),
    signal: args.signal,
    onEvent: args.onEvent,
  });
  const toolCalls = response.toolCalls ?? [];
  if (toolCalls.length === 0) runtime.quality.proseParts.push(...qualityCandidateParts(response));
  const quality = await evaluateQualityBoundary(args, runtime, response, "before-mutations");
  if (quality?.decision === "rewrite") {
    retainBlockingArtifactTargets(runtime, quality);
    await recordRejectedQualityRound(args, runtime, response, quality);
    await recordQualityEvent(args.session, quality);
    emitQualityStatus(args, runtime, quality);
    runtime.quality.proseParts = [];
    runtime.quality.mutationParts = [];
    return { response, hadToolCalls: true, anyFailed: false };
  }
  if (quality?.action === "ask-user") {
    retainBlockingArtifactTargets(runtime, quality);
    return {
      response,
      hadToolCalls: toolCalls.length > 0,
      anyFailed: false,
      pause: await pauseForQualityDecision(args, runtime, response, quality, "before-mutations", false),
    };
  }
  const buffered = shouldBufferQualityOutput(qualityModeForEngine(args.harness?.quality, args.profile.id));
  emitAssistantResponse(buffered && !isQualityBoundary(response) ? { ...response, content: "" } : response, args.onEvent);
  if (quality) clearQualityCandidate(runtime);
  if (toolCalls.length === 0) return { response, hadToolCalls: false, anyFailed: false };

  const parentMessagesBeforeToolCall = await recordAssistantToolCalls({
    response,
    toolCalls,
    messages: args.messages,
    session: args.session,
    profile: args.profile,
    model: args.config.model,
  });
  const plan = planToolRound(toolCalls, args.tools, runtime.permission);
  await recordPendingQualityCheck(
    args,
    runtime,
    response,
    plan.executableHostToolCalls,
  );
  const execution = await executeToolRound({
    plan,
    rootDir: args.rootDir,
    config: args.config,
    systemPrompt: args.systemPrompt,
    tools: args.tools,
    mcpRegistry: args.mcpRegistry,
    messages: args.messages,
    parentMessagesBeforeToolCall,
    session: args.session,
    profile: args.profile,
    generation: args.generation,
    signal: args.signal,
    onEvent: args.onEvent,
    agentManager: runtime.agentManager,
    processManager: runtime.processManager,
    permission: runtime.permission,
    permissionBroker: args.permissionBroker,
    harness: args.harness,
    assets: args.assets,
    trackCheckpointMutation: runtime.trackCheckpointMutation,
    markCheckpointTainted: async () => { await args.checkpoint?.markTaintedByHostProcess(); },
  });
  for (const fileResult of execution.fileResults) {
    const target = qualityArtifactTargetFromResult(args.profile.id, fileResult);
    if (target) upsertQualityArtifactTarget(runtime.quality.targets, target);
  }
  const postMutationQuality = plan.permissionRequiredCalls.length === 0
    ? await evaluateQualityBoundary(args, runtime, response, "after-mutations")
    : undefined;
  if (postMutationQuality?.decision === "rewrite") {
    retainBlockingArtifactTargets(runtime, postMutationQuality);
    await recordPostMutationQualityRewrite(args, runtime, response, plan.interactiveCalls, postMutationQuality);
    await recordQualityEvent(args.session, postMutationQuality);
    emitQualityStatus(args, runtime, postMutationQuality);
    runtime.quality.proseParts = [];
    runtime.quality.mutationParts = [];
    return { response, hadToolCalls: true, anyFailed: execution.anyFailed };
  }
  if (postMutationQuality?.action === "ask-user") {
    retainBlockingArtifactTargets(runtime, postMutationQuality);
    return {
      response,
      hadToolCalls: true,
      anyFailed: execution.anyFailed,
      pause: await pauseForQualityDecision(args, runtime, response, postMutationQuality, "after-mutations", true),
    };
  }
  if (postMutationQuality) clearQualityCandidate(runtime);
  if (execution.delegationPause) {
    return {
      response,
      hadToolCalls: true,
      anyFailed: true,
      pause: {
        kind: "needs_user_question",
        sessionId: args.session.sessionId,
        sessionPath: args.session.sessionPath,
        profile: args.profile,
        question: execution.delegationPause.question,
        delegationDecision: execution.delegationPause.decision,
        toolCallId: execution.delegationPause.toolCallId,
        assistantContent: response.content,
        messages: args.messages,
      },
    };
  }
  const interaction = await resolveInteractionPause({
    plan,
    messages: args.messages,
    session: args.session,
    profile: args.profile,
    assistantContent: response.content,
    permission: runtime.permission,
    qualityState: durableQualityState(args, runtime),
    onEvent: args.onEvent,
  });
  return {
    response,
    hadToolCalls: true,
    anyFailed: execution.anyFailed || interaction.anyFailed,
    ...(interaction.result ? { pause: interaction.result } : {}),
  };
}

function qualityDeliveryParts(runtime: LoopRuntime): string[] {
  return runtime.quality.mutationParts.length > 0 ? runtime.quality.mutationParts : runtime.quality.proseParts;
}

function clearQualityCandidate(runtime: LoopRuntime): void {
  runtime.quality.proseParts = [];
  runtime.quality.mutationParts = [];
  runtime.quality.targets = [];
}

async function recordPendingQualityCheck(
  args: RunLoopArgs,
  runtime: LoopRuntime,
  response: VesicleResponse,
  executableCalls: ToolCall[],
): Promise<boolean> {
  const quality = args.harness?.quality;
  if (!quality
    || !executableCalls.some((call) => isQualityArtifactMutationCall(call, args.profile.id))) return false;
  if (!shouldBufferQualityOutput(qualityModeForEngine(quality, args.profile.id))) return false;
  runtime.quality.candidate = qualityDecisionCandidate(response);
  const pending = durableQualityState(args, runtime);
  if (!pending) return false;
  await args.session.append({
    role: "system",
    content: "",
    metadata: {
      kind: "quality-check-pending",
      qualityRewrite: pending,
    },
  });
  return true;
}

function durableQualityState(args: RunLoopArgs, runtime: LoopRuntime) {
  const quality = args.harness?.quality;
  if (!quality || !shouldBufferQualityOutput(qualityModeForEngine(quality, args.profile.id))) return undefined;
  return {
    producer: args.profile.id,
    packId: quality.packId,
    packVersion: quality.packVersion,
    manifestSha256: quality.manifestSha256,
    ruleVersion: quality.ruleManifest.version,
    ruleSourceHash: quality.ruleManifest.sourceHash,
    attempts: runtime.quality.attempts,
    rejectedHashes: [...runtime.quality.rejectedHashes],
    candidateParts: [...qualityDeliveryParts(runtime)],
    targets: durableQualityTargets(runtime.quality.targets),
    ...(runtime.quality.warningId ? { warningId: runtime.quality.warningId } : {}),
    ...(runtime.quality.warningTargetIds ? { warningTargetIds: [...runtime.quality.warningTargetIds] } : {}),
    ...(runtime.quality.candidate ? { candidate: runtime.quality.candidate } : {}),
  };
}

async function evaluateQualityBoundary(
  args: RunLoopArgs,
  runtime: LoopRuntime,
  response: VesicleResponse,
  phase: "before-mutations" | "after-mutations",
): Promise<BoundQualityEvaluation | undefined> {
  const qualityRuntime = args.harness?.quality;
  if (!qualityRuntime || !isQualityBoundary(response)) return undefined;
  const hasArtifactMutation = (response.toolCalls ?? [])
    .some((call) => isQualityArtifactMutationCall(call, args.profile.id));
  if ((phase === "before-mutations" && hasArtifactMutation)
    || (phase === "after-mutations" && !hasArtifactMutation)) return undefined;
  const mode = qualityModeForEngine(qualityRuntime, args.profile.id);
  if (mode === "off" || mode === "analyze") return undefined;
  args.onEvent?.({ type: "quality_status", phase: "checking", attempt: runtime.quality.attempts, findingCount: 0 });
  const result = runtime.quality.targets.length > 0
    ? evaluateBoundQualityTargets({
      runtime: qualityRuntime,
      producer: args.profile.id,
      mode,
      targets: await readQualityArtifactTargets(args.rootDir, runtime.quality.targets),
      attempt: runtime.quality.attempts,
      state: runtime.quality,
      usage: response.usage,
    })
    : evaluateBoundQuality({
      runtime: qualityRuntime,
      producer: args.profile.id,
      mode,
      content: qualityDeliveryParts(runtime).join("\n\n"),
      attempt: runtime.quality.attempts,
      state: runtime.quality,
      usage: response.usage,
    });
  if (!result) return undefined;
  runtime.lastQuality = { outcome: result.outcome, findingCount: result.evaluation.findings.length };
  if (result.action !== "ask-user" && result.event.targets.some((target) => target.warningReason)) {
    await recordInconclusiveWarnings(args, runtime, result);
  }
  if (result.outcome !== "inconclusive") {
    await resolveQualityWarnings(args, runtime, result);
  }
  if (result.decision !== "rewrite") {
    await recordQualityEvent(args.session, result);
    emitQualityStatus(args, runtime, result);
  }
  return result;
}

async function recordPostMutationQualityRewrite(
  args: RunLoopArgs,
  runtime: LoopRuntime,
  response: VesicleResponse,
  interactionCalls: ToolCall[],
  result: BoundQualityEvaluation,
): Promise<void> {
  runtime.quality.candidate = qualityDecisionCandidate(response);
  const persistedState = durableQualityState(args, runtime);
  if (!persistedState) throw new Error("Quality rewrite state is unavailable under the active Guard.");
  const feedback = qualityRewriteFeedback(result);
  for (const call of interactionCalls) {
    await recordToolResult({
      result: failedToolResult(call.id, call.name, feedback),
      messages: args.messages,
      session: args.session,
      metadata: {
        kind: "quality-rewrite-feedback",
        candidateHash: result.evaluation.candidateHash,
        qualityRewrite: { ...persistedState, candidateParts: [] },
      },
      emitEvent: false,
    });
  }
}

async function pauseForQualityDecision(
  args: RunLoopArgs,
  runtime: LoopRuntime,
  response: VesicleResponse,
  result: BoundQualityEvaluation,
  phase: QualityDecisionPoint["phase"],
  candidateRecorded: boolean,
): Promise<Extract<RunPromptResult, { kind: "needs_quality_decision" }>> {
  const warningTargets = result.event.targets.filter((target) =>
    target.status === "warning" && !target.warningReason
  );
  const warningId = runtime.quality.warningId ?? `quality-warning_${crypto.randomUUID()}`;
  runtime.quality.warningId = warningId;
  runtime.quality.warningTargetIds = warningTargets.map((target) => target.id);
  runtime.quality.candidate = qualityDecisionCandidate(response);
  const state = durableQualityState(args, runtime);
  if (!state) throw new Error("Quality decision state is unavailable under the active Guard.");
  state.candidateParts = [];
  const warning: QualityWarning = {
    id: warningId,
    guard: "anti-ai-flavor",
    reason: "exhausted",
    producer: args.profile.id,
    attempt: runtime.quality.attempts,
    targets: warningTargets,
  };
  const request = {
    id: warningId,
    reason: "exhausted" as const,
    producer: args.profile.id,
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
    candidate: runtime.quality.candidate,
    phase,
    candidateRecorded,
  };
  await args.session.append({
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
    sessionId: args.session.sessionId,
    sessionPath: args.session.sessionPath,
    profile: args.profile,
    decision: request,
    assistantContent: response.content,
    messages: args.messages,
  };
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

function qualityDecisionCandidate(response: VesicleResponse): QualityDecisionCandidate {
  return {
    responseId: response.id,
    content: response.content,
    toolCalls: (response.toolCalls ?? []).map((call) => ({ ...call })),
    ...(response.reasoningContent ? { reasoningContent: response.reasoningContent } : {}),
    ...(response.thinkingBlocks ? { thinkingBlocks: response.thinkingBlocks.map((block) => ({ ...block })) } : {}),
    ...(response.finishReason ? { finishReason: response.finishReason } : {}),
    ...(response.usage ? { usage: response.usage } : {}),
  };
}

async function resolveQualityWarnings(
  args: RunLoopArgs,
  runtime: LoopRuntime,
  result: BoundQualityEvaluation,
): Promise<void> {
  const snapshot = await loadSessionSnapshot(args.rootDir, args.session.sessionId, {
    synthesizeDanglingToolResults: false,
  });
  const cleanTargetIds = new Set(result.event.targets
    .filter((target) => target.status === "clean" || target.status === "findings")
    .map((target) => target.id));
  for (const warning of snapshot.qualityWarnings) {
    const targetIds = warning.targets
      .filter((target) => cleanTargetIds.has(target.id)
        || (warning.id === runtime.quality.warningId
          && target.kind === "assistant-response"
          && (result.outcome === "clean" || result.outcome === "findings")))
      .map((target) => target.id);
    if (targetIds.length === 0) continue;
    await args.session.append({
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
  args: RunLoopArgs,
  runtime: LoopRuntime,
  result: BoundQualityEvaluation,
): Promise<void> {
  const snapshot = await loadSessionSnapshot(args.rootDir, args.session.sessionId, {
    synthesizeDanglingToolResults: false,
  });
  let reusedPendingWarning = false;
  for (const reason of ["target-unreadable", "target-oversize"] as const) {
    const existing = new Set(snapshot.qualityWarnings
      .filter((warning) => warning.id !== runtime.quality.warningId && warning.reason === reason)
      .flatMap((warning) => warning.targets.map((target) => target.id)));
    const targets = result.event.targets.filter((target) =>
      target.warningReason === reason
      && !existing.has(target.id)
    );
    if (targets.length === 0) continue;
    const warning: QualityWarning = {
      id: runtime.quality.warningId && !reusedPendingWarning
        ? runtime.quality.warningId
        : `quality-warning_${crypto.randomUUID()}`,
      guard: "anti-ai-flavor",
      reason,
      producer: args.profile.id,
      attempt: result.event.attempt,
      targets,
    };
    await args.session.append({
      role: "system",
      content: `${targets.length} quality target${targets.length === 1 ? " was" : "s were"} ${reason === "target-oversize" ? "over the deterministic check limit" : "not readable as a guarded UTF-8 file"}. The content was delivered without a clean quality result.`,
      metadata: { kind: "quality-warning", qualityWarning: warning },
    });
    if (warning.id === runtime.quality.warningId) reusedPendingWarning = true;
  }
  if (reusedPendingWarning && runtime.quality.warningId) {
    await args.session.append({
      role: "system",
      content: "",
      metadata: { kind: "quality-check-cleared", warningId: runtime.quality.warningId },
    });
  } else if (runtime.quality.warningId) {
    const pendingWarning = snapshot.qualityWarnings.find((warning) => warning.id === runtime.quality.warningId);
    const unresolvedTargetIds = new Set(result.event.targets
      .filter((target) => target.status === "warning")
      .map((target) => target.id));
    const resolvedTargetIds = pendingWarning?.targets
      .filter((target) => !unresolvedTargetIds.has(target.id))
      .map((target) => target.id) ?? [];
    await args.session.appendMany([
      ...(resolvedTargetIds.length > 0 ? [{
        role: "system" as const,
        content: "",
        metadata: {
          kind: "quality-resolution",
          qualityResolution: {
            warningId: runtime.quality.warningId,
            resolution: "revised-clean",
            targetIds: resolvedTargetIds,
          },
        },
      }] : []),
      {
        role: "system",
        content: "",
        metadata: { kind: "quality-check-cleared", warningId: runtime.quality.warningId },
      },
    ]);
  }
}

function emitQualityStatus(args: RunLoopArgs, runtime: LoopRuntime, result: BoundQualityEvaluation): void {
  args.onEvent?.({
    type: "quality_status",
    phase: result.action === "rewrite" ? "rewriting"
      : result.action === "ask-user" ? "exhausted"
        : result.outcome === "inconclusive" ? "inconclusive"
          : result.action === "observe" ? "observed"
          : result.outcome === "findings" ? "findings"
            : "clean",
    attempt: runtime.quality.attempts,
    findingCount: result.evaluation.findings.length,
  });
}

async function recordRejectedQualityRound(
  args: RunLoopArgs,
  runtime: LoopRuntime,
  response: VesicleResponse,
  result: BoundQualityEvaluation,
): Promise<void> {
  const calls = response.toolCalls ?? [];
  const persistedState = durableQualityState(args, runtime);
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
    await args.session.appendMany([
      {
        role: "assistant",
        content: "",
        metadata: {
          kind: "quality-rejected-candidate",
          engine: args.profile.id,
          model: args.config.model,
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
    args.messages.push(assistantMessage, ...toolMessages);
    return;
  }
  const feedback = qualityRewriteFeedback(result, true);
  args.messages.push({ role: "user", content: feedback });
  await args.session.appendMany([{
    role: "user",
    content: feedback,
    metadata: { kind: "quality-rewrite-feedback", candidateHash: result.evaluation.candidateHash, qualityRewrite: rewriteState },
  }]);
}

function createLoopRuntime(args: RunLoopArgs): LoopRuntime {
  return {
    agentManager: args.agentManager ?? createTurnAgentManager(args.rootDir, args.onEvent),
    processManager: getProcessManager(args.rootDir),
    permission: args.permission ?? defaultPermissionRuntime,
    trackCheckpointMutation: createCheckpointMutationTracker(args.checkpoint),
    quality: {
      attempts: args.qualityState?.attempts ?? 0,
      rejectedHashes: new Set(args.qualityState?.rejectedHashes ?? []),
      proseParts: [],
      mutationParts: [...(args.qualityState?.candidateParts ?? [])],
      targets: (args.qualityState?.targets ?? []).map((target) => ({
        ...target,
        mutationCallIds: [...target.mutationCallIds],
        rejectedHashes: new Set(target.rejectedHashes),
      })),
      warningId: args.qualityState?.warningId,
      warningTargetIds: args.qualityState?.warningTargetIds ? [...args.qualityState.warningTargetIds] : undefined,
      candidate: args.qualityState?.candidate,
    },
  };
}

function retainBlockingArtifactTargets(runtime: LoopRuntime, result: BoundQualityEvaluation): void {
  if (!result.targetEvaluations) return;
  const unresolvedIds = new Set(result.targetEvaluations
    .filter((target) => target.evaluation.blockingFindings.length > 0 || target.warningReason)
    .map((target) => target.target.id));
  runtime.quality.targets = runtime.quality.targets.filter((target) => unresolvedIds.has(target.id));
}

function createCheckpointMutationTracker(checkpoint?: FileCheckpointManager): (paths: string[]) => Promise<void> {
  let tail = Promise.resolve();
  return (paths) => {
    const next = tail.then(async () => checkpoint?.trackBeforeMutation(paths));
    tail = next.catch(() => undefined);
    return next;
  };
}

async function recordNoProgressBreak(session: SessionStore, consecutiveFailures: number): Promise<void> {
  await session.append({
    role: "system",
    content: `Tool loop stopped after ${consecutiveFailures} consecutive rounds of failing tool results.`,
    metadata: { kind: "no-progress-breaker" },
  });
}
