import type { Accessor } from "solid-js";
import type { AgentManager } from "../core/agents/manager";
import { listAgentProfiles } from "../core/agents/profile";
import type { AgentContinuationScheduler } from "../core/agents/scheduler";
import type { AgentStore } from "../core/agents/store";
import { agentCardFromMetadata, renderAgentDetail, retryAgentDelivery } from "./agent-view";
import type { AgentCardState } from "./types";

export type AgentCommandOptions = {
  rootDir: string;
  sessionId: Accessor<string | undefined>;
  agentCards: Accessor<AgentCardState[]>;
  agentManager: AgentManager;
  agentStore: AgentStore;
  pausedDeliveries: Set<string>;
  scheduler: AgentContinuationScheduler;
  reportError: (error: unknown) => void;
};

export function createAgentCommand(options: AgentCommandOptions) {
  return async function agentCommand(args: string): Promise<string> {
    const id = options.sessionId();
    const [action, target] = args.trim().split(/\s+/, 2);
    if (action === "stop") {
      if (!target) return "Usage: /agents stop <agent-handle>";
      if (!id) return "No active session.";
      const interrupted = await options.agentManager.interrupt(target, id);
      return interrupted ? `Interrupt requested for ${target}.` : `SubAgent is not running: ${target}.`;
    }
    if (action === "retry" && !target) {
      if (!id) return "No active session.";
      void retryAgentDelivery(options.pausedDeliveries, id, (session) => options.scheduler.notify(session)).catch(options.reportError);
      return "SubAgent result delivery retry scheduled.";
    }
    if (action && !target) return inspectAgent(id, action);
    if (args.trim()) return "Usage: /agents [handle|stop <handle>|retry]";
    return listAgents(id);
  };

  async function inspectAgent(sessionId: string | undefined, reference: string): Promise<string> {
    if (!sessionId) return "No active session.";
    const agent = await options.agentStore.resolveReference(sessionId, reference);
    if (!agent) return `Unknown SubAgent: ${reference}.`;
    const inbox = (await options.agentStore.listInbox(sessionId)).filter((entry) => entry.runId === agent.runId);
    const card = options.agentCards().find((candidate) => candidate.runId === agent.runId) ?? agentCardFromMetadata(agent, inbox);
    return renderAgentDetail(agent, card, inbox);
  }

  async function listAgents(sessionId: string | undefined): Promise<string> {
    const profiles = await listAgentProfiles(options.rootDir);
    const agents = sessionId ? await options.agentStore.listByParent(sessionId) : [];
    const inbox = sessionId ? await options.agentStore.listInbox(sessionId) : [];
    const lines = ["Agent Profiles:"];
    for (const profile of profiles) lines.push(`  ${profile.id} [${profile.defaultMode}/${profile.contextMode}] - ${profile.description}`);
    lines.push("", "Current session SubAgents:");
    if (agents.length === 0) lines.push("  (none)");
    for (const agent of agents) {
      const card = options.agentCards().find((candidate) => candidate.runId === agent.runId) ?? agentCardFromMetadata(agent, inbox);
      lines.push(`  ${agent.handle} [${card.status}/${agent.mode}] ${agent.description}`);
    }
    lines.push("", "Use /agents <handle> for details, /agents stop <handle> to interrupt, or /agents retry after a delivery error.");
    return lines.join("\n");
  }
}
