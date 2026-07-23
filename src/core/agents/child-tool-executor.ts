import type { McpRegistry } from "../../mcp/registry";
import type { PermissionDecisionSource, PermissionMode } from "../permissions";
import {
  createPermissionRequest,
  defaultPermissionRuntime,
  evaluatePermissionPolicy,
  permissionClassForTool,
} from "../permissions";
import type { FileCheckpointManager } from "../checkpoints/file-history";
import type { SessionStore } from "../session/store";
import { executeHostTool } from "../tools";
import type { ToolCall, ToolResult } from "../tools";
import type { AgentInvocationContext, AgentSpec } from "./types";

export type ChildToolExecution = {
  result: ToolResult;
  permissionMode: PermissionMode;
  decisionSource: PermissionDecisionSource;
};

type ChildToolContext = {
  call: ToolCall;
  runId: string;
  handle: string;
  spec: AgentSpec;
  signal: AbortSignal;
  invocation: AgentInvocationContext;
  session: SessionStore;
  mcp: McpRegistry;
  checkpoint: FileCheckpointManager;
  claimMutation(paths: string[]): Promise<void>;
};

export async function executeChildTool({
  call,
  runId,
  handle,
  spec,
  signal,
  invocation,
  session,
  mcp,
  checkpoint,
  claimMutation,
}: ChildToolContext): Promise<ChildToolExecution> {
  const permission = invocation.permission ?? defaultPermissionRuntime;
  const decision = evaluatePermissionPolicy(permission.mode, permissionClassForTool(call.name));
  if (decision !== "ask") {
    return {
      result: await executeApprovedTool(),
      permissionMode: permission.mode,
      decisionSource: "policy",
    };
  }

  const request = {
    ...createPermissionRequest(session.sessionId, call, permission.mode, permission.shellInterpreter),
    agent: { runId, handle, parentSessionId: spec.parentSessionId },
  };
  await session.append({
    role: "system",
    content: `Permission required for ${call.name}.`,
    metadata: { kind: "permission-request", request },
  });
  const resolution = invocation.permissionBroker
    ? await invocation.permissionBroker.request(request, signal)
    : { decision: "reject" as const, resolvedAt: new Date().toISOString(), feedback: "No interactive parent permission broker is available." };
  await session.append({
    role: "system",
    content: `Permission ${resolution.decision} for ${call.name}.`,
    metadata: {
      kind: "permission-resolution",
      requestId: request.id,
      toolCallId: call.id,
      decision: resolution.decision,
      resolvedAt: resolution.resolvedAt,
      permissionMode: request.mode,
      decisionSource: "user",
      ...(resolution.decision === "reject" && resolution.feedback ? { feedback: resolution.feedback } : {}),
    },
  });
  return {
    result: resolution.decision === "reject"
      ? {
        callId: call.id,
        name: call.name,
        ok: false,
        content: resolution.feedback
          ? `Permission denied by the user. Feedback: ${resolution.feedback}`
          : "Permission denied by the user.",
      }
      : await executeApprovedTool(),
    permissionMode: permission.mode,
    decisionSource: "user",
  };

  async function executeApprovedTool(): Promise<ToolResult> {
    return mcp.hasTool(call.name)
      ? mcp.execute(call)
      : executeHostTool(invocation.rootDir, call, {
        signal,
        shellInterpreter: permission.shellInterpreter,
        beforeMutation: async (paths) => {
          await claimMutation(paths);
          await invocation.beforeMutation?.(paths);
          await checkpoint.trackBeforeMutation(paths);
        },
      });
  }
}

export function agentToolProgress(call: ToolCall): string {
  let args: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(call.arguments) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) args = parsed as Record<string, unknown>;
  } catch {
    // The provider/tool layer will report malformed arguments normally. The
    // progress line remains useful without trying to duplicate validation.
  }
  const target = ["path", "target", "source", "url", "query", "pattern"]
    .map((key) => args[key])
    .find((value): value is string => typeof value === "string" && value.trim().length > 0);
  const suffix = target ? ` · ${target.replace(/\s+/g, " ").trim().slice(0, 120)}` : "";
  return `tool ${call.name}${suffix}`;
}
