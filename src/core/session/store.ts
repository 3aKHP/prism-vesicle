import { appendFile, mkdir, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseGateRequest } from "../gate/types";
import type { GateRequest } from "../gate/types";
import type { ProviderSelection } from "../../config/providers";

export type SessionRole = "user" | "assistant" | "system" | "tool";

type ResumedToolCall = {
  id: string;
  name: string;
  arguments: string;
};

export type SessionRecord = {
  ts: string;
  sessionId: string;
  role: SessionRole;
  content: string;
  metadata?: Record<string, unknown>;
};

export type SessionStore = {
  sessionId: string;
  sessionPath: string;
  append(record: Omit<SessionRecord, "ts" | "sessionId">): Promise<void>;
};

export async function createSessionStore(rootDir = process.cwd(), sessionId = createSessionId()): Promise<SessionStore> {
  const sessionDir = join(rootDir, ".vesicle", "sessions");
  await mkdir(sessionDir, { recursive: true });
  const sessionPath = join(sessionDir, `${sessionId}.jsonl`);

  return {
    sessionId,
    sessionPath,
    async append(record) {
      const line: SessionRecord = {
        ts: new Date().toISOString(),
        sessionId,
        ...record,
      };
      await appendFile(sessionPath, `${JSON.stringify(line)}\n`, "utf8");
    },
  };
}

function createSessionId(): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const suffix = crypto.randomUUID().slice(0, 8);
  return `${stamp}-${suffix}`;
}

// --- session discovery + reload -------------------------------------------

export type SessionSummary = {
  sessionId: string;
  /** ISO timestamp of the first record. */
  startedAt: string;
  /** ISO timestamp of the most recent record. */
  updatedAt: string;
  /** Total record count in the JSONL file. */
  recordCount: number;
  /**
   * Preview of the first user message, truncated. Lets the TUI list show
   * what each session was about without parsing the whole transcript.
   */
  preview: string;
  /**
   * True when the session currently ends at an unresolved request_confirmation
   * call. The TUI can resume this as an interactive gate instead of treating
   * it as an ordinary transcript.
   */
  pendingGate?: {
    gate: string;
    summary: string;
  };
};

/**
 * List every session JSONL under .vesicle/sessions/, newest first.
 *
 * Each file is parsed only lightly: we read line by line to capture the
 * first/last timestamps, the record count, and the first user message as a
 * preview. Fully reconstructing messages is loadSession's job.
 */
export async function listSessions(rootDir = process.cwd()): Promise<SessionSummary[]> {
  const sessionDir = join(rootDir, ".vesicle", "sessions");
  let files: string[];
  try {
    files = await readdir(sessionDir);
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return [];
    throw error;
  }

  const summaries: SessionSummary[] = [];
  for (const file of files) {
    if (!file.endsWith(".jsonl")) continue;
    const sessionId = file.slice(0, -".jsonl".length);
    const filePath = join(sessionDir, file);
    const text = await readFile(filePath, "utf8");
    const lines = text.split("\n").filter((line) => line.trim().length > 0);
    if (lines.length === 0) continue;

    let firstRecord: SessionRecord | null = null;
    let lastRecord: SessionRecord | null = null;
    let preview = "(no user message)";
    const records: SessionRecord[] = [];
    for (const line of lines) {
      const record = JSON.parse(line) as SessionRecord;
      records.push(record);
      if (!firstRecord) firstRecord = record;
      lastRecord = record;
      if (preview === "(no user message)" && record.role === "user") {
        preview = record.content.length > 80 ? record.content.slice(0, 77) + "..." : record.content;
      }
    }
    if (!firstRecord || !lastRecord) continue;
    const pendingGate = findPendingGate(records);
    summaries.push({
      sessionId,
      startedAt: firstRecord.ts,
      updatedAt: lastRecord.ts,
      recordCount: lines.length,
      preview,
      ...(pendingGate ? { pendingGate: { gate: pendingGate.gate.gate, summary: pendingGate.gate.summary } } : {}),
    });
  }

  summaries.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  return summaries;
}

/**
 * Reconstruct the VesicleMessage[] for a session so a resumed conversation
 * can pass prior turns back to the provider.
 *
 * Reconstruction rules:
 * - Skip the very first system record (the composed prompt); the loop
 *   recomposes it fresh from the engine profile on resume.
 * - Skip trailing system notices (validation results, breaker notes) since
 *   they are host diagnostics, not conversational turns.
 * - assistant records carry toolCalls in metadata; restore them on the
 *   message so the provider sees the original tool_call structure.
 * - tool records map directly to { role: "tool", toolCallId, content }.
 */
export type ResumedMessage = {
  role: "user" | "assistant" | "tool";
  content: string;
  reasoningContent?: string;
  toolCallId?: string;
  toolCalls?: ResumedToolCall[];
};

export type SessionSnapshot = {
  sessionId: string;
  messages: ResumedMessage[];
  providerSelection?: ProviderSelection;
  pendingGate?: {
    gate: GateRequest;
    toolCallId: string;
    assistantContent: string;
  };
};

export async function loadSessionMessages(rootDir: string, sessionId: string): Promise<ResumedMessage[]> {
  const snapshot = await loadSessionSnapshot(rootDir, sessionId, { synthesizeDanglingToolResults: true });
  return snapshot.messages;
}

export async function loadSessionSnapshot(
  rootDir: string,
  sessionId: string,
  options: { synthesizeDanglingToolResults?: boolean } = {},
): Promise<SessionSnapshot> {
  const filePath = join(rootDir, ".vesicle", "sessions", `${sessionId}.jsonl`);
  const text = await readFile(filePath, "utf8");
  const lines = text.split("\n").filter((line) => line.trim().length > 0);
  const records = lines.map((line) => JSON.parse(line) as SessionRecord);

  const messages: ResumedMessage[] = [];
  let skippedFirstSystem = false;
  let providerSelection: ProviderSelection | undefined;

  for (const record of records) {
    const providerId = record.metadata?.providerId;
    const model = record.metadata?.model;
    if (typeof providerId === "string" && typeof model === "string") {
      providerSelection = { provider: providerId, model };
    }

    if (record.role === "system") {
      // Skip the initial composed prompt; resume recomposes it. Also skip
      // trailing diagnostic system notices (validation, breaker notes).
      if (!skippedFirstSystem) {
        skippedFirstSystem = true;
        continue;
      }
      const kind = record.metadata?.kind;
      if (kind === "validation" || kind === "no-progress-breaker") continue;
      // Any other system record (gate notices) — also skip, they are host UX.
      continue;
    }

    if (record.role === "assistant") {
      const toolCalls = record.metadata?.toolCalls as ResumedToolCall[] | undefined;
      const reasoningContent = record.metadata?.reasoningContent as string | undefined;
      messages.push({
        role: "assistant",
        content: record.content,
        ...(reasoningContent ? { reasoningContent } : {}),
        ...(toolCalls ? { toolCalls } : {}),
      });
      continue;
    }

    if (record.role === "user") {
      messages.push({ role: "user", content: record.content });
      continue;
    }

    if (record.role === "tool") {
      const toolCallId = record.metadata?.toolCallId as string | undefined;
      messages.push({
        role: "tool",
        content: record.content,
        ...(toolCallId ? { toolCallId } : {}),
      });
    }
  }

  const pendingGate = findPendingGate(records);
  if (options.synthesizeDanglingToolResults ?? false) {
    // CR B1: a session that paused at a gate ends with an assistant message
    // carrying a request_confirmation tool call, but no tool result was ever
    // written (the user had not resolved the gate before the session ended).
    // The OpenAI Chat Completions API rejects an assistant tool_calls message
    // that is not followed by matching tool results. Synthesize a placeholder
    // result for non-interactive resume paths so the provider request is valid.
    appendDanglingToolResults(messages);
  }

  return {
    sessionId,
    messages,
    ...(providerSelection ? { providerSelection } : {}),
    ...(pendingGate
      ? {
          pendingGate: {
            gate: pendingGate.gate,
            toolCallId: pendingGate.toolCallId,
            assistantContent: pendingGate.assistantContent,
          },
        }
      : {}),
  };
}

function findPendingGate(records: SessionRecord[]): { gate: GateRequest; toolCallId: string; assistantContent: string } | undefined {
  const answeredToolCallIds = new Set<string>();
  for (const record of records) {
    if (record.role === "tool") {
      const toolCallId = record.metadata?.toolCallId;
      if (typeof toolCallId === "string") answeredToolCallIds.add(toolCallId);
    }
  }

  for (let index = records.length - 1; index >= 0; index--) {
    const record = records[index];
    if (record.role !== "assistant") continue;
    const toolCalls = record.metadata?.toolCalls as ResumedToolCall[] | undefined;
    const gateCall = toolCalls?.find((call) => call.name === "request_confirmation" && !answeredToolCallIds.has(call.id));
    if (!gateCall) return undefined;
    try {
      return {
        gate: parseGateRequest(gateCall),
        toolCallId: gateCall.id,
        assistantContent: record.content,
      };
    } catch {
      return undefined;
    }
  }

  return undefined;
}

/**
 * For every assistant tool_calls entry that lacks a following tool result,
 * append a synthetic "gate was not resolved before session ended" result.
 * This lets a resumed session feed a well-formed message list back to the
 * provider without HTTP 400 "tool_call id missing" errors.
 */
function appendDanglingToolResults(messages: ResumedMessage[]): void {
  const answeredToolCallIds = new Set<string>();
  for (const message of messages) {
    if (message.role === "tool" && message.toolCallId) {
      answeredToolCallIds.add(message.toolCallId);
    }
  }

  for (let i = 0; i < messages.length; i++) {
    const message = messages[i];
    if (message.role !== "assistant" || !message.toolCalls) continue;
    const dangling = message.toolCalls.filter((call) => !answeredToolCallIds.has(call.id));
    if (dangling.length === 0) continue;

    // Insert synthetic tool results immediately after this assistant message
    // so the list stays provider-valid. Splice at i+1 and advance i past them.
    const synthetic: ResumedMessage[] = dangling.map((call) => ({
      role: "tool",
      toolCallId: call.id,
      content: JSON.stringify({
        ok: false,
        result: "This gate was not resolved before the session ended. The user is resuming the conversation.",
      }),
    }));
    messages.splice(i + 1, 0, ...synthetic);
    i += synthetic.length;
  }
}
