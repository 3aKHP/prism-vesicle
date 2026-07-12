import type {
  PermissionClass,
  PermissionMode,
  PermissionPolicyDecision,
} from "./types";

const observeTools = new Set([
  "stat_path",
  "list_files",
  "list_directory",
  "grep_files",
  "read_file",
  "view_image",
  "web_search",
  "web_fetch",
  "web_map",
  "web_crawl",
  "web_research",
  "list_agents",
  "wait_agent",
]);

const interactionTools = new Set([
  "request_confirmation",
  "request_engine_switch",
  "ask_user_question",
]);

/**
 * Classify model-visible tools into the deliberately small Vesicle permission
 * taxonomy. Unknown tools fail closed into `mutate`; this also makes every MCP
 * tool a side-effecting tool without trusting its remote schema or prose.
 */
export function permissionClassForTool(toolName: string): PermissionClass {
  if (interactionTools.has(toolName)) return "interaction";
  if (toolName === "shell_exec") return "arbitrary_exec";
  if (observeTools.has(toolName)) return "observe";
  return "mutate";
}

/** Permission modes choose approval friction; they never widen capabilities. */
export function evaluatePermissionPolicy(
  mode: PermissionMode,
  permissionClass: PermissionClass,
): PermissionPolicyDecision {
  if (permissionClass === "interaction") return "allow";
  if (mode === "MANUAL") return "ask";
  if (mode === "INERTIA") return permissionClass === "observe" ? "allow" : "ask";
  if (mode === "MOMENTUM") return permissionClass === "arbitrary_exec" ? "ask" : "allow";
  return "allow";
}
