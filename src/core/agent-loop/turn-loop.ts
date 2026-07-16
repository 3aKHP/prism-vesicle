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
import type { SessionStore } from "../session/store";
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
  type QualityRewriteState,
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
    await recordPostMutationQualityRewrite(args, runtime, plan.interactiveCalls, postMutationQuality);
    await recordQualityEvent(args.session, postMutationQuality);
    emitQualityStatus(args, runtime, postMutationQuality);
    runtime.quality.proseParts = [];
    runtime.quality.mutationParts = [];
    return { response, hadToolCalls: true, anyFailed: execution.anyFailed };
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
  if (result.decision !== "rewrite") {
    await recordQualityEvent(args.session, result);
    emitQualityStatus(args, runtime, result);
  }
  return result;
}

async function recordPostMutationQualityRewrite(
  args: RunLoopArgs,
  runtime: LoopRuntime,
  interactionCalls: ToolCall[],
  result: BoundQualityEvaluation,
): Promise<void> {
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

function emitQualityStatus(args: RunLoopArgs, runtime: LoopRuntime, result: BoundQualityEvaluation): void {
  args.onEvent?.({
    type: "quality_status",
    phase: result.decision === "rewrite" ? "rewriting"
      : result.decision === "exhausted" ? "exhausted"
        : result.decision === "observe" ? "observed"
          : "accepted",
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
  const rewriteState = { ...persistedState, candidateParts: [] };
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
    },
  };
}

function retainBlockingArtifactTargets(runtime: LoopRuntime, result: BoundQualityEvaluation): void {
  if (!result.targetEvaluations) return;
  const blockingIds = new Set(result.targetEvaluations
    .filter((target) => target.evaluation.blockingFindings.length > 0)
    .map((target) => target.target.id));
  runtime.quality.targets = runtime.quality.targets.filter((target) => blockingIds.has(target.id));
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
