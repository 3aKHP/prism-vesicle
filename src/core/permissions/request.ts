import type { ToolCall } from "../tools";
import { executionPlanHash, parseShellExecPlan } from "../tools/shell";
import { permissionClassForTool } from "./policy";
import type { PermissionMode, PermissionRequest } from "./types";
import type { ShellInterpreterPreference } from "../process/shell-profile";

export function createPermissionRequest(
  sessionId: string,
  call: ToolCall,
  mode: PermissionMode,
  shellInterpreter: ShellInterpreterPreference = "auto",
): PermissionRequest {
  const permissionClass = permissionClassForTool(call.name);
  if (permissionClass === "interaction") {
    throw new Error(`Interactive host request ${call.name} does not use Tool Permission Runtime.`);
  }
  if (call.name === "shell_exec") {
    const executionPlan = parseShellExecPlan(call, shellInterpreter);
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
  if (request.qualityState && !validQualityState(request.qualityState)) return undefined;
  return request as PermissionRequest;
}

function validQualityState(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const state = value as Record<string, unknown>;
  return typeof state.producer === "string"
    && typeof state.packId === "string"
    && typeof state.packVersion === "string"
    && typeof state.manifestSha256 === "string"
    && /^[a-f0-9]{64}$/.test(state.manifestSha256)
    && typeof state.ruleVersion === "string"
    && typeof state.ruleSourceHash === "string"
    && /^[a-f0-9]{64}$/.test(state.ruleSourceHash)
    && Number.isInteger(state.attempts)
    && Number(state.attempts) >= 0
    && Array.isArray(state.rejectedHashes)
    && state.rejectedHashes.every((hash) => typeof hash === "string" && /^[a-f0-9]{64}$/.test(hash))
    && Array.isArray(state.candidateParts)
    && state.candidateParts.every((part) => typeof part === "string")
    && (state.targets === undefined || validQualityTargets(state.targets));
}

function validQualityTargets(value: unknown): boolean {
  return Array.isArray(value) && value.every((target) => {
    if (!target || typeof target !== "object" || Array.isArray(target)) return false;
    const item = target as Record<string, unknown>;
    return typeof item.id === "string"
      && item.id === `artifact:${item.path}`
      && item.kind === "artifact-post-image"
      && typeof item.candidateType === "string"
      && typeof item.path === "string"
      && ["create", "write", "replace", "append"].includes(String(item.operation))
      && Array.isArray(item.mutationCallIds)
      && item.mutationCallIds.length > 0
      && item.mutationCallIds.every((id) => typeof id === "string" && id.length > 0)
      && typeof item.postImageHash === "string"
      && /^[a-f0-9]{64}$/.test(item.postImageHash)
      && typeof item.bytes === "number"
      && item.bytes >= 0
      && Array.isArray(item.rejectedHashes)
      && item.rejectedHashes.every((hash) => typeof hash === "string" && /^[a-f0-9]{64}$/.test(hash));
  });
}
