import type { VesicleMessage } from "../../providers/shared/types";
import type { AgentManager } from "../agents/manager";
import { FileCheckpointManager } from "../checkpoints/file-history";
import type { ToolPermissionBroker } from "../permissions";
import { loadSessionSnapshot } from "../session/store";
import type { ContinuationContextOptions } from "./continuation-context";
import { loadContinuationContext } from "./continuation-context";
import { runLoop } from "./turn-loop";
import { hydrateQualityTargets } from "../quality";
import type { AgentLoopEvent, RunPromptResult } from "./types";

type ResumeQualityRewriteOptions = ContinuationContextOptions & {
  permissionBroker?: ToolPermissionBroker;
  signal?: AbortSignal;
  onEvent?: (event: AgentLoopEvent) => void;
  agentManager?: AgentManager;
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
    qualityState: {
      attempts: pending.attempts,
      rejectedHashes: new Set(pending.rejectedHashes),
      candidateParts: pending.candidateParts,
      targets: hydrateQualityTargets(pending.targets),
    },
  });
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
