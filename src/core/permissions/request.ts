import type { ToolCall } from "../tools";
import { executionPlanHash, parseShellExecPlan } from "../tools/shell";
import { permissionClassForTool } from "./policy";
import type { PermissionMode, PermissionRequest } from "./types";

export function createPermissionRequest(
  sessionId: string,
  call: ToolCall,
  mode: PermissionMode,
): PermissionRequest {
  const permissionClass = permissionClassForTool(call.name);
  if (permissionClass === "interaction") {
    throw new Error(`Interactive host request ${call.name} does not use Tool Permission Runtime.`);
  }
  if (call.name === "shell_exec") {
    const executionPlan = parseShellExecPlan(call);
    return {
      id: crypto.randomUUID(),
      sessionId,
      toolCallId: call.id,
      toolName: call.name,
      arguments: call.arguments,
      permissionClass,
      mode,
      createdAt: new Date().toISOString(),
      executionPlan,
      planHash: executionPlanHash(executionPlan),
    };
  }
  return {
    id: crypto.randomUUID(),
    sessionId,
    toolCallId: call.id,
    toolName: call.name,
    arguments: call.arguments,
    permissionClass,
    mode,
    createdAt: new Date().toISOString(),
  };
}

export function parsePermissionRequest(value: unknown): PermissionRequest | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const request = value as Partial<PermissionRequest>;
  if (
    typeof request.id !== "string"
    || typeof request.sessionId !== "string"
    || typeof request.toolCallId !== "string"
    || typeof request.toolName !== "string"
    || typeof request.arguments !== "string"
    || typeof request.createdAt !== "string"
    || (request.permissionClass !== "observe" && request.permissionClass !== "mutate" && request.permissionClass !== "arbitrary_exec")
    || (request.mode !== "MANUAL" && request.mode !== "INERTIA" && request.mode !== "MOMENTUM" && request.mode !== "YOLO")
  ) return undefined;
  if (permissionClassForTool(request.toolName) !== request.permissionClass) return undefined;
  return request as PermissionRequest;
}
