import type { VesicleMessage } from "../../providers/shared/types";
import type { GateRequest, GateResolution } from "../gate/types";
import type { AgentLoopEvent, RunPromptResult } from "./types";
import type { ContinuationContextOptions } from "./continuation-context";
import { loadContinuationContext } from "./continuation-context";
import { generationMetadata } from "./generation";
import { runLoop } from "./turn-loop";
import type { ToolPermissionBroker } from "../permissions";
import { FileCheckpointManager } from "../checkpoints/file-history";
import type { AgentManager } from "../agents/manager";

type ResolveGateOptions = ContinuationContextOptions & {
  messages: VesicleMessage[];
  toolCallId: string;
  gate: GateRequest;
  resolution: GateResolution;
  permissionBroker?: ToolPermissionBroker;
  signal?: AbortSignal;
  onEvent?: (event: AgentLoopEvent) => void;
  agentManager?: AgentManager;
};

export async function resolveGate(options: ResolveGateOptions): Promise<RunPromptResult> {
  const context = await loadContinuationContext(options);
  const toolResultContent = JSON.stringify({ ok: true, result: gateResultMessage(options.resolution) });
  const messages: VesicleMessage[] = [...options.messages, {
    role: "tool",
    toolCallId: options.toolCallId,
    content: toolResultContent,
  }];
  await context.session.append({
    role: "tool",
    content: toolResultContent,
    metadata: {
      kind: "gate-resolution",
      engine: options.engine,
      name: "request_confirmation",
      ok: true,
      toolCallId: options.toolCallId,
      gate: options.gate.gate,
      decision: options.resolution.decision,
    },
  });

  const userFollowUp = gateFollowUpMessage(options.gate, options.resolution);
  messages.push({ role: "user", content: userFollowUp });
  await context.session.append({
    role: "user",
    content: userFollowUp,
    metadata: {
      kind: "gate-resolution",
      engine: options.engine,
      provider: context.config.provider,
      providerId: context.config.providerId,
      model: context.config.model,
      ...generationMetadata(context.generation),
    },
  });

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
  });
}

function gateResultMessage(resolution: GateResolution): string {
  if (resolution.decision === "confirm") {
    return resolution.feedback
      ? `Confirmed. Note from user: ${resolution.feedback}`
      : "Confirmed. Proceed to the next phase.";
  }
  return resolution.feedback
    ? `User rejected proceeding for now. Discuss this or revise according to the user's note: ${resolution.feedback}`
    : "User rejected proceeding for now without specific feedback. Ask what should change or discuss the blocked decision before retrying.";
}

function gateFollowUpMessage(gate: GateRequest, resolution: GateResolution): string {
  const head = `[gate:${gate.gate} resolved as ${resolution.decision}]`;
  return resolution.feedback ? `${head} ${resolution.feedback}` : head;
}
