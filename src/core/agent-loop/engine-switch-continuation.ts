import type { VesicleMessage } from "../../providers/shared/types";
import type { EngineId } from "../engine/profile";
import type { EngineSwitchRequest } from "../engine/switch";
import { ENGINE_HANDOFF_KIND, createModelEngineTransition, renderEngineHandoffPacket } from "../engine/transition";
import type { EngineContextPolicy } from "../engine/transition";
import type { GateResolution } from "../gate/types";
import type { ToolPermissionBroker } from "../permissions";
import { createSessionStore } from "../session/store";
import type { AgentLoopEvent, EngineSwitchConfirmedResult, ResolveEngineSwitchResult } from "./types";
import type { ContinuationContextOptions } from "./continuation-context";
import { loadContinuationContext } from "./continuation-context";
import { runLoop } from "./turn-loop";
import { FileCheckpointManager } from "../checkpoints/file-history";
import type { AgentManager } from "../agents/manager";
import { clearFrozenInstructionBlocks } from "./instruction-context";

type ResolveEngineSwitchOptions = ContinuationContextOptions & {
  messages: VesicleMessage[];
  toolCallId: string;
  request: EngineSwitchRequest;
  resolution: GateResolution;
  contextPolicy?: EngineContextPolicy;
  contextSummary?: string;
  permissionBroker?: ToolPermissionBroker;
  signal?: AbortSignal;
  onEvent?: (event: AgentLoopEvent) => void;
  agentManager?: AgentManager;
};

export async function resolveEngineSwitch(options: ResolveEngineSwitchOptions): Promise<ResolveEngineSwitchResult> {
  const rootDir = options.rootDir ?? process.cwd();
  const confirmed = options.resolution.decision === "confirm";
  const continuation = confirmed ? undefined : await loadContinuationContext(options);
  const session = continuation?.session ?? await createSessionStore(rootDir, options.sessionId);
  const transition = createModelEngineTransition(
    options.engine,
    options.request,
    confirmed ? "confirmed" : "rejected",
    {
      ...(options.contextPolicy ? { contextPolicy: options.contextPolicy } : {}),
      ...(options.contextSummary ? { contextSummary: options.contextSummary } : {}),
    },
  );
  const toolResultContent = JSON.stringify({
    ok: true,
    confirmed,
    result: engineSwitchResultMessage(options.request, options.resolution),
  });
  const messages: VesicleMessage[] = [...options.messages, {
    role: "tool",
    toolCallId: options.toolCallId,
    content: toolResultContent,
  }];
  await session.append({
    role: "tool",
    content: toolResultContent,
    metadata: {
      engine: options.engine,
      name: "request_engine_switch",
      ok: true,
      confirmed,
      toolCallId: options.toolCallId,
      targetEngine: options.request.targetEngine,
      decision: options.resolution.decision,
      ...(options.resolution.feedback ? { feedback: options.resolution.feedback } : {}),
      transition,
    },
  });

  if (confirmed) {
    return recordConfirmedSwitch(session, messages, options, transition);
  }
  if (!continuation) throw new Error("Missing engine-switch continuation context.");
  return runLoop({
    rootDir: continuation.rootDir,
    config: continuation.config,
    provider: continuation.provider,
    systemPrompt: continuation.systemPrompt,
    tools: continuation.toolSurface.definitions,
    mcpRegistry: continuation.toolSurface.mcp,
    messages,
    session,
    profile: continuation.profile,
    generation: continuation.generation,
    checkpoint: await FileCheckpointManager.resumeLatest(continuation.rootDir, session),
    signal: options.signal,
    onEvent: options.onEvent,
    onProviderContextSnapshot: options.onProviderContextSnapshot,
    agentManager: options.agentManager,
    permission: continuation.permission,
    permissionBroker: options.permissionBroker,
    harness: continuation.harness,
    assets: continuation.assets,
    experimentalQuality: continuation.experimentalQuality,
    takePendingUserInputs: options.takePendingUserInputs,
    runToolBoundaryCommands: options.runToolBoundaryCommands,
    injectPendingBeforeFirstProvider: true,
  });
}

async function recordConfirmedSwitch(
  session: Awaited<ReturnType<typeof createSessionStore>>,
  messages: VesicleMessage[],
  options: ResolveEngineSwitchOptions,
  transition: ReturnType<typeof createModelEngineTransition>,
): Promise<EngineSwitchConfirmedResult> {
  const handoffPacket = renderEngineHandoffPacket(transition);
  await session.append({
    role: "system",
    content: `Engine switched to ${options.request.targetEngine}.`,
    metadata: {
      kind: "engine-switch",
      engine: options.request.targetEngine,
      targetEngine: options.request.targetEngine,
      reason: options.request.reason,
      handoffSummary: options.request.handoffSummary,
      ...(options.request.recommendedNextAction ? { recommendedNextAction: options.request.recommendedNextAction } : {}),
      transition,
    },
  });
  await session.append({
    role: "user",
    content: handoffPacket,
    metadata: { kind: ENGINE_HANDOFF_KIND, engine: options.request.targetEngine, transition },
  });
  messages.push({ role: "user", content: handoffPacket });
  clearFrozenInstructionBlocks(session.sessionId);
  return {
    kind: "engine_switched",
    sessionId: session.sessionId,
    sessionPath: session.sessionPath,
    messages,
    request: options.request,
    resolution: options.resolution,
    engine: options.request.targetEngine as EngineId,
  };
}

function engineSwitchResultMessage(request: EngineSwitchRequest, resolution: GateResolution): string {
  if (resolution.decision === "confirm") {
    const next = request.recommendedNextAction ? ` Recommended next action: ${request.recommendedNextAction}` : "";
    return `Engine switch confirmed. Future turns will use "${request.targetEngine}". Handoff summary: ${request.handoffSummary}${next}`;
  }
  return resolution.feedback
    ? `Engine switch rejected; stay in the current engine. Discuss this or revise the handoff according to the user's note: ${resolution.feedback}`
    : "Engine switch rejected without specific feedback; stay in the current engine and ask what should change before retrying.";
}
