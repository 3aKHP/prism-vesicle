import type { VesicleConfig } from "../../config/env";
import type { VesicleMessage, VesicleRequest } from "../../providers/shared/types";
import { executeAgentTool, agentToolNames } from "../agents/tools";
import type { AgentManager } from "../agents/manager";
import type { EngineProfile } from "../engine/profile";
import type { ToolPermissionBroker, PermissionRuntimeOptions } from "../permissions";
import type { ProcessManager } from "../process/manager";
import type { SessionStore } from "../session/store";
import { executeHostTool } from "../tools";
import type { ToolCall, ToolDefinition, ToolResult } from "../tools";
import { executionPlanHash, parseShellExecPlan } from "../tools/shell";
import type { McpRegistry } from "../../mcp/registry";
import type { AgentLoopEvent } from "./types";
import type { ToolRoundPlan } from "./tool-round-planner";
import { emitToolResultEvent, failedToolResult, recordToolResult } from "./tool-result-recorder";
import type { HarnessDelegationDecision, HarnessRuntimeContext } from "../harness/driver";
import type { AssetResolver } from "../runtime/assets";
import { appendHarnessDelegationDecision, type DelegationPause } from "./delegation-decision";

type ExecuteToolRoundOptions = {
  plan: ToolRoundPlan;
  rootDir: string;
  config: VesicleConfig;
  systemPrompt: string;
  tools: ToolDefinition[];
  mcpRegistry: McpRegistry;
  messages: VesicleMessage[];
  parentMessagesBeforeToolCall: VesicleMessage[];
  session: SessionStore;
  profile: EngineProfile;
  generation?: VesicleRequest["generation"];
  signal?: AbortSignal;
  onEvent?: (event: AgentLoopEvent) => void;
  agentManager: AgentManager;
  processManager: ProcessManager;
  permission: PermissionRuntimeOptions;
  permissionBroker?: ToolPermissionBroker;
  trackCheckpointMutation: (paths: string[]) => Promise<void>;
  markCheckpointTainted: () => Promise<void>;
  harness?: HarnessRuntimeContext;
  assets?: AssetResolver;
};

export async function executeToolRound(options: ExecuteToolRoundOptions): Promise<{
  anyFailed: boolean;
  delegationPause?: DelegationPause;
}> {
  const { plan } = options;
  const agentCalls = plan.executableHostToolCalls.filter((call) =>
    agentToolNames.has(call.name) && !plan.unavailableHostCallIds.has(call.id)
  );
  let contractSpawnSeen = false;
  const agentExecutions = new Map(agentCalls.map((call) => {
    if (options.harness && call.name === "spawn_agent" && contractSpawnSeen) {
      return [call.id, Promise.resolve(failedToolResult(
        call.id,
        call.name,
        JSON.stringify({ error: { category: "invalid_request", message: "Contract-bound delegations must be issued sequentially." } }),
      ))];
    }
    if (options.harness && call.name === "spawn_agent") contractSpawnSeen = true;
    return [call.id, executeAgentCall(options, call)];
  }));
  const nonAgent = await executeNonAgentCalls(options);
  const agents = await recordAgentCalls(options, agentCalls, agentExecutions);
  throwToolErrors(nonAgent.error, agents.errors);
  const delegationPause = agents.delegationDecision
    ? await appendHarnessDelegationDecision({
      decision: agents.delegationDecision,
      messages: options.messages,
      session: options.session,
      engine: options.profile.id,
      redirectCalls: options.plan.interactiveCalls,
      onEvent: options.onEvent,
    })
    : undefined;
  return {
    anyFailed: nonAgent.anyFailed || agents.anyFailed,
    ...(delegationPause ? { delegationPause } : {}),
  };
}

async function executeNonAgentCalls(
  options: ExecuteToolRoundOptions,
): Promise<{ anyFailed: boolean; error?: unknown }> {
  let anyFailed = false;

  try {
    for (const call of options.plan.executableHostToolCalls) {
      if (options.plan.unavailableHostCallIds.has(call.id)) {
        options.onEvent?.({ type: "tool_call", name: call.name, callId: call.id, arguments: call.arguments });
        await recordUnavailableTool(options, call);
        anyFailed = true;
        continue;
      }
      if (agentToolNames.has(call.name)) continue;
      options.onEvent?.({ type: "tool_call", name: call.name, callId: call.id, arguments: call.arguments });
      await recordPolicyApprovedShellStart(options, call);
      const result = await executeHostCall(options, call);
      await recordToolResult({
        result,
        messages: options.messages,
        session: options.session,
        processManager: options.processManager,
        metadata: {
          permissionMode: options.permission.mode,
          decisionSource: decisionSource(options.permission),
        },
        onEvent: options.onEvent,
      });
      if (!result.ok) anyFailed = true;
    }
  } catch (error) {
    return { anyFailed, error };
  }
  return { anyFailed };
}

async function recordAgentCalls(
  options: ExecuteToolRoundOptions,
  agentCalls: ToolCall[],
  executions: Map<string, Promise<ToolResult>>,
): Promise<{ anyFailed: boolean; errors: unknown[]; delegationDecision?: HarnessDelegationDecision }> {
  const errors: unknown[] = [];
  let anyFailed = false;
  let delegationDecision: HarnessDelegationDecision | undefined;
  for (const call of agentCalls) {
    try {
      options.onEvent?.({ type: "tool_call", name: call.name, callId: call.id, arguments: call.arguments });
    } catch (error) {
      errors.push(error);
    }
    let result: ToolResult;
    try {
      result = await executions.get(call.id)!;
    } catch (error) {
      errors.push(error);
      continue;
    }
    try {
      await recordToolResult({
        result,
        messages: options.messages,
        session: options.session,
        metadata: {
          permissionMode: options.permission.mode,
          decisionSource: decisionSource(options.permission),
          ...(result.agentEvent ? {
            kind: "subagent-result",
            agentEvent: result.agentEvent,
            ...(result.agentEvent.usage ? { usage: result.agentEvent.usage } : {}),
          } : {}),
          ...(result.delegationDecision ? { delegationDecision: result.delegationDecision } : {}),
        },
        emitEvent: false,
      });
    } catch (error) {
      errors.push(error);
    }
    if (!result.ok) anyFailed = true;
    if (result.delegationDecision && !delegationDecision) delegationDecision = result.delegationDecision;
    try {
      emitToolResultEvent(result, options.onEvent);
    } catch (error) {
      errors.push(error);
    }
  }
  return { anyFailed, errors, ...(delegationDecision ? { delegationDecision } : {}) };
}

async function recordUnavailableTool(options: ExecuteToolRoundOptions, call: ToolCall): Promise<void> {
  await recordToolResult({
    result: failedToolResult(
      call.id,
      call.name,
      `${call.name} is not in the current Engine's effective tool surface. The tool was not executed.`,
    ),
    messages: options.messages,
    session: options.session,
    metadata: {
      reason: "tool-not-in-effective-surface",
      permissionMode: options.permission.mode,
      decisionSource: decisionSource(options.permission),
    },
    onEvent: options.onEvent,
  });
}

function executeAgentCall(options: ExecuteToolRoundOptions, call: ToolCall): Promise<ToolResult> {
  return executeAgentTool({
    call,
    manager: options.agentManager,
    rootDir: options.rootDir,
    parentSessionId: options.session.sessionId,
    invocation: {
      rootDir: options.rootDir,
      parentEngine: options.profile.id,
      providerSelection: { provider: options.config.providerId, model: options.config.model },
      generation: options.generation,
      parentToolDefinitions: options.tools,
      parentSystemPrompt: options.systemPrompt,
      parentMessages: options.parentMessagesBeforeToolCall,
      parentSignal: options.signal,
      beforeMutation: options.trackCheckpointMutation,
      permission: options.permission,
      permissionBroker: options.permissionBroker,
      harness: options.harness,
      assets: options.assets,
    },
  });
}

async function executeHostCall(options: ExecuteToolRoundOptions, call: ToolCall): Promise<ToolResult> {
  const mutationOwner = `${options.session.sessionId}:${call.id}`;
  try {
    return options.mcpRegistry.hasTool(call.name)
      ? await options.mcpRegistry.execute(call)
      : await executeHostTool(options.rootDir, call, {
        signal: options.signal,
        processManager: options.processManager,
        parentSessionId: options.session.sessionId,
        onProcessProgress: (processEvent) => options.onEvent?.({ type: "process_update", callId: call.id, processEvent }),
        beforeMutation: async (paths) => {
          await options.agentManager.claimHostMutation(mutationOwner, paths);
          await options.trackCheckpointMutation(paths);
        },
      });
  } finally {
    options.agentManager.releaseHostMutations(mutationOwner);
  }
}

async function recordPolicyApprovedShellStart(options: ExecuteToolRoundOptions, call: ToolCall): Promise<void> {
  if (call.name !== "shell_exec") return;
  try {
    const planHash = executionPlanHash(parseShellExecPlan(call));
    await options.markCheckpointTainted();
    await options.session.append({
      role: "system",
      content: "Policy-approved shell process started.",
      metadata: {
        kind: "process-started",
        requestId: `policy:${call.id}`,
        toolCallId: call.id,
        planHash,
        permissionMode: options.permission.mode,
        decisionSource: decisionSource(options.permission),
        checkpointTainted: true,
      },
    });
  } catch {
    // Invalid arguments are returned through the normal tool wrapper.
  }
}

function decisionSource(permission: PermissionRuntimeOptions): "cli_override" | "policy" {
  return permission.dangerouslySkipPermissions ? "cli_override" : "policy";
}

function throwToolErrors(nonAgentError: unknown, agentErrors: unknown[]): void {
  if (nonAgentError && agentErrors.length > 0) {
    throw new AggregateError([nonAgentError, ...agentErrors], "Host and SubAgent tool processing failed.");
  }
  if (nonAgentError) throw nonAgentError;
  if (agentErrors.length === 1) throw agentErrors[0];
  if (agentErrors.length > 1) throw new AggregateError(agentErrors, "SubAgent tool processing failed.");
}
