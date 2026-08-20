import { createEmptyMcpRegistry, createMcpRegistryForEngine, type McpRegistry, type McpRegistryOptions } from "../../mcp/registry";
import { agentToolDefinitions } from "../agents/tools";
import type { VesicleConfig } from "../../config/env";
import type { EngineProfile } from "../engine/profile";
import { engineSwitchToolDefinition } from "../engine/switch";
import { gateToolDefinition } from "../gate/types";
import { createShellExecToolDefinition, hostToolDefinitions } from "../tools";
import type { ToolDefinition } from "../tools";
import { loadTavilyApiKey } from "../tools/web/tavily-client";
import { createActivateSkillToolDefinition } from "../skills/tools";
import { resolveShellProfile, type ShellInterpreterPreference } from "../process/shell-profile";
import { askUserQuestionToolDefinition } from "../user-question/types";
import { instructionToolDefinitions } from "../instructions";
import { effectiveWebSearchEnabled } from "./web-search-state";

const hostContractNames = new Set(["config.load", "prompt.load", "session.write"]);

/** Host tools backed by the Tavily API; all fail at execution time without a key. */
const tavilyToolNames = new Set(["web_search", "web_fetch", "web_map", "web_crawl", "web_research"]);

/**
 * Resolve the web-search surface policy for a session: the effective
 * built-in toggle (session override > model default > off, gated on the
 * capability) plus Tavily credential presence.
 */
export async function resolveWebSearchSurfaceOptions(
  config: VesicleConfig,
  sessionId: string,
): Promise<WebSearchSurfaceOptions> {
  return {
    builtinSearchEnabled: effectiveWebSearchEnabled(config, sessionId),
    tavilyConfigured: (await loadTavilyApiKey(process.env)) !== undefined,
  };
}

/** Optional Skill catalog input for tool-surface gating (wired by the session layer). */
export type SkillSurfaceOptions = {
  /** Names in the session's effective Skill catalog; empty means Skill tools stay off. */
  catalogNames: string[];
};

/** Built-in web search surface policy (frozen design D2). */
export type WebSearchSurfaceOptions = {
  /**
   * The session's provider-native built-in search is enabled. The host
   * `web_search` (Tavily) tool is removed from the surface so the model is
   * not offered two competing search paths; the other Tavily URL tools stay.
   */
  builtinSearchEnabled?: boolean;
  /**
   * A Tavily API key is resolvable. Without it every Tavily tool call fails
   * at execution time, so the whole Tavily tool family is hidden instead.
   */
  tavilyConfigured?: boolean;
};

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
  skills?: SkillSurfaceOptions,
  webSearch?: WebSearchSurfaceOptions,
): Promise<ToolSurface> {
  const mcp = profile.id === "stage"
    ? createEmptyMcpRegistry()
    : await createMcpRegistryForEngine(profile.id, mcpOptions);
  const shellProfile = shellExecEnabled ? resolveShellProfile(shellInterpreter) : undefined;
  const builtIns = resolveBuiltInTools(profile, visionEnabled, shellExecEnabled, shellInterpreter, skills, webSearch);
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
  skills?: SkillSurfaceOptions,
  webSearch?: WebSearchSurfaceOptions,
): ToolDefinition[] {
  // Stage bootstrap supplies all context itself. Its published profile is
  // empty, and this explicit guard keeps that player-facing boundary intact
  // even if a future profile is malformed or otherwise untrusted.
  if (profile.id === "stage") return [];

  const shellProfile = shellExecEnabled ? resolveShellProfile(shellInterpreter) : undefined;
  const skillNames = skills?.catalogNames ?? [];
  const byName = new Map(hostToolDefinitions.map((definition) => [
    definition.function.name,
    definition.function.name === "shell_exec" ? createShellExecToolDefinition(shellProfile) : definition,
  ]));
  // activate_skill's schema enum is the session's effective catalog, so the
  // definition is built per resolution rather than held in the static pool.
  byName.set("activate_skill", createActivateSkillToolDefinition(skillNames));
  const resolved: ToolDefinition[] = [];

  for (const name of [...new Set(profile.defaultTools)]) {
    if (hostContractNames.has(name)) continue;
    if (name === "view_image" && !visionEnabled) continue;
    if (name === "shell_exec" && (!shellExecEnabled || !shellProfile)) continue;
    if ((name === "shell_output" || name === "shell_stop") && !shellExecEnabled) continue;
    if (name === "web_search" && webSearch?.builtinSearchEnabled) continue;
    if (tavilyToolNames.has(name) && webSearch?.tavilyConfigured === false) continue;
    // Skill tools are host-injected after the loop, independent of the
    // Harness profile's defaultTools.
    if (name === "activate_skill" || name === "read_skill_resource" || name === "run_skill_script") continue;
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
  // Persistent Instruction controls are universal host tools for every non-Stage
  // engine. Stage stays strictly tool-less by design.
  resolved.push(...instructionToolDefinitions);
  // Skill tools are host-owned, not Harness-owned. They are injected for
  // every non-Stage engine when the session has a non-empty catalog,
  // independent of the Harness profile's defaultTools so harness bumps
  // cannot silently clobber them.
  if (skillNames.length > 0) {
    resolved.push(byName.get("activate_skill")!);
    resolved.push(byName.get("read_skill_resource")!);
    // Skill scripts select one fixed catalog resource and use structured argv.
    // Their interpreter is resolved per script at execution time, independent
    // of the free-form shell_exec capability and its configured shell profile.
    resolved.push(byName.get("run_skill_script")!);
  }
  return resolved;
}
