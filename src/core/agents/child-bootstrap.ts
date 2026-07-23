import { loadConfigForSelection } from "../../config/providers";
import { createMcpRegistryForEngine } from "../../mcp/registry";
import type { McpRegistry } from "../../mcp/registry";
import { createProvider } from "../../providers";
import type { ProviderAdapter, VesicleMessage } from "../../providers/shared/types";
import { FileCheckpointManager } from "../checkpoints/file-history";
import { createSessionStore, type SessionStore } from "../session/store";
import { hostToolDefinitions } from "../tools";
import type { ToolDefinition } from "../tools";
import type { AgentProfile } from "./profile";
import { loadAgentProfile, loadAgentSystemPrompt } from "./profile";
import { assertChildToolDeclaration, unsupportedChildToolNames } from "./tool-scope";
import type { AgentInvocationContext, AgentRunContext } from "./types";

export type ChildAgentBootstrap = {
  config: Awaited<ReturnType<typeof loadConfigForSelection>>;
  provider: ProviderAdapter;
  profile: AgentProfile;
  systemPrompts: string[];
  mcp: McpRegistry;
  tools: ToolDefinition[];
  session: SessionStore;
  checkpoint: FileCheckpointManager;
  messages: VesicleMessage[];
};

type BootstrapContext = Pick<AgentRunContext, "runId" | "handle" | "spec" | "registerChildSession"> & {
  invocation: AgentInvocationContext;
};

export async function bootstrapChildAgent({
  runId,
  handle,
  spec,
  invocation,
  registerChildSession,
}: BootstrapContext): Promise<ChildAgentBootstrap> {
  const config = await loadConfigForSelection(invocation.providerSelection);
  const provider = createProvider(config);
  const profile = await loadAgentProfile(spec.profileId, invocation.rootDir, invocation.assets);
  const agentSystemPrompt = await loadAgentSystemPrompt(profile, invocation.rootDir, invocation.assets);
  const systemPrompts = composeChildSystemPrompts(profile.contextMode, invocation.parentSystemPrompt, agentSystemPrompt);
  const mcp = await createMcpRegistryForEngine(invocation.parentEngine);
  const tools = resolveChildTools(
    profile.tools,
    invocation.parentToolDefinitions,
    mcp,
    config.capabilities?.vision === true,
  );
  const session = await createSessionStore(invocation.rootDir);
  await registerChildSession(session.sessionId);

  await session.append({
    role: "system",
    content: systemPrompts.join("\n\n"),
    metadata: {
      kind: "subagent-session",
      runId,
      handle,
      agentProfile: profile.id,
      parentSessionId: spec.parentSessionId,
      parentToolCallId: spec.parentToolCallId,
      mode: spec.mode,
      provider: config.provider,
      providerId: config.providerId,
      model: config.model,
      tools: tools.map((tool) => tool.function.name),
      ...(invocation.harness?.identity ? { harness: invocation.harness.identity } : {}),
      ...(spec.delegation ? { delegation: spec.delegation } : {}),
    },
  });
  await session.append({
    role: "user",
    content: spec.prompt,
    metadata: {
      kind: "subagent-task",
      runId,
      handle,
      description: spec.description,
      ...(spec.delegation ? { delegation: spec.delegation } : {}),
    },
  });
  const checkpoint = new FileCheckpointManager(invocation.rootDir, session, session.headUuid()!);
  await checkpoint.createSnapshot();

  return {
    config,
    provider,
    profile,
    systemPrompts,
    mcp,
    tools,
    session,
    checkpoint,
    messages: contextMessages(profile.contextMode, invocation.parentMessages, spec.prompt),
  };
}

export function composeChildSystemPrompts(
  contextMode: "fresh" | "summary" | "fork",
  parentSystemPrompt: string,
  agentSystemPrompt: string,
): string[] {
  // Preserve the parent's already-rendered prompt as an exact first prefix for
  // fork semantics and provider caching, then add the independent Agent
  // Profile identity. Fresh/summary children use only their own profile.
  return contextMode === "fork"
    ? [parentSystemPrompt, agentSystemPrompt]
    : [agentSystemPrompt];
}

export function resolveChildTools(
  declared: string[],
  parentDefinitions: ToolDefinition[],
  mcp: McpRegistry,
  visionEnabled: boolean,
): ToolDefinition[] {
  const available = new Map(
    [...hostToolDefinitions, ...mcp.definitions, ...parentDefinitions]
      .filter((tool) => !unsupportedChildToolNames.has(tool.function.name))
      .map((tool) => [tool.function.name, tool]),
  );
  assertChildToolDeclaration(declared, new Set(available.keys()));
  const parentNames = new Set(parentDefinitions.map((tool) => tool.function.name));
  // `*` inherits the parent's effective work surface, not Vesicle's
  // child-management controls. Recursive SubAgents are intentionally disabled
  // in this runtime, so omit those controls from wildcard inheritance; an
  // explicit declaration remains an error below.
  const names = declared[0] === "*"
    ? [...parentNames].filter((name) => !unsupportedChildToolNames.has(name))
    : declared;
  const resolved: ToolDefinition[] = [];
  for (const name of names) {
    if (name === "view_image" && !visionEnabled) continue;
    const tool = available.get(name);
    if (!tool) continue;
    resolved.push(tool);
  }
  return resolved;
}

function contextMessages(mode: "fresh" | "summary" | "fork", parent: VesicleMessage[], prompt: string): VesicleMessage[] {
  if (mode === "fork") return [...parent, { role: "user", content: `[delegated task]\n${prompt}` }];
  if (mode === "summary") {
    const context = boundedParentContext(parent, 12_000);
    return [{
      role: "user",
      content: `${context ? `[bounded parent context]\n${context}\n\n` : ""}[delegated task]\n${prompt}`,
    }];
  }
  return [{ role: "user", content: prompt }];
}

function boundedParentContext(messages: VesicleMessage[], maxChars: number): string {
  const selected: string[] = [];
  let remaining = maxChars;
  for (const message of [...messages].reverse()) {
    const content = message.content.trim();
    if (!content) continue;
    const rendered = `${message.role}: ${content}`;
    if (rendered.length > remaining) {
      if (selected.length === 0) selected.push(rendered.slice(rendered.length - remaining));
      break;
    }
    selected.push(rendered);
    remaining -= rendered.length + 2;
    if (remaining <= 0) break;
  }
  return selected.reverse().join("\n\n");
}
