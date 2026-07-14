import type { VesicleMessage } from "../../providers/shared/types";
import type { AgentManager } from "../agents/manager";
import { executeAgentTool, agentToolNames } from "../agents/tools";
import { FileCheckpointManager } from "../checkpoints/file-history";
import type { PermissionRequest, PermissionResolution, ToolPermissionBroker } from "../permissions";
import { createPermissionRequest } from "../permissions";
import { getProcessManager } from "../process/manager";
import { loadSessionRecords } from "../session/store";
import type { ToolCall, ToolResult } from "../tools";
import { executeHostTool } from "../tools";
import { executionPlanHash, parseShellExecPlan } from "../tools/shell";
import type { ContinuationContextOptions } from "./continuation-context";
import { loadContinuationContext } from "./continuation-context";
import { recordToolResult } from "./tool-result-recorder";
import { validateDurablePermissionRequest } from "./permission-validation";
import { runLoop } from "./turn-loop";
import type { AgentLoopEvent, DeferredAgentPermission, RunPromptResult } from "./types";
import { createTurnAgentManager } from "./agent-manager";

type ResolvePermissionOptions = ContinuationContextOptions & {
  messages: VesicleMessage[];
  request: PermissionRequest;
  remainingToolCalls: ToolCall[];
  deferredAgentPermissions?: DeferredAgentPermission[];
  resolution: PermissionResolution;
  permissionBroker?: ToolPermissionBroker;
  signal?: AbortSignal;
  onEvent?: (event: AgentLoopEvent) => void;
  agentManager?: AgentManager;
};

type PermissionContext = Awaited<ReturnType<typeof loadContinuationContext>> & {
  checkpoint: FileCheckpointManager | undefined;
  agentManager: AgentManager;
};

export async function resolvePermission(options: ResolvePermissionOptions): Promise<RunPromptResult> {
  const state = await preparePermissionResolution(options);
  const batch = await collectPermissionBatch(options, state);
  if (batch.pause) return batch.pause;
  await executeAndRecordEntries(options, state, batch.entries);
  return continuePermissionSequence(options, state);
}

async function preparePermissionResolution(options: ResolvePermissionOptions) {
  const permission = options.permission ?? { mode: options.request.mode };
  const baseContext = await loadContinuationContext({ ...options, permission }, { emitAssetDrift: false });
  const context: PermissionContext = {
    ...baseContext,
    checkpoint: await FileCheckpointManager.resumeLatest(baseContext.rootDir, baseContext.session),
    agentManager: options.agentManager ?? createTurnAgentManager(baseContext.rootDir, options.onEvent),
  };
  const messages = [...options.messages];
  const records = await loadSessionRecords(context.rootDir, options.sessionId);
  validateDurablePermissionRequest({
    sessionId: options.sessionId,
    messages,
    request: options.request,
    deferredAgentPermissions: options.deferredAgentPermissions,
    records,
  });

  const call = permissionCall(options.request);
  const capabilityAvailable = context.toolSurface.definitions.some((definition) => definition.function.name === call.name);
  const approvedShellPlanHash = options.resolution.decision === "allow_once" && capabilityAvailable && call.name === "shell_exec"
    ? executionPlanHash(parseShellExecPlan(call))
    : undefined;
  if (approvedShellPlanHash && (!options.request.planHash || approvedShellPlanHash !== options.request.planHash)) {
    throw new Error("The approved shell execution plan changed before execution; permission was not applied.");
  }

  await context.session.append({
    role: "system",
    content: `Permission ${options.resolution.decision} for ${call.name}.`,
    metadata: {
      kind: "permission-resolution",
      requestId: options.request.id,
      toolCallId: call.id,
      toolName: call.name,
      decision: options.resolution.decision,
      resolvedAt: options.resolution.resolvedAt,
      permissionMode: options.request.mode,
      decisionSource: "user",
      capabilityAvailable,
      ...(options.resolution.decision === "reject" && options.resolution.feedback ? { feedback: options.resolution.feedback } : {}),
    },
  });
  return { context, messages, call, approvedShellPlanHash };
}

async function collectPermissionBatch(
  options: ResolvePermissionOptions,
  state: Awaited<ReturnType<typeof preparePermissionResolution>>,
): Promise<{ entries: DeferredAgentPermission[]; pause?: RunPromptResult }> {
  const { context, messages, call } = state;
  const current = { request: options.request, resolution: options.resolution };
  const deferred = agentToolNames.has(call.name) ? [...(options.deferredAgentPermissions ?? []), current] : [];
  if (agentToolNames.has(call.name)) {
    const nextAgentIndex = options.remainingToolCalls.findIndex((candidate) => agentToolNames.has(candidate.name));
    if (nextAgentIndex >= 0) {
      const next = options.remainingToolCalls[nextAgentIndex]!;
      const remaining = options.remainingToolCalls.filter((_, index) => index !== nextAgentIndex);
      return { entries: [], pause: await createPermissionPause(context, messages, next, remaining, deferred, options.onEvent) };
    }
  }
  return { entries: agentToolNames.has(call.name) ? deferred : [current] };
}

async function executeAndRecordEntries(
  options: ResolvePermissionOptions,
  state: Awaited<ReturnType<typeof preparePermissionResolution>>,
  entries: DeferredAgentPermission[],
): Promise<void> {
  const { context, messages, approvedShellPlanHash } = state;
  const results = await Promise.all(entries.map(async (entry) => ({
    entry,
    result: await executeApprovedEntry(context, messages, entry, approvedShellPlanHash, options),
  })));
  for (const { entry, result } of results) {
    await recordToolResult({
      result,
      messages,
      session: context.session,
      processManager: getProcessManager(context.rootDir),
      metadata: {
        permissionRequestId: entry.request.id,
        permissionMode: entry.request.mode,
        decisionSource: "user",
        ...(result.agentEvent ? { agentEvent: result.agentEvent } : {}),
      },
      onEvent: options.onEvent,
    });
  }
}

async function continuePermissionSequence(
  options: ResolvePermissionOptions,
  state: Awaited<ReturnType<typeof preparePermissionResolution>>,
): Promise<RunPromptResult> {
  const { context, messages } = state;
  if (options.remainingToolCalls.length > 0) {
    const [next, ...remaining] = options.remainingToolCalls;
    return createPermissionPause(context, messages, next, remaining, undefined, options.onEvent);
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
    checkpoint: context.checkpoint,
    signal: options.signal,
    onEvent: options.onEvent,
    agentManager: context.agentManager,
    permission: context.permission,
    permissionBroker: options.permissionBroker,
    harness: context.harness,
    assets: context.assets,
  });
}

async function executeApprovedEntry(
  context: PermissionContext,
  messages: VesicleMessage[],
  entry: DeferredAgentPermission,
  approvedShellPlanHash: string | undefined,
  options: ResolvePermissionOptions,
): Promise<ToolResult> {
  const call = permissionCall(entry.request);
  if (entry.resolution.decision === "reject") {
    const content = context.harness && agentToolNames.has(call.name)
      ? JSON.stringify({
        error: {
          category: "denied",
          message: entry.resolution.feedback
            ? `Permission denied by the user. Feedback: ${entry.resolution.feedback}`
            : "Permission denied by the user.",
        },
      })
      : entry.resolution.feedback
        ? `Permission denied by the user. Feedback: ${entry.resolution.feedback}`
        : "Permission denied by the user.";
    return {
      callId: call.id,
      name: call.name,
      ok: false,
      content,
    };
  }
  if (!context.toolSurface.definitions.some((definition) => definition.function.name === call.name)) {
    return {
      callId: call.id,
      name: call.name,
      ok: false,
      content: `Permission was not applied because ${call.name} is no longer in the current Engine's effective tool surface. The tool was not executed.`,
    };
  }
  if (call.name === "shell_exec") {
    await context.checkpoint?.markTaintedByHostProcess();
    await context.session.append({
      role: "system",
      content: "Approved shell process started.",
      metadata: { kind: "process-started", requestId: entry.request.id, toolCallId: call.id, planHash: approvedShellPlanHash, checkpointTainted: true },
    });
  }
  if (agentToolNames.has(call.name)) {
    return executeAgentTool({
      call,
      manager: context.agentManager,
      rootDir: context.rootDir,
      parentSessionId: context.session.sessionId,
      invocation: {
        rootDir: context.rootDir,
        parentEngine: context.profile.id,
        providerSelection: { provider: context.config.providerId, model: context.config.model },
        generation: context.generation,
        parentToolDefinitions: context.toolSurface.definitions,
        parentSystemPrompt: context.systemPrompt,
        parentMessages: messages,
        parentSignal: options.signal,
        beforeMutation: async (paths) => context.checkpoint?.trackBeforeMutation(paths),
        permission: context.permission,
        permissionBroker: options.permissionBroker,
        harness: context.harness,
        assets: context.assets,
      },
    });
  }
  const mutationOwner = `${context.session.sessionId}:${call.id}`;
  try {
    return context.toolSurface.mcp.hasTool(call.name)
      ? await context.toolSurface.mcp.execute(call)
      : await executeHostTool(context.rootDir, call, {
        signal: options.signal,
        processManager: getProcessManager(context.rootDir),
        parentSessionId: context.session.sessionId,
        onProcessProgress: (processEvent) => options.onEvent?.({ type: "process_update", callId: call.id, processEvent }),
        beforeMutation: async (paths) => {
          await context.agentManager.claimHostMutation(mutationOwner, paths);
          await context.checkpoint?.trackBeforeMutation(paths);
        },
      });
  } finally {
    context.agentManager.releaseHostMutations(mutationOwner);
  }
}

async function createPermissionPause(
  context: PermissionContext,
  messages: VesicleMessage[],
  call: ToolCall,
  remainingToolCalls: ToolCall[],
  deferredAgentPermissions: DeferredAgentPermission[] | undefined,
  onEvent?: (event: AgentLoopEvent) => void,
): Promise<RunPromptResult> {
  const request = createPermissionRequest(context.session.sessionId, call, context.permission.mode);
  await context.session.append({ role: "system", content: `Permission required for ${call.name}.`, metadata: { kind: "permission-request", request } });
  onEvent?.({ type: "permission_pending", request });
  return {
    kind: "needs_permission",
    sessionId: context.session.sessionId,
    sessionPath: context.session.sessionPath,
    profile: context.profile,
    request,
    remainingToolCalls,
    ...(deferredAgentPermissions ? { deferredAgentPermissions } : {}),
    assistantContent: "",
    messages,
  };
}

function permissionCall(request: PermissionRequest): ToolCall {
  return { id: request.toolCallId, name: request.toolName, arguments: request.arguments };
}
