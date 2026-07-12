import { AgentStore } from "./store";
import type { AgentInboxEntry } from "./types";

export type AgentResultDelivery = (
  parentSessionId: string,
  entries: AgentInboxEntry[],
  packet: string,
) => Promise<void>;

export class AgentDeliveryDeferred extends Error {
  constructor() {
    super("Parent session is not ready for SubAgent result delivery.");
    this.name = "AgentDeliveryDeferred";
  }
}

export class AgentContinuationScheduler {
  private readonly scheduled = new Map<string, Promise<void>>();
  private readonly rerunRequested = new Set<string>();

  constructor(
    private readonly store: AgentStore,
    private readonly deliver: AgentResultDelivery,
    private readonly options: {
      debounceMs?: number;
      isParentIdle?: (parentSessionId: string) => boolean;
    } = {},
  ) {}

  notify(parentSessionId: string): Promise<void> {
    const current = this.scheduled.get(parentSessionId);
    if (current) {
      // A child may finish while an earlier batch is already being delivered.
      // Preserve that edge so the new inbox entry cannot be stranded when the
      // current delivery promise settles.
      this.rerunRequested.add(parentSessionId);
      return current;
    }
    const task = this.drainUntilQuiet(parentSessionId).finally(() => {
      this.scheduled.delete(parentSessionId);
      this.rerunRequested.delete(parentSessionId);
    });
    this.scheduled.set(parentSessionId, task);
    return task;
  }

  private async drainUntilQuiet(parentSessionId: string): Promise<void> {
    do {
      this.rerunRequested.delete(parentSessionId);
      await this.drainAfterDelay(parentSessionId);
    } while (this.rerunRequested.has(parentSessionId));
  }

  private async drainAfterDelay(parentSessionId: string): Promise<void> {
    const delay = this.options.debounceMs ?? 30;
    if (delay > 0) await Bun.sleep(delay);
    if (this.options.isParentIdle && !this.options.isParentIdle(parentSessionId)) return;
    const terminalEntries = [
      ...await this.store.listInbox(parentSessionId, "pending"),
      ...await this.store.listInbox(parentSessionId, "delivered"),
    ];
    // Older Vesicle builds enqueued cancelled background runs. Cancellation
    // has no result to integrate, so consume those durable legacy entries
    // without starting a new parent provider turn.
    const cancelledIds = terminalEntries
      .filter((entry) => entry.status === "cancelled")
      .map((entry) => entry.inboxId);
    if (cancelledIds.length > 0) {
      await this.store.markInbox(parentSessionId, cancelledIds, "acknowledged");
    }
    const entries = terminalEntries.filter((entry) => entry.status !== "cancelled");
    if (entries.length === 0) return;
    const ids = entries.map((entry) => entry.inboxId);
    const pendingIds = entries.filter((entry) => entry.state === "pending").map((entry) => entry.inboxId);
    if (pendingIds.length > 0) await this.store.markInbox(parentSessionId, pendingIds, "delivered");
    try {
      await this.deliver(parentSessionId, entries, renderAgentResultPacket(entries));
    } catch (error) {
      if (error instanceof AgentDeliveryDeferred) return;
      throw error;
    }
    await this.store.markInbox(parentSessionId, ids, "acknowledged");
  }
}

export function renderAgentResultPacket(entries: AgentInboxEntry[]): string {
  const body = entries.map((entry) => [
    `  <agent id="${escapeAttribute(entry.handle)}" profile="${escapeAttribute(entry.profileId)}" status="${entry.status}">`,
    `    <description>${escapeText(entry.description)}</description>`,
    `    <result>${escapeText(entry.content)}</result>`,
    "  </agent>",
  ].join("\n")).join("\n");
  return [
    "<subagent-results>",
    "The following background SubAgents have reached terminal states. Integrate their results into the active work. Do not claim results from agents that are not listed here.",
    body,
    "</subagent-results>",
  ].join("\n");
}

function escapeText(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function escapeAttribute(value: string): string {
  return escapeText(value).replaceAll('"', "&quot;");
}
