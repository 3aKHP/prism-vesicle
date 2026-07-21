import { createEmptyMcpRegistry, createMcpRegistryForEngine, type McpRegistry, type McpRegistryOptions } from "../../mcp/registry";
import { agentToolDefinitions } from "../agents/tools";
import type { EngineProfile } from "../engine/profile";
import { engineSwitchToolDefinition } from "../engine/switch";
import { gateToolDefinition } from "../gate/types";
import { createShellExecToolDefinition, hostToolDefinitions } from "../tools";
import type { ToolDefinition } from "../tools";
import { resolveShellProfile, type ShellInterpreterPreference } from "../process/shell-profile";
import { askUserQuestionToolDefinition } from "../user-question/types";

const hostContractNames = new Set(["config.load", "prompt.load", "session.write"]);

export type ToolSurface = {
  definitions: ToolDefinition[];
  mcp: McpRegistry;
};

export async function resolveToolSurface(
  profile: EngineProfile,
  visionEnabled: boolean,
  shellExecEnabled = false,
  shellInterpreter: ShellInterpreterPreference = "auto",
  mcpOptions: McpRegistryOptions = {},
): Promise<ToolSurface> {
  const mcp = profile.id === "stage"
    ? createEmptyMcpRegistry()
    : await createMcpRegistryForEngine(profile.id, mcpOptions);
  const shellProfile = shellExecEnabled ? resolveShellProfile(shellInterpreter) : undefined;
  const builtIns = resolveBuiltInTools(profile, visionEnabled, shellExecEnabled, shellInterpreter);
  const shellTools = shellExecEnabled
    ? hostToolDefinitions
      .filter((tool) => tool.function.name === "shell_exec" || tool.function.name === "shell_output" || tool.function.name === "shell_stop")
      .filter((tool) => tool.function.name !== "shell_exec" || shellProfile)
      .map((tool) => tool.function.name === "shell_exec" ? createShellExecToolDefinition(shellProfile) : tool)
    : [];
  return {
    definitions: [
      ...builtIns,
      ...(profile.id === "stage"
        ? []
        : shellTools.filter((tool) => !builtIns.some((candidate) => candidate.function.name === tool.function.name))),
      ...(profile.id === "stage" ? [] : mcp.definitions),
      ...(profile.id === "stage" ? [] : agentToolDefinitions),
    ],
    mcp,
  };
}

export function resolveBuiltInTools(
  profile: EngineProfile,
  visionEnabled: boolean,
  shellExecEnabled = false,
  shellInterpreter: ShellInterpreterPreference = "auto",
): ToolDefinition[] {
  // Stage bootstrap supplies all context itself. Its published profile is
  // empty, and this explicit guard keeps that player-facing boundary intact
  // even if a future profile is malformed or otherwise untrusted.
  if (profile.id === "stage") return [];

  const shellProfile = shellExecEnabled ? resolveShellProfile(shellInterpreter) : undefined;
  const byName = new Map(hostToolDefinitions.map((definition) => [
    definition.function.name,
    definition.function.name === "shell_exec" ? createShellExecToolDefinition(shellProfile) : definition,
  ]));
  const resolved: ToolDefinition[] = [];

  for (const name of profile.defaultTools) {
    if (hostContractNames.has(name)) continue;
    if (name === "view_image" && !visionEnabled) continue;
    if (name === "shell_exec" && (!shellExecEnabled || !shellProfile)) continue;
    if ((name === "shell_output" || name === "shell_stop") && !shellExecEnabled) continue;
    const definition = byName.get(name);
    if (!definition) {
      throw new Error(
        `Engine "${profile.id}" declares unknown tool "${name}". Known model-visible tools: ${[...byName.keys()].join(", ")}.`,
      );
    }
    resolved.push(definition);
  }

  if (profile.stopGates.length > 0) resolved.push(gateToolDefinition);
  resolved.push(askUserQuestionToolDefinition);
  resolved.push(engineSwitchToolDefinition);
  return resolved;
}
