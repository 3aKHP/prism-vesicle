import type { VesicleConfig } from "../../config/env";
import type { McpRegistry } from "../../mcp/registry";
import { createProvider } from "../../providers";
import type { VesicleMessage, VesicleRequest, VesicleResponse } from "../../providers/shared/types";
import type { AgentManager } from "../agents/manager";
import { FileCheckpointManager } from "../checkpoints/file-history";
import type { EngineProfile } from "../engine/profile";
import { defaultPermissionRuntime } from "../permissions";
import type { PermissionRuntimeOptions, ToolPermissionBroker } from "../permissions";
import { getProcessManager, type ProcessManager } from "../process/manager";
import type { SessionStore } from "../session/store";
import { bindExecutionRound, clearExecutionRound, loadSessionSnapshot, newProviderRoundId, withExecutionRound } from "../session/store";
import { AutoCompactBlockedError, runAutomaticCompaction } from "../compact/auto-compact";
import { estimateRequestTokens } from "../compact/context-budget";
import { toVesicleMessage } from "../compact/summary-generator";
import type { ToolDefinition } from "../tools";
import { createTurnAgentManager } from "./agent-manager";
import { recordAssistantToolCalls } from "./assistant-recorder";
import { resolveInteractionPause } from "./interaction-pause";
import { completeProviderRound, emitAssistantResponse, materializeBackgroundProcessNotifications } from "./provider-round";
import { executeToolRound } from "./tool-round-executor";
import { planToolRound } from "./tool-round-planner";
import { finalizeTurn } from "./turn-finalizer";
import { clearFrozenInstructionBlocks, readFrozenInstructionBlocks } from "../instructions/instruction-context";
import type { AgentLoopEvent, PendingUserInput, RunPromptResult } from "./types";
import type { HarnessRuntimeContext } from "../harness/driver";
import type { AssetResolver } from "../runtime/assets";
import type { ExperimentalQualityProfile } from "../../config/quality";
import { persistedImageAttachments } from "../attachments/store";
import { generationMetadata } from "./generation";
import {
  isQualityBoundary,
  qualityCandidateParts,
  qualityModeForEngine,
  shouldBufferQualityOutput,
  type BoundQualityEvaluation,
  type QualityRewriteState,
} from "../quality";
import { evaluateQualityRoundBoundary } from "./quality-round-evaluation";
import {
  captureQualityArtifactResult,
  clearQualityCandidate,
  createQualityRoundState,
  durableQualityState,
  retainBlockingArtifactTargets,
  type QualityRoundState,
} from "./quality-round-state";
import {
  pauseForQualityDecision,
  recordPendingQualityCheck,
  recordPostMutationQualityRewrite,
  recordQualityEvaluation,
  recordQualityRewriteResult,
  recordRejectedQualityRound,
  type QualityRoundRecordingContext,
} from "./quality-round-recording";

const maxToolIterations = 40;
const maxConsecutiveFailedTools = 4;

export type RunLoopArgs = {
  rootDir: string;
  config: VesicleConfig;
  provider: ReturnType<typeof createProvider>;
  systemPrompt: string;
  /** Engine prompt without instruction blocks — used to recompose systemPrompt after an in-turn instruction update. */
  enginePrompt: string;
  tools: ToolDefinition[];
  mcpRegistry: McpRegistry;
  messages: VesicleMessage[];
  session: SessionStore;
  /**
   * Stable id for the whole top-level Agent Loop. Present for any turn the
   * bootstrap started (fresh turn) or a continuation recovered from persisted
   * records (resumed pause). Absent only for a legacy session whose records
   * pre-date identity stamping; in that case the loop appends without stamping.
   */
  logicalTurnId?: string;
  /**
   * First provider round for iteration 0 (a fresh turn — the bootstrap
   * allocated it with the user input). Absent for continuations, which advance
   * to a fresh round before their first request because the resolution just
   * completed the previous round.
   */
  providerRoundId?: string;
  profile: EngineProfile;
  generation?: VesicleRequest["generation"];
  checkpoint?: FileCheckpointManager;
  signal?: AbortSignal;
  onEvent?: (event: AgentLoopEvent) => void;
  onProviderContextSnapshot?: (snapshot: import("../side-question/types").SideQuestionContextSnapshot) => void;
  agentManager?: AgentManager;
  permission?: PermissionRuntimeOptions;
  permissionBroker?: ToolPermissionBroker;
  harness?: HarnessRuntimeContext;
  assets?: AssetResolver;
  qualityState?: QualityRewriteState;
  experimentalQuality?: ExperimentalQualityProfile;
  takePendingUserInputs?: () => PendingUserInput[];
  runToolBoundaryCommands?: () => Promise<void>;
  injectPendingBeforeFirstProvider?: boolean;
};

type LoopRuntime = {
  agentManager: AgentManager;
  processManager: ProcessManager;
  permission: PermissionRuntimeOptions;
  checkpoint?: FileCheckpointManager;
  checkpointMutationTail: Promise<void>;
  quality: QualityRoundState;
  logicalTurnId: string | undefined;
  providerRoundId: string | undefined;
  /** Most recent provider-observed context occupancy, for mid-turn budget checks. Cleared after a compact (stale). */
  lastContextInputTokens: number | undefined;
  lastRequestObservation: { contextInputTokens: number; estimatedRequestTokens: number } | undefined;
  lastRequestEstimateTokens: number | undefined;
};

export async function runLoop(args: RunLoopArgs): Promise<RunPromptResult> {
  try {
    return await runLoopInternal(args);
  } catch (error) {
    clearFrozenInstructionBlocks(args.session.sessionId);
    throw error;
  } finally {
    // The active provider round is process-local. Clear it on every exit
    // (completion, pause, or error): a continuation re-binds the recovered
    // round before appending, and a non-loop append (e.g. /compact) must never
    // inherit a stale round.
    clearExecutionRound(args.session.sessionId);
  }
}

/**
 * Recompose the live system prompt from the base engine prompt and the current
 * frozen instruction snapshot. After an `update_instructions` call refreshes the
 * snapshot mid-turn, the next provider round picks up the new instructions.
 * No-op for Stage (it has no instruction tools and must keep its character-context
 * suffix) and when no snapshot is cached.
 */
function refreshLiveSystemPrompt(args: RunLoopArgs): void {
  if (args.profile.id === "stage") return;
  const blocks = readFrozenInstructionBlocks(args.session.sessionId);
  if (blocks === undefined) return;
  args.systemPrompt = blocks.length > 0 ? `${args.enginePrompt}\n\n${blocks}` : args.enginePrompt;
}

async function runLoopInternal(args: RunLoopArgs): Promise<RunPromptResult> {
  const runtime = createLoopRuntime(args);
  let response: VesicleResponse | undefined;
  let consecutiveFailures = 0;

  // A fresh turn reuses the provider round the bootstrap allocated with the
  // user input. A continuation (injectPendingBeforeFirstProvider) just appended
  // the resolution that completed the previous round, so the first request here
  // is a new provider round; advance before draining queued inputs so they (and
  // the request) stamp the new round id.
  if (args.injectPendingBeforeFirstProvider) {
    advanceProviderRound(args, runtime);
    await processInputBoundary(args, runtime);
  }

  // Recompose from the frozen instruction snapshot before the first round. This
  // matters for a MANUAL/INERTIA resume: the approved update_instructions ran
  // (refreshing the snapshot) AFTER the continuation context was built, so the
  // first provider round of the resumed loop must pick up the new instructions.
  refreshLiveSystemPrompt(args);

  for (let iteration = 0; iteration < maxToolIterations; iteration++) {
    const round = await advanceRound(args, runtime, iteration);
    if (round.blocked) {
      if (!response) throw round.error;
      break;
    }
    response = round.response;
    if (round.pause) return round.pause;
    if (!round.hadToolCalls) break;
    // The latest provider-observed context occupancy feeds the mid-turn budget
    // checks (the host estimate covers growth since this observation).
    const observed = response.usage?.contextInputTokens;
    if (typeof observed === "number" && observed > 0) {
      runtime.lastContextInputTokens = observed;
      if (runtime.lastRequestEstimateTokens !== undefined) {
        runtime.lastRequestObservation = {
          contextInputTokens: observed,
          estimatedRequestTokens: runtime.lastRequestEstimateTokens,
        };
      }
    }
    // Mid-turn soft check: after a complete assistant/tool batch (any pause has
    // been resolved by advanceRound returning, not pausing), before queued
    // steering is drained for the next round. At most one compact per boundary.
    const soft = args.profile.id !== "stage" && args.config.limits?.autoCompact
      ? await runMidTurnCompaction(args, runtime, false)
      : { compacted: false, blocked: false };
    if (soft.blocked) break;
    // A tool round may have refreshed the in-turn frozen instruction snapshot
    // (update_instructions). Recompose the live system prompt so the next
    // provider round observes the new instructions. Stage has no instruction
    // tools and must keep its frozen character-context suffix, so it is skipped.
    refreshLiveSystemPrompt(args);
    // The next provider request is a new provider/tool round; advance before
    // queued steering/background input is materialized so those injected inputs
    // carry the next round id, then drain them.
    advanceProviderRound(args, runtime);
    await processInputBoundary(args, runtime);
    consecutiveFailures = round.anyFailed ? consecutiveFailures + 1 : 0;
    if (consecutiveFailures >= maxConsecutiveFailedTools) {
      await recordNoProgressBreak(args.session, consecutiveFailures);
      break;
    }
  }

  if (!response) throw new Error("Provider did not return a response.");
  // The turn completed: drop its frozen instruction snapshot. A paused turn
  // keeps its snapshot so an in-process continuation can resume under the same
  // instruction set.
  clearFrozenInstructionBlocks(args.session.sessionId);
  return finalizeTurn({
    response,
    messages: args.messages,
    session: args.session,
    profile: args.profile,
    model: args.config.model,
    onEvent: args.onEvent,
    quality: runtime.quality.lastResult,
    requestEstimateTokens: runtime.lastRequestEstimateTokens,
  });
}

async function advanceRound(
  args: RunLoopArgs,
  runtime: LoopRuntime,
  iteration: number,
): Promise<
  | { response: VesicleResponse; pause?: RunPromptResult; hadToolCalls: boolean; anyFailed: boolean; blocked?: false }
  | { blocked: true; error: AutoCompactBlockedError }
> {
  const boundary = await prepareExactProviderBoundary(args, runtime);
  if (boundary.blocked) return { blocked: true, error: boundary.error! };
  runtime.lastRequestEstimateTokens = estimateRequestTokens(args.messages, args.systemPrompt, args.tools);
  const response = await completeProviderRound({
    rootDir: args.rootDir,
    provider: args.provider,
    providerId: args.config.providerId,
    model: args.config.model,
    engine: args.profile.id,
    providerSelection: { provider: args.config.providerId, model: args.config.model },
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
    onProviderContextSnapshot: args.onProviderContextSnapshot,
    backgroundAlreadyMaterialized: true,
  });
  const toolCalls = response.toolCalls ?? [];
  if (toolCalls.length === 0) runtime.quality.proseParts.push(...qualityCandidateParts(response));
  const quality = await evaluateRoundQuality(args, runtime, response, "before-mutations");
  if (quality?.decision === "rewrite") {
    retainBlockingArtifactTargets(runtime.quality, quality);
    await recordRejectedQualityRound(qualityRecordingContext(args, runtime), response, quality);
    await recordQualityRewriteResult(qualityRecordingContext(args, runtime), quality);
    runtime.quality.proseParts = [];
    runtime.quality.mutationParts = [];
    return { response, hadToolCalls: true, anyFailed: false };
  }
  if (quality?.action === "ask-user") {
    retainBlockingArtifactTargets(runtime.quality, quality);
    return {
      response,
      hadToolCalls: toolCalls.length > 0,
      anyFailed: false,
      pause: await pauseForQualityDecision(qualityRecordingContext(args, runtime), response, quality, "before-mutations", false),
    };
  }
  const buffered = shouldBufferQualityOutput(qualityModeForEngine(args.harness?.quality, args.profile.id));
  emitAssistantResponse(buffered && !isQualityBoundary(response) ? { ...response, content: "" } : response, args.onEvent);
  if (quality) clearQualityCandidate(runtime.quality);
  if (toolCalls.length === 0) return { response, hadToolCalls: false, anyFailed: false };

  const parentMessagesBeforeToolCall = await recordAssistantToolCalls({
    response,
    toolCalls,
    messages: args.messages,
    session: args.session,
    profile: args.profile,
    model: args.config.model,
    metadata: runtime.lastRequestEstimateTokens !== undefined
      ? { requestEstimateTokens: runtime.lastRequestEstimateTokens }
      : undefined,
  });
  const plan = planToolRound(toolCalls, args.tools, runtime.permission);
  await recordPendingQualityCheck(
    qualityRecordingContext(args, runtime),
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
    trackCheckpointMutation: (paths) => trackCheckpointMutation(runtime, paths),
    markCheckpointTainted: async () => { await runtime.checkpoint?.markTaintedByHostProcess(); },
  });
  for (const fileResult of execution.fileResults) {
    captureQualityArtifactResult(runtime.quality, args.profile.id, fileResult);
  }
  const postMutationQuality = plan.permissionRequiredCalls.length === 0
    ? await evaluateRoundQuality(args, runtime, response, "after-mutations")
    : undefined;
  if (postMutationQuality?.decision === "rewrite") {
    retainBlockingArtifactTargets(runtime.quality, postMutationQuality);
    await recordPostMutationQualityRewrite(qualityRecordingContext(args, runtime), response, plan.interactiveCalls, postMutationQuality);
    await recordQualityRewriteResult(qualityRecordingContext(args, runtime), postMutationQuality);
    runtime.quality.proseParts = [];
    runtime.quality.mutationParts = [];
    return { response, hadToolCalls: true, anyFailed: execution.anyFailed };
  }
  if (postMutationQuality?.action === "ask-user") {
    retainBlockingArtifactTargets(runtime.quality, postMutationQuality);
    return {
      response,
      hadToolCalls: true,
      anyFailed: execution.anyFailed,
      pause: await pauseForQualityDecision(qualityRecordingContext(args, runtime), response, postMutationQuality, "after-mutations", true),
    };
  }
  if (postMutationQuality) clearQualityCandidate(runtime.quality);
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
    qualityState: persistedQualityState(args, runtime),
    onEvent: args.onEvent,
  });
  return {
    response,
    hadToolCalls: true,
    anyFailed: execution.anyFailed || interaction.anyFailed,
    ...(interaction.result ? { pause: interaction.result } : {}),
  };
}

async function evaluateRoundQuality(
  args: RunLoopArgs,
  runtime: LoopRuntime,
  response: VesicleResponse,
  phase: "before-mutations" | "after-mutations",
): Promise<BoundQualityEvaluation | undefined> {
  const result = await evaluateQualityRoundBoundary({
    rootDir: args.rootDir,
    runtime: args.harness?.quality,
    producer: args.profile.id,
    experimentalQuality: args.experimentalQuality,
    response,
    phase,
    state: runtime.quality,
    signal: args.signal,
    onEvent: args.onEvent,
  });
  if (result) await recordQualityEvaluation(qualityRecordingContext(args, runtime), result);
  return result;
}

function qualityRecordingContext(args: RunLoopArgs, runtime: LoopRuntime): QualityRoundRecordingContext {
  return {
    rootDir: args.rootDir,
    runtime: args.harness?.quality,
    experimentalQuality: args.experimentalQuality,
    state: runtime.quality,
    responseMessages: args.messages,
    session: args.session,
    profile: args.profile,
    model: args.config.model,
    onEvent: args.onEvent,
  };
}

function persistedQualityState(args: RunLoopArgs, runtime: LoopRuntime) {
  return durableQualityState({
    runtime: args.harness?.quality,
    producer: args.profile.id,
    experimentalQuality: args.experimentalQuality,
    state: runtime.quality,
    buffered: shouldBufferQualityOutput(qualityModeForEngine(args.harness?.quality, args.profile.id)),
  });
}

function createLoopRuntime(args: RunLoopArgs): LoopRuntime {
  return {
    agentManager: args.agentManager ?? createTurnAgentManager(args.rootDir, args.onEvent),
    processManager: getProcessManager(args.rootDir),
    permission: args.permission ?? defaultPermissionRuntime,
    checkpoint: args.checkpoint,
    checkpointMutationTail: Promise.resolve(),
    quality: createQualityRoundState(args.qualityState),
    logicalTurnId: args.logicalTurnId,
    providerRoundId: args.providerRoundId,
    lastContextInputTokens: undefined,
    lastRequestObservation: undefined,
    lastRequestEstimateTokens: undefined,
  };
}

/**
 * Allocate the next provider/tool round id and bind it as the active round so
 * recorders and injected-input appends stamp it. The logical turn id is stable
 * for the whole turn; only the provider round id advances. A legacy turn with
 * no logical turn id is left unstamped so its records stay legacy.
 */
function advanceProviderRound(args: RunLoopArgs, runtime: LoopRuntime): void {
  if (!runtime.logicalTurnId) return;
  runtime.providerRoundId = newProviderRoundId();
  bindExecutionRound(args.session.sessionId, {
    logicalTurnId: runtime.logicalTurnId,
    providerRoundId: runtime.providerRoundId,
  });
}

function trackCheckpointMutation(runtime: LoopRuntime, paths: string[]): Promise<void> {
  const checkpoint = runtime.checkpoint;
  const next = runtime.checkpointMutationTail.then(async () => checkpoint?.trackBeforeMutation(paths));
  runtime.checkpointMutationTail = next.catch(() => undefined);
  return next;
}

async function injectPendingUserInputs(args: RunLoopArgs, runtime: LoopRuntime): Promise<void> {
  const pending = args.takePendingUserInputs?.() ?? [];
  for (const input of pending) {
    const content = input.content.trim();
    if (!content) continue;
    const record = await args.session.append({
      role: "user",
      content,
      metadata: withExecutionRound(args.session.sessionId, {
        kind: "queued-user-message",
        engine: args.profile.id,
        provider: args.config.provider,
        providerId: args.config.providerId,
        model: args.config.model,
        ...generationMetadata(args.generation),
        ...(input.images?.length ? { images: persistedImageAttachments(input.images) } : {}),
      }),
    });
    const checkpoint = new FileCheckpointManager(args.rootDir, args.session, record.uuid);
    await checkpoint.createSnapshot();
    runtime.checkpoint = checkpoint;
    args.messages.push({ role: "user", content, ...(input.images?.length ? { images: input.images } : {}) });
  }
}

async function processInputBoundary(args: RunLoopArgs, runtime: LoopRuntime): Promise<void> {
  await args.runToolBoundaryCommands?.();
  await injectPendingUserInputs(args, runtime);
}

/** Materialize every request-bound input, then enforce the mandatory hard ceiling. */
async function prepareExactProviderBoundary(
  args: RunLoopArgs,
  runtime: LoopRuntime,
): Promise<{ compacted: boolean; blocked: boolean; error?: AutoCompactBlockedError }> {
  await materializeBackgroundProcessNotifications({
    messages: args.messages,
    processManager: runtime.processManager,
    session: args.session,
  });
  if (args.profile.id === "stage" || !args.config.limits?.autoCompact) {
    return { compacted: false, blocked: false };
  }
  return runMidTurnCompaction(args, runtime, true);
}

async function recordNoProgressBreak(session: SessionStore, consecutiveFailures: number): Promise<void> {
  await session.append({
    role: "system",
    content: `Tool loop stopped after ${consecutiveFailures} consecutive rounds of failing tool results.`,
    metadata: withExecutionRound(session.sessionId, { kind: "no-progress-breaker" }),
  });
}

/**
 * One mid-turn automatic-compaction check. The soft check (onlyHardCeiling
 * false) runs after a complete tool batch; the hard check (onlyHardCeiling true)
 * runs after queued/background input has been drained, right before the next
 * provider request. On a compact the active in-memory message array is rebound
 * to the post-checkpoint history (replacement + retained frontier), and the
 * stale provider occupancy is cleared so the next check re-estimates. On a
 * hard-ceiling failure the loop is blocked: a system notice is appended and the
 * caller breaks before the unsafe request. The compact provider call is a
 * standalone request (never a bootstrap/loop turn) so it cannot re-enter this
 * check; the outer loop signal cancels it.
 */
async function runMidTurnCompaction(
  args: RunLoopArgs,
  runtime: LoopRuntime,
  onlyHardCeiling: boolean,
): Promise<{ compacted: boolean; blocked: boolean; error?: AutoCompactBlockedError }> {
  const estimatedNextRequestTokens = estimateRequestTokens(args.messages, args.systemPrompt, args.tools);
  const result = await runAutomaticCompaction({
    rootDir: args.rootDir,
    sessionId: args.session.sessionId,
    engine: args.profile.id,
    providerSelection: { provider: args.config.providerId, model: args.config.model },
    generation: args.generation,
    signal: args.signal,
    onEvent: args.onEvent,
    phase: "mid-turn",
    onlyHardCeiling,
    estimateReplacementTokens: (replacement) => estimateRequestTokens(
      replacement.map(toVesicleMessage),
      args.systemPrompt,
      args.tools,
    ),
    budget: {
      config: args.config.limits?.autoCompact,
      limits: args.config.limits,
      generation: args.config.generation,
      turnMaxTokens: args.generation?.maxTokens,
      lastContextInputTokens: runtime.lastContextInputTokens,
      lastRequestObservation: runtime.lastRequestObservation,
      estimatedNextRequestTokens,
    },
  });
  if (result.kind === "cancelled") throw result.error;
  if (result.kind === "compacted") {
    runtime.lastContextInputTokens = undefined;
    runtime.lastRequestObservation = undefined;
    const snapshot = await loadSessionSnapshot(args.rootDir, args.session.sessionId, { synthesizeDanglingToolResults: false });
    const rebuilt = snapshot.messages.map(toVesicleMessage);
    args.messages.length = 0;
    args.messages.push(...rebuilt);
    return { compacted: true, blocked: false };
  }
  if (result.kind === "hard-failed") {
    await args.session.append({
      role: "system",
      content: `Context budget exceeded and automatic compaction failed: ${result.errorMessage} Run /compact manually or switch to a model with a larger context window.`,
      metadata: { kind: "compact-blocked" },
    });
    return {
      compacted: false,
      blocked: true,
      error: new AutoCompactBlockedError(
        result.errorMessage,
        result.check.kind === "hard-ceiling"
          ? {
            projectedTokens: result.check.projectedTokens,
            hardInputCeilingTokens: result.check.hardInputCeilingTokens,
            softTriggerTokens: result.check.softTriggerTokens,
            usageSource: result.check.usageSource,
          }
          : undefined,
        true,
      ),
    };
  }
  return { compacted: false, blocked: false };
}
