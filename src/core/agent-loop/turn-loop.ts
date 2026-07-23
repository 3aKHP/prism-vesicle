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
import type { ToolDefinition } from "../tools";
import { createTurnAgentManager } from "./agent-manager";
import { recordAssistantToolCalls } from "./assistant-recorder";
import { resolveInteractionPause } from "./interaction-pause";
import { completeProviderRound, emitAssistantResponse } from "./provider-round";
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
};

export async function runLoop(args: RunLoopArgs): Promise<RunPromptResult> {
  try {
    return await runLoopInternal(args);
  } catch (error) {
    clearFrozenInstructionBlocks(args.session.sessionId);
    throw error;
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

  if (args.injectPendingBeforeFirstProvider) await processInputBoundary(args, runtime);

  // Recompose from the frozen instruction snapshot before the first round. This
  // matters for a MANUAL/INERTIA resume: the approved update_instructions ran
  // (refreshing the snapshot) AFTER the continuation context was built, so the
  // first provider round of the resumed loop must pick up the new instructions.
  refreshLiveSystemPrompt(args);

  for (let iteration = 0; iteration < maxToolIterations; iteration++) {
    const round = await advanceRound(args, runtime, iteration);
    response = round.response;
    if (round.pause) return round.pause;
    if (!round.hadToolCalls) break;
    // A tool round may have refreshed the in-turn frozen instruction snapshot
    // (update_instructions). Recompose the live system prompt so the next
    // provider round observes the new instructions. Stage has no instruction
    // tools and must keep its frozen character-context suffix, so it is skipped.
    refreshLiveSystemPrompt(args);
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
  };
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
      metadata: {
        kind: "queued-user-message",
        engine: args.profile.id,
        provider: args.config.provider,
        providerId: args.config.providerId,
        model: args.config.model,
        ...generationMetadata(args.generation),
        ...(input.images?.length ? { images: persistedImageAttachments(input.images) } : {}),
      },
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

async function recordNoProgressBreak(session: SessionStore, consecutiveFailures: number): Promise<void> {
  await session.append({
    role: "system",
    content: `Tool loop stopped after ${consecutiveFailures} consecutive rounds of failing tool results.`,
    metadata: { kind: "no-progress-breaker" },
  });
}
