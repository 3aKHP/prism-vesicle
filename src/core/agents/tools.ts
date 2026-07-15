import type { ToolCall, ToolDefinition, ToolResult } from "../tools";
import { listAgentProfiles, loadAgentProfile } from "./profile";
import type { AgentManager } from "./manager";
import type { AgentInvocationContext, AgentSpec, AgentTerminalResult } from "./types";
import { AgentStore } from "./store";
import {
  bindHarnessDelegation,
  harnessDelegationFailureDecision,
  harnessDelegationFailureInteraction,
  normalizeHarnessAdapterError,
} from "../harness/driver";
import { isBundledHostAgentId } from "../runtime/assets";

export const agentToolNames = new Set(["spawn_agent", "list_agents", "send_message", "interrupt_agent", "wait_agent"]);

export const agentToolDefinitions: ToolDefinition[] = [
  {
    type: "function",
    function: {
      name: "spawn_agent",
      description: "Start a specialized SubAgent. Foreground waits for its result while the TUI remains responsive; background returns immediately and delivers completion later. Multiple spawn_agent calls in one response run in parallel.",
      parameters: {
        type: "object",
        properties: {
          profile: { type: "string", description: "Installed Agent Profile id. Call list_agents to discover profiles." },
          description: { type: "string", description: "Short user-visible task label." },
          prompt: { type: "string", description: "Self-contained delegated task and required deliverable." },
          mode: { type: "string", enum: ["foreground", "background"], description: "Optional execution override; defaults to the profile." },
        },
        required: ["profile", "description", "prompt"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_agents",
      description: "List installed Agent Profiles and current-session SubAgents with their short handles and lifecycle state.",
      parameters: { type: "object", properties: {}, additionalProperties: false },
    },
  },
  {
    type: "function",
    function: {
      name: "send_message",
      description: "Queue additional instructions for a running SubAgent by short handle. The child receives them at its next provider-request boundary.",
      parameters: {
        type: "object",
        properties: {
          agent_id: { type: "string", description: "Short handle returned by spawn_agent or list_agents, for example explore-1. Legacy full ids remain accepted." },
          message: { type: "string" },
        },
        required: ["agent_id", "message"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "interrupt_agent",
      description: "Cancel a running or queued SubAgent by short handle.",
      parameters: {
        type: "object",
        properties: { agent_id: { type: "string", description: "Short SubAgent handle, for example explore-1." } },
        required: ["agent_id"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "wait_agent",
      description: "Explicitly wait for one SubAgent by short handle and return its terminal result. Background completion notifications normally make polling unnecessary.",
      parameters: {
        type: "object",
        properties: { agent_id: { type: "string", description: "Short SubAgent handle, for example explore-1." } },
        required: ["agent_id"],
        additionalProperties: false,
      },
    },
  },
];

export async function executeAgentTool(options: {
  call: ToolCall;
  manager: AgentManager;
  rootDir: string;
  parentSessionId: string;
  invocation: AgentInvocationContext;
}): Promise<ToolResult> {
  const { call, manager, rootDir, parentSessionId, invocation } = options;
  try {
    const args = parseArgs(call.arguments);
    if (call.name === "list_agents") {
      const profiles = await listAgentProfiles(rootDir, invocation.assets);
      const agents = await new AgentStore(rootDir).listByParent(parentSessionId);
      return ok(call, JSON.stringify({
        profiles: profiles.map((profile) => ({
          id: profile.id,
          displayName: profile.displayName,
          description: profile.description,
          defaultMode: profile.defaultMode,
          contextMode: profile.contextMode,
        })),
        agents: agents.map((agent) => ({
          agent_id: agent.handle,
          profile: agent.profileId,
          description: agent.description,
          status: agent.status,
          mode: agent.mode,
        })),
      }));
    }
    if (call.name === "spawn_agent") {
      const profileId = requiredString(args, "profile");
      const requestedModeValue = optionalString(args, "mode");
      if (requestedModeValue && requestedModeValue !== "foreground" && requestedModeValue !== "background") {
        throw new Error("mode must be foreground or background.");
      }
      const requestedMode: AgentSpec["mode"] | undefined = requestedModeValue === "foreground" || requestedModeValue === "background"
        ? requestedModeValue
        : undefined;
      const delegation = invocation.harness && !isBundledHostAgentId(profileId)
        ? bindHarnessDelegation(invocation.harness, invocation.parentEngine, profileId, requestedMode)
        : undefined;
      const profile = await loadAgentProfile(profileId, rootDir, invocation.assets);
      const spec: AgentSpec = {
        profileId,
        description: agentDescription(requiredString(args, "description")),
        prompt: requiredString(args, "prompt"),
        mode: delegation?.mode ?? requestedMode ?? profile.defaultMode,
        parentSessionId,
        parentToolCallId: call.id,
        ...(delegation ? { delegation: { ...delegation, attempt: 1 } } : {}),
        ...(delegation ? { delegationFailure: harnessDelegationFailureInteraction(invocation.harness!, invocation.parentEngine) } : {}),
      };
      const child = await manager.spawn(spec, invocation);
      if (spec.mode === "background") {
        return {
          ...ok(call, JSON.stringify({
            status: "accepted",
            agent_id: child.handle,
            profile: profileId,
            mode: spec.mode,
            ...(spec.delegation ? { delegation: publicDelegation(spec.delegation) } : {}),
          })),
          agentEvent: {
            kind: "subagent",
            handle: child.handle,
            profileId,
            mode: spec.mode,
            status: "accepted",
            ...(spec.delegation ? { delegation: spec.delegation } : {}),
          },
        };
      }
      const result = await child.completion;
      const toolResult = agentTerminalToolResult(call, result);
      if (result.status === "failed" && invocation.harness && result.delegation) {
        toolResult.delegationDecision = harnessDelegationFailureDecision(invocation.harness, invocation.parentEngine, {
          runId: result.runId,
          handle: result.handle,
          delegation: result.delegation,
          errorCategory: result.errorCategory ?? "failed",
        });
      }
      return toolResult;
    }
    const agentReference = requiredString(args, "agent_id");
    if (call.name === "send_message") {
      return manager.sendMessage(agentReference, requiredString(args, "message"), parentSessionId)
        ? ok(call, `Message queued for ${agentReference}.`)
        : fail(call, `SubAgent is not running: ${agentReference}.`);
    }
    if (call.name === "interrupt_agent") {
      return await manager.interrupt(agentReference, parentSessionId)
        ? ok(call, `Interrupt requested for ${agentReference}.`)
        : fail(call, `SubAgent is not running: ${agentReference}.`);
    }
    if (call.name === "wait_agent") {
      const result = await manager.wait(agentReference, parentSessionId);
      if (!result) return fail(call, `Unknown SubAgent: ${agentReference}.`);
      // Explicit waiting consumes a background result in-band through this
      // tool call. Acknowledge its durable inbox copy so the automatic parent
      // continuation cannot inject the same result a second time.
      if (result.mode === "background") {
        await new AgentStore(rootDir).acknowledgeAgentResult(parentSessionId, result.runId);
        manager.reportIntegrated(result);
      }
      return agentTerminalToolResult(call, result);
    }
    return fail(call, `Unknown SubAgent tool: ${call.name}.`);
  } catch (error) {
    if (invocation.harness) {
      const normalized = normalizeHarnessAdapterError(error);
      const result = fail(call, JSON.stringify({ error: { category: normalized.category, message: normalized.message } }));
      if (call.name === "spawn_agent") {
        const failed = (await new AgentStore(rootDir).listByParent(parentSessionId))
          .find((agent) => agent.parentToolCallId === call.id && agent.delegation);
        if (failed?.delegation) {
          result.delegationDecision = harnessDelegationFailureDecision(invocation.harness, invocation.parentEngine, {
            runId: failed.runId,
            handle: failed.handle,
            delegation: failed.delegation,
            errorCategory: normalized.category,
          });
        }
      }
      return result;
    }
    return fail(call, error instanceof Error ? error.message : String(error));
  }
}

export function agentTerminalToolResult(call: ToolCall, result: AgentTerminalResult): ToolResult {
  return {
    ...(result.status === "completed" ? ok(call, JSON.stringify(publicAgentResult(result))) : fail(call, JSON.stringify(publicAgentResult(result)))),
    agentEvent: {
      kind: "subagent",
      handle: result.handle,
      profileId: result.profileId,
      mode: result.mode,
      status: result.status,
      ...(result.usage ? { usage: result.usage } : {}),
      ...(result.delegation ? { delegation: result.delegation } : {}),
      ...(result.attempts ? { attempts: result.attempts } : {}),
      ...(result.errorCategory ? { errorCategory: result.errorCategory } : {}),
    },
  };
}

export function publicAgentResult(terminal: AgentTerminalResult): Record<string, unknown> {
  return {
    agent_id: terminal.handle,
    profileId: terminal.profileId,
    description: terminal.description,
    mode: terminal.mode,
    status: terminal.status,
    content: terminal.content,
    ...(terminal.usage ? { usage: terminal.usage } : {}),
    ...(terminal.toolUses ? { toolUses: terminal.toolUses } : {}),
    ...(terminal.delegation ? { delegation: publicDelegation(terminal.delegation) } : {}),
    ...(terminal.attempts ? { attempts: terminal.attempts } : {}),
    ...(terminal.errorCategory ? { errorCategory: terminal.errorCategory } : {}),
  };
}

function publicDelegation(delegation: NonNullable<AgentSpec["delegation"]>): Record<string, unknown> {
  return {
    id: delegation.id,
    agent: delegation.agent,
    parentEngine: delegation.parentEngine,
    mode: delegation.mode,
    purpose: delegation.purpose,
    retryLimit: delegation.retryLimit,
    attempt: delegation.attempt,
  };
}

function parseArgs(source: string): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(source || "{}") as unknown;
  } catch {
    throw new Error("Tool arguments must be valid JSON.");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Tool arguments must be an object.");
  return value as Record<string, unknown>;
}

function requiredString(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  if (typeof value !== "string" || !value.trim()) throw new Error(`${key} must be a non-empty string.`);
  return value.trim();
}

function optionalString(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !value.trim()) throw new Error(`${key} must be a non-empty string.`);
  return value.trim();
}

function agentDescription(value: string): string {
  const clean = value
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120);
  if (!clean) throw new Error("description must contain displayable text.");
  return clean;
}

function ok(call: ToolCall, content: string): ToolResult {
  return { callId: call.id, name: call.name, ok: true, content };
}

function fail(call: ToolCall, content: string): ToolResult {
  return { callId: call.id, name: call.name, ok: false, content };
}
