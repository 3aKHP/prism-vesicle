import type { ExperimentalQualityProfile } from "../../config/quality";
import type { VesicleMessage } from "../../providers/shared/types";
import type { AgentManager } from "../agents/manager";
import { FileCheckpointManager } from "../checkpoints/file-history";
import type { ToolPermissionBroker } from "../permissions";
import { loadSessionSnapshot } from "../session/store";
import {
  hydrateQualityTargets,
  type DurableQualityState,
  type QualityRewriteState,
  type QualityRuntimeContext,
} from "../quality";
import type { ContinuationContextOptions } from "./continuation-context";
import { loadContinuationContext } from "./continuation-context";
import { runLoop } from "./turn-loop";
import type { AgentLoopEvent, RunPromptResult } from "./types";

export type QualityContinuationOptions = ContinuationContextOptions & {
  permissionBroker?: ToolPermissionBroker;
  signal?: AbortSignal;
  onEvent?: (event: AgentLoopEvent) => void;
  agentManager?: AgentManager;
};

export type QualityContinuationContext = Awaited<ReturnType<typeof loadContinuationContext>>;

export async function resumePendingQualityRewrite(
  options: QualityContinuationOptions,
): Promise<RunPromptResult> {
  const snapshot = await loadSessionSnapshot(options.rootDir ?? process.cwd(), options.sessionId, {
    synthesizeDanglingToolResults: false,
  });
  const pending = snapshot.pendingQualityRewrite;
  if (!pending) throw new Error("Session does not have a pending Output Quality Guard rewrite.");
  if (snapshot.pendingPermission) {
    throw new Error("Pending tool permission must be resolved before the Output Quality Guard rewrite can continue.");
  }
  if (pending.producer !== options.engine) {
    throw new Error("Pending quality rewrite Engine does not match the requested continuation.");
  }
  const context = await loadContinuationContext(options);
  if (!matchesQualityIdentity(context.harness?.quality, pending)) {
    throw new Error("Pending quality rewrite cannot resume without the same verified Harness and Rule Pack identity.");
  }
  assertExperimentalJudgeIdentity(context.experimentalQuality, pending.experimentalJudge);
  return runQualityContinuation({
    options,
    context,
    messages: snapshot.messages.map(toVesicleMessage),
    qualityState: hydrateQualityState(pending),
  });
}

export async function runQualityContinuation(input: {
  options: QualityContinuationOptions;
  context: QualityContinuationContext;
  messages: VesicleMessage[];
  qualityState: QualityRewriteState;
}): Promise<RunPromptResult> {
  const { context, options } = input;
  return runLoop({
    rootDir: context.rootDir,
    config: context.config,
    provider: context.provider,
    systemPrompt: context.systemPrompt,
    enginePrompt: context.enginePrompt,
    tools: context.toolSurface.definitions,
    mcpRegistry: context.toolSurface.mcp,
    messages: input.messages,
    session: context.session,
    profile: context.profile,
    generation: context.generation,
    checkpoint: await FileCheckpointManager.resumeLatest(context.rootDir, context.session),
    signal: options.signal,
    onEvent: options.onEvent,
    onProviderContextSnapshot: options.onProviderContextSnapshot,
    agentManager: options.agentManager,
    permission: context.permission,
    permissionBroker: options.permissionBroker,
    harness: context.harness,
    assets: context.assets,
    experimentalQuality: context.experimentalQuality,
    takePendingUserInputs: options.takePendingUserInputs,
    runToolBoundaryCommands: options.runToolBoundaryCommands,
    injectPendingBeforeFirstProvider: true,
    qualityState: input.qualityState,
  });
}

export function hydrateQualityState(
  state: DurableQualityState,
  overrides: Partial<Pick<QualityRewriteState, "warningId" | "warningTargetIds" | "candidate">> = {},
): QualityRewriteState {
  return {
    attempts: state.attempts,
    rejectedHashes: new Set(state.rejectedHashes),
    candidateParts: state.candidateParts,
    targets: hydrateQualityTargets(state.targets),
    warningId: overrides.warningId ?? state.warningId,
    warningTargetIds: overrides.warningTargetIds ?? state.warningTargetIds,
    candidate: overrides.candidate ?? state.candidate,
    experimentalJudge: state.experimentalJudge,
  };
}

export function assertQualityIdentity(
  quality: QualityRuntimeContext | undefined,
  pending: DurableQualityState,
): void {
  if (!matchesQualityIdentity(quality, pending)) {
    throw new Error(
      `Pending quality decision requires ${pending.packId}@${pending.packVersion} `
      + `with Rule Pack ${pending.ruleVersion}; the active verified identity does not match.`,
    );
  }
}

export function assertExperimentalJudgeIdentity(
  profile: ExperimentalQualityProfile | undefined,
  pending: DurableQualityState["experimentalJudge"],
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

export function matchesQualityIdentity(
  quality: QualityRuntimeContext | undefined,
  pending: DurableQualityState,
): quality is QualityRuntimeContext {
  return Boolean(quality
    && quality.packId === pending.packId
    && quality.packVersion === pending.packVersion
    && quality.manifestSha256 === pending.manifestSha256
    && quality.ruleManifest.version === pending.ruleVersion
    && quality.ruleManifest.sourceHash === pending.ruleSourceHash);
}

export function toVesicleMessage(
  message: Awaited<ReturnType<typeof loadSessionSnapshot>>["messages"][number],
): VesicleMessage {
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
