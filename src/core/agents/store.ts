import { appendFile, mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";
import type { AgentInboxEntry, AgentInboxState, AgentMetadata, AgentTerminalResult } from "./types";
import { createSessionStore, loadSessionRecords } from "../session/store";

type InboxEvent =
  | { type: "enqueued"; ts: string; entry: AgentInboxEntry }
  | { type: "state"; ts: string; inboxId: string; state: Exclude<AgentInboxState, "pending"> };

export class AgentStore {
  readonly directory: string;
  readonly inboxDirectory: string;

  constructor(readonly rootDir: string) {
    this.directory = join(rootDir, ".vesicle", "subagents");
    this.inboxDirectory = join(this.directory, "inbox");
  }

  async save(metadata: AgentMetadata): Promise<void> {
    await mkdir(this.directory, { recursive: true });
    const path = this.metadataPath(metadata.runId);
    const temporary = `${path}.${crypto.randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(metadata, null, 2)}\n`, "utf8");
    await rename(temporary, path);
  }

  async load(runId: string): Promise<AgentMetadata | undefined> {
    const source = await readFile(this.metadataPath(runId), "utf8").catch((error: unknown) => {
      if (errorCode(error) === "ENOENT") return undefined;
      throw error;
    });
    return source ? parseMetadata(source, runId) : undefined;
  }

  async listByParent(parentSessionId: string): Promise<AgentMetadata[]> {
    const files = await readdir(this.directory).catch((error: unknown) => {
      if (errorCode(error) === "ENOENT") return [];
      throw error;
    });
    const agents = await Promise.all(
      files.filter((file) => file.endsWith(".json")).map((file) => this.load(file.slice(0, -5))),
    );
    return agents
      .filter((agent): agent is AgentMetadata => agent?.parentSessionId === parentSessionId)
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  }

  async resolveReference(parentSessionId: string, reference: string): Promise<AgentMetadata | undefined> {
    const agents = await this.listByParent(parentSessionId);
    const matches = agents.filter((agent) => agent.runId === reference || agent.handle === reference);
    if (matches.length > 1) throw new Error(`Ambiguous SubAgent reference: ${reference}.`);
    return matches[0];
  }

  async nextHandleOrdinal(parentSessionId: string, profileId: string): Promise<number> {
    const prefix = `${profileId}-`;
    let maximum = 0;
    for (const agent of await this.listByParent(parentSessionId)) {
      if (!agent.handle.startsWith(prefix)) continue;
      const suffix = agent.handle.slice(prefix.length);
      if (/^[1-9]\d*$/.test(suffix)) maximum = Math.max(maximum, Number(suffix));
    }
    return maximum + 1;
  }

  async recoverInterrupted(): Promise<AgentMetadata[]> {
    const files = await readdir(this.directory).catch((error: unknown) => {
      if (errorCode(error) === "ENOENT") return [];
      throw error;
    });
    const recovered: AgentMetadata[] = [];
    const interruption = "Vesicle exited before the SubAgent reached a terminal state.";
    for (const file of files.filter((name) => name.endsWith(".json"))) {
      const agent = await this.load(file.slice(0, -5));
      if (!agent) continue;
      const interrupted = agent?.status === "created" || agent?.status === "running";
      const incompleteRecovery = agent?.status === "failed"
        && agent.error === interruption
        && agent.recoveryComplete !== true;
      const alreadyTerminal = agent.status === "completed" || agent.status === "failed" || agent.status === "cancelled";
      if (!interrupted && !incompleteRecovery && !alreadyTerminal) continue;
      const next: AgentMetadata = interrupted || incompleteRecovery
        ? {
          ...agent,
          status: "failed",
          error: interruption,
          recoveryComplete: true,
          updatedAt: new Date().toISOString(),
        }
        : agent;
      const result = terminalResultFromMetadata(next);
      let repaired = false;
      if (next.mode === "background") {
        if (result.status !== "cancelled") {
          const existing = (await this.listInbox(next.parentSessionId))
            .some((entry) => entry.runId === next.runId);
          if (!existing) {
            await this.enqueue(next, result);
            repaired = true;
          }
        }
      } else {
        repaired = await this.appendRecoveredForegroundResult(next, result);
      }
      if (interrupted || incompleteRecovery) await this.save(next);
      if (interrupted || incompleteRecovery || repaired) recovered.push(next);
    }
    return recovered;
  }

  async enqueue(agent: AgentMetadata, result: AgentTerminalResult): Promise<AgentInboxEntry> {
    const createdAt = new Date().toISOString();
    const entry: AgentInboxEntry = {
      inboxId: `inbox_${crypto.randomUUID()}`,
      parentSessionId: agent.parentSessionId,
      runId: agent.runId,
      handle: agent.handle,
      profileId: agent.profileId,
      description: agent.description,
      status: result.status,
      content: result.content,
      ...(result.childSessionId ? { childSessionId: result.childSessionId } : {}),
      ...(result.usage ? { usage: result.usage } : {}),
      ...(result.toolUses ? { toolUses: result.toolUses } : {}),
      createdAt,
      state: "pending",
    };
    await this.appendInboxEvent(agent.parentSessionId, { type: "enqueued", ts: createdAt, entry });
    return entry;
  }

  async listInbox(parentSessionId: string, state?: AgentInboxState): Promise<AgentInboxEntry[]> {
    const source = await readFile(this.inboxPath(parentSessionId), "utf8").catch((error: unknown) => {
      if (errorCode(error) === "ENOENT") return "";
      throw error;
    });
    const entries = new Map<string, AgentInboxEntry>();
    for (const line of source.split("\n").filter(Boolean)) {
      const event = JSON.parse(line) as InboxEvent;
      if (event.type === "enqueued") {
        const entry = normalizeInboxEntry(event.entry);
        entries.set(entry.inboxId, entry);
        continue;
      }
      const current = entries.get(event.inboxId);
      if (!current) continue;
      entries.set(event.inboxId, {
        ...current,
        state: event.state,
        ...(event.state === "delivered" ? { deliveredAt: event.ts } : { acknowledgedAt: event.ts }),
      });
    }
    return [...entries.values()].filter((entry) => !state || entry.state === state);
  }

  async markInbox(parentSessionId: string, inboxIds: string[], state: Exclude<AgentInboxState, "pending">): Promise<void> {
    const now = new Date().toISOString();
    for (const inboxId of [...new Set(inboxIds)]) {
      await this.appendInboxEvent(parentSessionId, { type: "state", ts: now, inboxId, state });
    }
  }

  async acknowledgeAgentResult(parentSessionId: string, runId: string): Promise<void> {
    const entries = (await this.listInbox(parentSessionId))
      .filter((entry) => entry.runId === runId && entry.state !== "acknowledged");
    if (entries.length === 0) return;
    await this.markInbox(parentSessionId, entries.map((entry) => entry.inboxId), "acknowledged");
  }

  private async appendRecoveredForegroundResult(agent: AgentMetadata, result: AgentTerminalResult): Promise<boolean> {
    const existing = (await loadSessionRecords(this.rootDir, agent.parentSessionId)).some((record) => record.role === "tool"
      && record.metadata?.kind === "subagent-result"
      && record.metadata?.toolCallId === agent.parentToolCallId);
    if (existing) return false;
    const session = await createSessionStore(this.rootDir, agent.parentSessionId);
    const publicResult = {
      agent_id: result.handle,
      profileId: result.profileId,
      description: result.description,
      mode: result.mode,
      status: result.status,
      content: result.content,
    };
    const ok = result.status === "completed";
    await session.append({
      role: "tool",
      content: JSON.stringify({ ok, result: JSON.stringify(publicResult) }),
      metadata: {
        kind: "subagent-result",
        name: "spawn_agent",
        ok,
        toolCallId: agent.parentToolCallId,
        agentEvent: {
          kind: "subagent",
          handle: result.handle,
          profileId: result.profileId,
          mode: result.mode,
          status: result.status,
        },
      },
    });
    return true;
  }

  private metadataPath(runId: string): string {
    return join(this.directory, `${safeId(runId, "agent run id")}.json`);
  }

  private inboxPath(parentSessionId: string): string {
    const hash = createHash("sha256").update(parentSessionId).digest("hex");
    return join(this.inboxDirectory, `${hash}.jsonl`);
  }

  private async appendInboxEvent(parentSessionId: string, event: InboxEvent): Promise<void> {
    await mkdir(this.inboxDirectory, { recursive: true });
    await appendFile(this.inboxPath(parentSessionId), `${JSON.stringify(event)}\n`, "utf8");
  }
}

function normalizeInboxEntry(entry: AgentInboxEntry & { agentId?: string }): AgentInboxEntry {
  const runId = typeof entry.runId === "string" ? entry.runId : entry.agentId;
  if (!runId || typeof entry.profileId !== "string") throw new Error(`Invalid SubAgent inbox entry: ${entry.inboxId}.`);
  const { agentId: _legacyAgentId, ...rest } = entry;
  return {
    ...rest,
    runId,
    handle: typeof entry.handle === "string" && validAgentHandle(entry.handle)
      ? entry.handle
      : legacyAgentHandle(entry.profileId, runId),
  };
}

function safeId(value: string, label: string): string {
  if (!/^[A-Za-z0-9._-]+$/.test(value)) throw new Error(`Invalid ${label}: ${value}.`);
  return value;
}

function parseMetadata(source: string, expectedRunId: string): AgentMetadata {
  const value = JSON.parse(source) as AgentMetadata & { agentId?: string };
  const runId = typeof value?.runId === "string" ? value.runId : value?.agentId;
  if (!value || runId !== expectedRunId || typeof value.parentSessionId !== "string" || typeof value.profileId !== "string") {
    throw new Error(`Invalid SubAgent metadata for ${expectedRunId}.`);
  }
  const { agentId: _legacyAgentId, ...metadata } = value;
  return {
    ...metadata,
    runId,
    handle: typeof value.handle === "string" && validAgentHandle(value.handle)
      ? value.handle
      : legacyAgentHandle(value.profileId, runId),
  };
}

export function legacyAgentHandle(profileId: string, runId: string): string {
  const suffix = runId.replace(/^(?:agent_|run_)/, "").replaceAll("-", "").slice(0, 8) || "legacy";
  return `${profileId}-${suffix}`;
}

function validAgentHandle(value: string): boolean {
  return /^[a-z][a-z0-9-]{0,63}-[A-Za-z0-9]{1,16}$/.test(value);
}

function errorCode(error: unknown): string | undefined {
  return error && typeof error === "object" && "code" in error && typeof error.code === "string"
    ? error.code
    : undefined;
}

function terminalResultFromMetadata(agent: AgentMetadata): AgentTerminalResult {
  if (agent.status !== "completed" && agent.status !== "failed" && agent.status !== "cancelled") {
    throw new Error(`SubAgent is not terminal: ${agent.handle}.`);
  }
  return {
    runId: agent.runId,
    handle: agent.handle,
    parentSessionId: agent.parentSessionId,
    profileId: agent.profileId,
    description: agent.description,
    mode: agent.mode,
    status: agent.status,
    content: agent.result ?? agent.error ?? "",
    ...(agent.childSessionId ? { childSessionId: agent.childSessionId } : {}),
    ...(agent.usage ? { usage: agent.usage } : {}),
    ...(agent.toolUses ? { toolUses: agent.toolUses } : {}),
  };
}
