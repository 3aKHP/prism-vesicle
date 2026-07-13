import type { ToolCall, ToolDefinition } from "../tools";
import { evaluatePermissionPolicy, permissionClassForTool } from "../permissions";
import type { PermissionRuntimeOptions } from "../permissions";
import { parseShellExecPlan } from "../tools/shell";

const interactionToolNames = new Set([
  "request_confirmation",
  "request_engine_switch",
  "ask_user_question",
]);

export type ToolRoundPlan = {
  hostToolCalls: ToolCall[];
  interactiveCalls: ToolCall[];
  executableHostToolCalls: ToolCall[];
  permissionRequiredCalls: ToolCall[];
  unavailableHostCallIds: Set<string>;
};

export function planToolRound(
  toolCalls: ToolCall[],
  tools: ToolDefinition[],
  permission: PermissionRuntimeOptions,
): ToolRoundPlan {
  const hostToolCalls: ToolCall[] = [];
  const interactiveCalls: ToolCall[] = [];
  for (const call of toolCalls) {
    (interactionToolNames.has(call.name) ? interactiveCalls : hostToolCalls).push(call);
  }

  const effectiveToolNames = new Set(tools.map((definition) => definition.function.name));
  const unavailableHostCallIds = new Set(hostToolCalls.flatMap((call) =>
    effectiveToolNames.has(call.name) ? [] : [call.id]
  ));
  const invalidShellCallIds = new Set(hostToolCalls.flatMap((call) => {
    if (call.name !== "shell_exec") return [];
    try {
      parseShellExecPlan(call);
      return [];
    } catch {
      return [call.id];
    }
  }));
  const permissionRequiredCalls = hostToolCalls.filter((call) =>
    !unavailableHostCallIds.has(call.id)
    && !invalidShellCallIds.has(call.id)
    && evaluatePermissionPolicy(permission.mode, permissionClassForTool(call.name)) === "ask"
  );
  const permissionRequiredIds = new Set(permissionRequiredCalls.map((call) => call.id));

  return {
    hostToolCalls,
    interactiveCalls,
    permissionRequiredCalls,
    unavailableHostCallIds,
    executableHostToolCalls: hostToolCalls.filter((call) => !permissionRequiredIds.has(call.id)),
  };
}
