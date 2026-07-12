import type { AgentInboxEntry, AgentMetadata, AgentRuntimeEvent } from "../core/agents/types";
import type { AgentCardState, AgentCardStatus } from "./types";
import { truncateLine } from "./format";

export function agentCardFromMetadata(agent: AgentMetadata, inbox: AgentInboxEntry[] = []): AgentCardState {
  const entries = inbox.filter((entry) => entry.runId === agent.runId);
  const delivery = agent.status === "cancelled" ? undefined : restoredDelivery(entries);
  return {
    runId: agent.runId,
    handle: agent.handle,
    profileId: agent.profileId,
    parentToolCallId: agent.parentToolCallId,
    parentSessionId: agent.parentSessionId,
    description: agent.description,
    mode: agent.mode,
    status: restoredStatus(agent, entries),
    ...(delivery ? { delivery } : {}),
    ...(agent.result ? { resultPreview: resultPreview(agent.result) } : {}),
    createdAt: agent.createdAt,
    updatedAt: agent.updatedAt,
    ...(agent.usage ? { usage: agent.usage } : {}),
    ...(agent.toolUses ? { toolUses: agent.toolUses } : {}),
  };
}

export function applyAgentEvent(cards: AgentCardState[], event: AgentRuntimeEvent): AgentCardState[] {
  if (event.type === "agent_created" || event.type === "agent_started") {
    const incoming = agentCardFromMetadata(event.agent);
    return upsert(cards, {
      ...incoming,
      status: event.type === "agent_created" ? "queued" : "running",
      ...(event.type === "agent_started" ? { progress: "initializing" } : {}),
    });
  }
  if (event.type === "agent_progress") {
    return update(cards, event.runId, (card) => ({
      ...card,
      status: "running",
      progress: event.text,
      toolUses: (card.toolUses ?? 0) + (event.text.startsWith("tool ") ? 1 : 0),
      updatedAt: new Date().toISOString(),
    }));
  }
  if (event.type === "agent_integrated") {
    return update(cards, event.runId, (card) => ({
      ...card,
      status: card.status === "failed" || card.status === "cancelled" ? card.status : "integrated",
      delivery: "integrated",
      progress: "result integrated",
      updatedAt: new Date().toISOString(),
    }));
  }
  const result = event.result;
  return update(cards, result.runId, (card) => ({
    ...card,
    status: terminalDisplayStatus(result.status, result.mode),
    ...(result.mode === "background" && result.status !== "cancelled" ? { delivery: "pending" as const } : {}),
    progress: terminalProgress(result.status, result.mode),
    resultPreview: resultPreview(result.content),
    updatedAt: new Date().toISOString(),
    ...(result.usage ? { usage: result.usage } : {}),
    ...(result.toolUses ? { toolUses: result.toolUses } : {}),
  }));
}

export function setAgentDeliveryState(
  cards: AgentCardState[],
  runIds: string[],
  delivery: "pending" | "integrating" | "integrated",
  progress?: string,
): AgentCardState[] {
  const targets = new Set(runIds);
  return cards.map((card) => targets.has(card.runId)
    ? {
      ...card,
      status: card.status === "failed" || card.status === "cancelled"
        ? card.status
        : delivery === "pending" ? "ready" : delivery,
      delivery,
      ...(progress ? { progress } : {}),
      updatedAt: new Date().toISOString(),
    }
    : card);
}

export function agentActivitySummary(cards: AgentCardState[]): string | undefined {
  const running = cards.filter((card) => card.status === "queued" || card.status === "running").length;
  const ready = cards.filter((card) => card.delivery === "pending" || card.delivery === "integrating").length;
  if (running === 0 && ready === 0) return undefined;
  return [`${running} running`, ...(ready > 0 ? [`${ready} ready`] : [])].join(" · ");
}

export function visibleAgentCards(cards: AgentCardState[]): AgentCardState[] {
  const visible = cards.filter((card) => card.status === "queued"
    || card.status === "running"
    || card.status === "ready"
    || card.status === "integrating"
    || card.delivery === "pending"
    || card.delivery === "integrating");
  return visible.slice(-4);
}

export function mergeRestoredAgentCards(
  current: AgentCardState[],
  parentSessionId: string,
  restored: AgentCardState[],
): AgentCardState[] {
  const observableOtherSessions = current.filter((card) => card.parentSessionId !== parentSessionId
    && (card.status === "queued"
      || card.status === "running"
      || card.delivery === "pending"
      || card.delivery === "integrating"));
  return [...observableOtherSessions, ...restored];
}

export async function retryAgentDelivery(
  pausedSessions: Set<string>,
  parentSessionId: string,
  notify: (sessionId: string) => Promise<void>,
): Promise<void> {
  pausedSessions.delete(parentSessionId);
  await notify(parentSessionId);
}

export function renderAgentDetail(agent: AgentMetadata, card: AgentCardState, inbox: AgentInboxEntry[]): string {
  const entry = inbox.find((candidate) => candidate.runId === agent.runId);
  const usage = agent.usage;
  return [
    `SubAgent ${agent.handle}`,
    `Profile: ${agent.profileId}`,
    `Mode: ${agent.mode}`,
    `Status: ${card.status}${entry ? ` (inbox ${entry.state})` : ""}`,
    `Task: ${agent.description}`,
    `Progress: ${card.progress ?? "no live progress available"}`,
    `Created: ${agent.createdAt}`,
    `Updated: ${agent.updatedAt}`,
    ...(usage ? [`Usage: ↑${usage.inputTokens ?? usage.contextInputTokens ?? 0} ↓${usage.outputTokens ?? 0}`] : []),
    ...(agent.toolUses ? [`Tool uses: ${agent.toolUses}`] : []),
    ...(agent.result ? ["", `Result: ${truncateLine(agent.result.replace(/\s+/g, " "), 600)}`] : []),
    ...(agent.error ? ["", `Error: ${truncateLine(agent.error.replace(/\s+/g, " "), 600)}`] : []),
  ].join("\n");
}

function restoredStatus(agent: AgentMetadata, entries: AgentInboxEntry[]): AgentCardStatus {
  if (agent.status === "created") return "queued";
  if (agent.status === "running") return "running";
  if (agent.status === "failed" || agent.status === "cancelled") return agent.status;
  if (agent.mode === "foreground") return "completed";
  if (entries.some((entry) => entry.state === "pending" || entry.state === "delivered")) return "ready";
  if (entries.some((entry) => entry.state === "acknowledged")) return "integrated";
  return "completed";
}

function restoredDelivery(entries: AgentInboxEntry[]): AgentCardState["delivery"] {
  if (entries.some((entry) => entry.state === "pending" || entry.state === "delivered")) return "pending";
  if (entries.some((entry) => entry.state === "acknowledged")) return "integrated";
  return undefined;
}

function terminalDisplayStatus(
  status: "completed" | "failed" | "cancelled",
  mode: "foreground" | "background",
): AgentCardStatus {
  if (status !== "completed") return status;
  return mode === "background" ? "ready" : "completed";
}

function terminalProgress(status: "completed" | "failed" | "cancelled", mode: "foreground" | "background"): string {
  if (status === "failed") return "failed";
  if (status === "cancelled") return "cancelled";
  return mode === "background" ? "awaiting parent integration" : "returned to parent";
}

function resultPreview(content: string): string {
  return content.replace(/\s+/g, " ").trim().slice(0, 180);
}

function upsert(cards: AgentCardState[], incoming: AgentCardState): AgentCardState[] {
  const index = cards.findIndex((card) => card.runId === incoming.runId);
  if (index < 0) return [...cards, incoming];
  return cards.map((card, current) => current === index ? { ...card, ...incoming } : card);
}

function update(cards: AgentCardState[], runId: string, mutate: (card: AgentCardState) => AgentCardState): AgentCardState[] {
  return cards.map((card) => card.runId === runId ? mutate(card) : card);
}
