import { loadConfigForSelection } from "../../config/providers";
import { createMcpRegistryForEngine } from "../../mcp/registry";
import type { McpRegistry } from "../../mcp/registry";
import { createProvider } from "../../providers";
import type { ProviderAdapter, ResponseUsage, VesicleMessage, VesicleRequest, VesicleResponse } from "../../providers/shared/types";
import { FileCheckpointManager } from "../checkpoints/file-history";
import { createSessionStore } from "../session/store";
import { executeHostTool, hostToolDefinitions } from "../tools";
import type { ToolCall, ToolDefinition } from "../tools";
import { loadAgentProfile, loadAgentSystemPrompt } from "./profile";
import type { AgentRunner } from "./manager";
import { createPermissionRequest, defaultPermissionRuntime, evaluatePermissionPolicy, permissionClassForTool } from "../permissions";
import type { ToolResult } from "../tools";
import { assertChildToolDeclaration, unsupportedChildToolNames } from "./tool-scope";
import {
  evaluateBoundQuality,
  evaluateBoundQualityTargets,
  qualityArtifactTargetFromResult,
  qualityCandidateParts,
  qualityModeForAgent,
  readQualityArtifactTargets,
  recordQualityEvent,
  upsertQualityArtifactTarget,
  type QualityArtifactTarget,
} from "../quality";

export const runChildAgent: AgentRunner = async ({ runId, handle, spec, signal, invocation, onProgress, takeMessages, claimMutation, registerChildSession }) => {
  if (!invocation) throw new Error("SubAgent invocation context is missing.");
  const config = await loadConfigForSelection(invocation.providerSelection);
  const provider = createProvider(config);
  const profile = await loadAgentProfile(spec.profileId, invocation.rootDir, invocation.assets);
  const agentSystemPrompt = await loadAgentSystemPrompt(profile, invocation.rootDir, invocation.assets);
  const systemPrompts = composeChildSystemPrompts(profile.contextMode, invocation.parentSystemPrompt, agentSystemPrompt);
  const persistedSystemPrompt = systemPrompts.join("\n\n");
  const mcp = await createMcpRegistryForEngine(invocation.parentEngine);
  const tools = resolveChildTools(profile.tools, invocation.parentToolDefinitions, mcp, config.capabilities?.vision === true);
  const session = await createSessionStore(invocation.rootDir);
  await registerChildSession(session.sessionId);

  await session.append({
    role: "system",
    content: persistedSystemPrompt,
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

  const messages: VesicleMessage[] = contextMessages(profile.contextMode, invocation.parentMessages, spec.prompt);
  let usage: ResponseUsage | undefined;
  let toolUses = 0;
  let response: VesicleResponse | undefined;
  const qualityProseParts: string[] = [];
  const qualityTargets: QualityArtifactTarget[] = [];

  for (let iteration = 0; iteration < profile.maxTurns; iteration++) {
    if (signal.aborted) throw signal.reason;
    await appendParentMessages(messages, takeMessages(), session, runId, handle);
    onProgress(`request ${iteration + 1}`);
    response = await complete(provider, {
      id: session.sessionId,
      model: { provider: config.providerId, model: config.model },
      system: systemPrompts,
      messages,
      tools,
      generation: invocation.generation,
      signal,
    }, onProgress);
    usage = addUsage(usage, response.usage);
    const calls = response.toolCalls ?? [];
    if (calls.length === 0) qualityProseParts.push(...qualityCandidateParts(response));
    toolUses += calls.length;
    messages.push({
      role: "assistant",
      content: response.content,
      ...(response.reasoningContent ? { reasoningContent: response.reasoningContent } : {}),
      ...(response.thinkingBlocks ? { thinkingBlocks: response.thinkingBlocks } : {}),
      ...(calls.length > 0 ? { toolCalls: calls } : {}),
    });
    await session.append({
      role: "assistant",
      content: response.content,
      metadata: {
        kind: "subagent-response",
        runId,
        handle,
        providerResponseId: response.id,
        ...(response.usage ? { usage: response.usage } : {}),
        ...(calls.length > 0 ? { toolCalls: calls } : {}),
      },
    });
    if (calls.length === 0) {
      // A parent message can arrive while the provider is streaming what would
      // otherwise be the terminal answer. Give that message a real next turn
      // instead of silently dropping an acknowledged send_message call.
      if (await appendParentMessages(messages, takeMessages(), session, runId, handle) > 0) continue;
      const qualityRuntime = invocation.harness?.quality;
      const qualityMode = qualityModeForAgent(qualityRuntime, profile.id);
      if (qualityRuntime && qualityMode === "observe") {
        onProgress("checking prose quality");
        const quality = qualityTargets.length > 0
          ? evaluateBoundQualityTargets({
            runtime: qualityRuntime,
            producer: profile.id,
            mode: qualityMode,
            targets: await readQualityArtifactTargets(invocation.rootDir, qualityTargets),
            attempt: 0,
            state: { attempts: 0, rejectedHashes: new Set(), targets: qualityTargets },
            usage: response.usage,
          })
          : evaluateBoundQuality({
            runtime: qualityRuntime,
            producer: profile.id,
            mode: qualityMode,
            content: qualityProseParts.join("\n\n"),
            attempt: 0,
            state: { attempts: 0, rejectedHashes: new Set() },
            usage: response.usage,
          });
        if (quality) await recordQualityEvent(session, quality);
      }
      return {
        content: response.content,
        childSessionId: session.sessionId,
        ...(usage ? { usage } : {}),
        ...(toolUses > 0 ? { toolUses } : {}),
      };
    }

    for (const call of calls) {
      onProgress(agentToolProgress(call));
      const permission = invocation.permission ?? defaultPermissionRuntime;
      let result: ToolResult;
      if (evaluatePermissionPolicy(permission.mode, permissionClassForTool(call.name)) === "ask") {
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
        if (resolution.decision === "reject") {
          result = {
            callId: call.id,
            name: call.name,
            ok: false,
            content: resolution.feedback
              ? `Permission denied by the user. Feedback: ${resolution.feedback}`
              : "Permission denied by the user.",
          };
        } else {
          result = await executeChildHostTool(call);
        }
      } else {
        result = await executeChildHostTool(call);
      }
      const content = JSON.stringify({ ok: result.ok, result: result.content });
      messages.push({ role: "tool", toolCallId: call.id, content, ...(result.images ? { images: result.images } : {}) });
      await session.append({
        role: "tool",
        content,
        metadata: {
          kind: "subagent-tool-result",
          runId,
          handle,
          name: call.name,
          ok: result.ok,
          toolCallId: call.id,
          permissionMode: permission.mode,
          decisionSource: evaluatePermissionPolicy(permission.mode, permissionClassForTool(call.name)) === "ask" ? "user" : "policy",
          ...(result.fileEvent ? { fileEvent: result.fileEvent } : {}),
          ...(result.webEvent ? { webEvent: result.webEvent } : {}),
          ...(result.mcpEvent ? { mcpEvent: result.mcpEvent } : {}),
        },
      });
      const qualityTarget = qualityArtifactTargetFromResult(profile.id, result);
      if (qualityTarget) upsertQualityArtifactTarget(qualityTargets, qualityTarget);

      async function executeChildHostTool(call: ToolCall): Promise<ToolResult> {
        return mcp.hasTool(call.name)
          ? mcp.execute(call)
          : executeHostTool(invocation!.rootDir, call, {
            signal,
            shellInterpreter: permission.shellInterpreter,
            beforeMutation: async (paths) => {
              await claimMutation(paths);
              await invocation!.beforeMutation?.(paths);
              await checkpoint.trackBeforeMutation(paths);
            },
          });
      }
    }
  }
  throw new Error(`SubAgent "${profile.id}" reached its maxTurns limit (${profile.maxTurns}).`);
};

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

async function appendParentMessages(
  messages: VesicleMessage[],
  pending: string[],
  session: Awaited<ReturnType<typeof createSessionStore>>,
  runId: string,
  handle: string,
): Promise<number> {
  for (const message of pending) {
    const content = `[message from parent Engine]\n${message}`;
    messages.push({ role: "user", content });
    await session.append({ role: "user", content, metadata: { kind: "subagent-parent-message", runId, handle } });
  }
  return pending.length;
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

async function complete(
  provider: ProviderAdapter,
  request: VesicleRequest,
  onProgress: (text: string) => void,
): Promise<VesicleResponse> {
  if (!provider.stream) return provider.complete(request);
  let response: VesicleResponse | undefined;
  for await (const event of provider.stream(request)) {
    if (event.type === "content_delta" && event.delta.trim()) onProgress("writing response");
    else if (event.type === "tool_call_delta" && event.name) onProgress(`preparing ${event.name}`);
    else if (event.type === "complete") response = event.response;
  }
  if (!response) throw new Error("SubAgent provider stream ended without a final response.");
  return response;
}

function addUsage(total: ResponseUsage | undefined, next: ResponseUsage | undefined): ResponseUsage | undefined {
  if (!next) return total;
  const result: ResponseUsage = { ...(total ?? {}) };
  for (const key of [
    "inputTokens",
    "outputTokens",
    "totalTokens",
    "cacheReadInputTokens",
    "cacheWriteInputTokens",
    "cacheHitInputTokens",
    "cacheMissInputTokens",
    "reasoningTokens",
    "effectiveTokens",
  ] as const) {
    if (next[key] !== undefined) result[key] = (result[key] ?? 0) + next[key];
  }
  if (next.contextInputTokens !== undefined) result.contextInputTokens = next.contextInputTokens;
  return result;
}
