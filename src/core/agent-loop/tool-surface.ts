import { createMcpRegistryForEngine, type McpRegistry } from "../../mcp/registry";
import { agentToolDefinitions } from "../agents/tools";
import type { EngineProfile } from "../engine/profile";
import { engineSwitchToolDefinition } from "../engine/switch";
import { gateToolDefinition } from "../gate/types";
import { hostToolDefinitions } from "../tools";
import type { ToolDefinition } from "../tools";
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
): Promise<ToolSurface> {
  const mcp = await createMcpRegistryForEngine(profile.id);
  const builtIns = resolveBuiltInTools(profile, visionEnabled, shellExecEnabled);
  const shellTools = shellExecEnabled
    ? hostToolDefinitions.filter((tool) => tool.function.name === "shell_exec" || tool.function.name === "shell_output" || tool.function.name === "shell_stop")
    : [];
  return {
    definitions: [
      ...builtIns,
      ...shellTools.filter((tool) => !builtIns.some((candidate) => candidate.function.name === tool.function.name)),
      ...mcp.definitions,
      ...agentToolDefinitions,
    ],
    mcp,
  };
}

function resolveBuiltInTools(
  profile: EngineProfile,
  visionEnabled: boolean,
  shellExecEnabled = false,
): ToolDefinition[] {
  const byName = new Map(hostToolDefinitions.map((definition) => [definition.function.name, definition]));
  const resolved: ToolDefinition[] = [];

  for (const name of profile.defaultTools) {
    if (hostContractNames.has(name)) continue;
    if (name === "view_image" && !visionEnabled) continue;
    if ((name === "shell_exec" || name === "shell_output" || name === "shell_stop") && !shellExecEnabled) continue;
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
