import { appendFile, mkdir, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseGateRequest } from "../gate/types";
import type { GateRequest } from "../gate/types";
import { engineIds } from "../engine/profile";
import type { EngineId } from "../engine/profile";
import { parseEngineSwitchRequest } from "../engine/switch";
import type { EngineSwitchRequest } from "../engine/switch";
import type { ProviderSelection } from "../../config/providers";
import { parseUserQuestionRequest } from "../user-question/types";
import type { UserQuestionRequest } from "../user-question/types";
import { reasoningTiers } from "../../providers/shared/types";
import type { ProviderThinkingBlock, ReasoningTier, ResponseUsage } from "../../providers/shared/types";
import type { VesicleImageAttachment } from "../../providers/shared/types";
import type { FileToolEvent, McpToolEvent, ProcessToolEvent, WebToolEvent } from "../tools";
import { parseImageAttachments } from "../attachments/store";
import { parseAssetFingerprint, type AssetFingerprint } from "../runtime/assets";
import { parsePermissionRequest } from "../permissions";
import type { PermissionMode, PermissionRequest } from "../permissions";

export type ReasoningDisplayMode = "hidden" | "collapsed" | "expanded";

export type SessionRole = "user" | "assistant" | "system" | "tool";

type ResumedToolCall = {
  id: string;
  name: string;
  arguments: string;
};

export type SessionRecord = {
  uuid: string;
  parentUuid: string | null;
  ts: string;
  sessionId: string;
  role: SessionRole;
  content: string;
  metadata?: Record<string, unknown>;
};

export type SessionStore = {
  sessionId: string;
  sessionPath: string;
  append(record: Omit<SessionRecord, "uuid" | "parentUuid" | "ts" | "sessionId">): Promise<SessionRecord>;
  headUuid(): string | null;
};

const sessionAppendTails = new Map<string, Promise<void>>();

export async function createSessionStore(
  rootDir = process.cwd(),
  sessionId = createSessionId(),
  options: { parentUuid?: string | null } = {},
): Promise<SessionStore> {
  const sessionDir = join(rootDir, ".vesicle", "sessions");
  await mkdir(sessionDir, { recursive: true });
  const sessionPath = join(sessionDir, `${sessionId}.jsonl`);
  let useExplicitParent = Object.hasOwn(options, "parentUuid");
  let headUuid = useExplicitParent
    ? options.parentUuid ?? null
    : await readLatestRecordUuid(sessionPath);

  return {
    sessionId,
    sessionPath,
    async append(record) {
      return serializeSessionAppend(sessionPath, async () => {
        const parentUuid = useExplicitParent
          ? headUuid
          : await readLatestRecordUuid(sessionPath);
        useExplicitParent = false;
        const line: SessionRecord = {
          uuid: crypto.randomUUID(),
          parentUuid,
          ts: new Date().toISOString(),
          sessionId,
          ...record,
        };
        await appendFile(sessionPath, `${JSON.stringify(line)}\n`, "utf8");
        headUuid = line.uuid;
        return line;
      });
    },
    headUuid: () => headUuid,
  };
}

function serializeSessionAppend<T>(sessionPath: string, operation: () => Promise<T>): Promise<T> {
  const previous = sessionAppendTails.get(sessionPath) ?? Promise.resolve();
  const result = previous.catch(() => undefined).then(operation);
  const tail = result.then(() => undefined, () => undefined);
  sessionAppendTails.set(sessionPath, tail);
  void tail.finally(() => {
    if (sessionAppendTails.get(sessionPath) === tail) sessionAppendTails.delete(sessionPath);
  });
  return result;
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
   * True when the session currently ends at an unresolved
   * request_confirmation call. The TUI can resume this as an interactive gate
   * instead of treating it as an ordinary transcript.
   */
  pendingGate?: {
    gate: string;
    summary: string;
  };
  pendingEngineSwitch?: {
    targetEngine: EngineId;
    reason: string;
  };
  pendingUserQuestion?: {
    header: string;
    question: string;
  };
  pendingPermission?: {
    tool: string;
    command?: string;
  };
};

/**
 * List every session JSONL under .vesicle/sessions/, newest first.
 *
 * Each file is parsed only lightly: we read line by line to capture the
 * first/last timestamps, the record count, and the first user message as a
 * preview. Fully reconstructing messages is loadSession's job.
 */
export async function listSessions(
  rootDir = process.cwd(),
  options: { includeSubagents?: boolean } = {},
): Promise<SessionSummary[]> {
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
    const allRecords = normalizeSessionRecords(lines.map((line) => JSON.parse(line) as Partial<SessionRecord>));
    if (!options.includeSubagents && allRecords[0]?.metadata?.kind === "subagent-session") continue;
    const records = buildActiveSessionBranch(allRecords);
    for (const record of records) {
      if (!firstRecord) firstRecord = record;
      lastRecord = record;
      if (preview === "(no user message)" && record.role === "user") {
        preview = record.content.length > 80 ? record.content.slice(0, 77) + "..." : record.content;
      }
    }
    if (!firstRecord || !lastRecord) continue;
    const pendingGate = findPendingGate(records);
    const pendingEngineSwitch = findPendingEngineSwitch(records);
    const pendingUserQuestion = findPendingUserQuestion(records);
    const pendingPermission = findPendingPermission(records);
    summaries.push({
      sessionId,
      startedAt: firstRecord.ts,
      updatedAt: lastRecord.ts,
      recordCount: allRecords.length,
      preview,
      ...(pendingGate ? { pendingGate: { gate: pendingGate.gate.gate, summary: pendingGate.gate.summary } } : {}),
      ...(pendingEngineSwitch
        ? { pendingEngineSwitch: { targetEngine: pendingEngineSwitch.request.targetEngine, reason: pendingEngineSwitch.request.reason } }
        : {}),
      ...(pendingUserQuestion
        ? { pendingUserQuestion: { header: pendingUserQuestion.question.header, question: pendingUserQuestion.question.question } }
        : {}),
      ...(pendingPermission
        ? { pendingPermission: { tool: pendingPermission.toolName, ...(pendingPermission.executionPlan ? { command: pendingPermission.executionPlan.command } : {}) } }
        : {}),
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
  thinkingBlocks?: ProviderThinkingBlock[];
  toolCallId?: string;
  toolCalls?: ResumedToolCall[];
  toolOk?: boolean;
  toolFileEvent?: FileToolEvent;
  toolWebEvent?: WebToolEvent;
  toolMcpEvent?: McpToolEvent;
  toolProcessEvent?: ProcessToolEvent;
  /** Engine/model that produced an assistant record (for the per-turn marker). */
  engine?: EngineId;
  model?: string;
  /** Host-only response telemetry; not forwarded to providers on resume. */
  usage?: ResponseUsage;
  /** Host-only display classification; not forwarded to providers. */
  kind?: string;
  images?: VesicleImageAttachment[];
};

export type SessionSnapshot = {
  sessionId: string;
  /** Active append-only branch, including host/system records. */
  records: SessionRecord[];
  /** Current leaf of the active branch. */
  headUuid: string | null;
  messages: ResumedMessage[];
  engine?: EngineId;
  providerSelection?: ProviderSelection;
  reasoningTier?: ReasoningTier;
  reasoningDisplayMode?: ReasoningDisplayMode;
  permissionMode?: PermissionMode;
  /** Asset profile/prompt fingerprint recorded when the session began. */
  assets?: AssetFingerprint;
  pendingGate?: {
    gate: GateRequest;
    toolCallId: string;
    assistantContent: string;
  };
  pendingEngineSwitch?: {
    request: EngineSwitchRequest;
    toolCallId: string;
    assistantContent: string;
  };
  pendingUserQuestion?: {
    question: UserQuestionRequest;
    toolCallId: string;
    assistantContent: string;
  };
  pendingPermission?: PermissionRequest;
};

export async function loadSessionMessages(rootDir: string, sessionId: string): Promise<ResumedMessage[]> {
  const snapshot = await loadSessionSnapshot(rootDir, sessionId, { synthesizeDanglingToolResults: true });
  return snapshot.messages;
}

export async function loadSessionRecords(rootDir: string, sessionId: string): Promise<SessionRecord[]> {
  const filePath = join(rootDir, ".vesicle", "sessions", `${sessionId}.jsonl`);
  const text = await readFile(filePath, "utf8");
  const lines = text.split("\n").filter((line) => line.trim().length > 0);
  return normalizeSessionRecords(lines.map((line) => JSON.parse(line) as Partial<SessionRecord>));
}

/**
 * Project one active branch from the append-only record graph. The newest
 * physical record is the default leaf, matching Claude Code's transcript
 * behavior after a fork has appended its first new message.
 */
export function buildActiveSessionBranch(
  records: SessionRecord[],
  options: { headUuid?: string | null } = {},
): SessionRecord[] {
  const requestedHead = Object.hasOwn(options, "headUuid")
    ? options.headUuid ?? null
    : records.at(-1)?.uuid ?? null;
  if (requestedHead === null) return [];

  const byUuid = new Map(records.map((record) => [record.uuid, record]));
  if (!byUuid.has(requestedHead)) {
    throw new Error(`Session branch head not found: ${requestedHead}`);
  }

  const branch: SessionRecord[] = [];
  const visited = new Set<string>();
  let cursor: string | null = requestedHead;
  while (cursor) {
    if (visited.has(cursor)) throw new Error(`Session branch contains a parent cycle at ${cursor}`);
    visited.add(cursor);
    const record = byUuid.get(cursor);
    if (!record) throw new Error(`Session branch parent not found: ${cursor}`);
    branch.push(record);
    cursor = record.parentUuid;
  }
  return branch.reverse();
}

export async function loadSessionSnapshot(
  rootDir: string,
  sessionId: string,
  options: { synthesizeDanglingToolResults?: boolean; headUuid?: string | null } = {},
): Promise<SessionSnapshot> {
  const filePath = join(rootDir, ".vesicle", "sessions", `${sessionId}.jsonl`);
  const text = await readFile(filePath, "utf8");
  const lines = text.split("\n").filter((line) => line.trim().length > 0);
  const allRecords = normalizeSessionRecords(lines.map((line) => JSON.parse(line) as Partial<SessionRecord>));
  const records = buildActiveSessionBranch(allRecords, options);

  const messages: ResumedMessage[] = [];
  let skippedFirstSystem = false;
  let engine: EngineId | undefined;
  let providerSelection: ProviderSelection | undefined;
  let reasoningTier: ReasoningTier | undefined;
  let reasoningDisplayMode: ReasoningDisplayMode | undefined;
  let permissionMode: PermissionMode | undefined;
  let assets: AssetFingerprint | undefined;

  for (const record of records) {
    if (record.metadata && Object.hasOwn(record.metadata, "engine")) {
      const nextEngine = readEngineId(record.metadata.engine);
      if (nextEngine) engine = nextEngine;
    }
    const providerId = record.metadata?.providerId;
    const model = record.metadata?.model;
    if (typeof providerId === "string" && typeof model === "string") {
      providerSelection = { provider: providerId, model };
    }
    if (record.metadata && Object.hasOwn(record.metadata, "reasoningTier")) {
      reasoningTier = readReasoningTier(record.metadata.reasoningTier);
    }
    if (record.metadata && Object.hasOwn(record.metadata, "reasoningDisplayMode")) {
      reasoningDisplayMode = readReasoningDisplayMode(record.metadata.reasoningDisplayMode);
    }
    if (isPermissionMode(record.metadata?.permissionMode)) permissionMode = record.metadata!.permissionMode as PermissionMode;

    if (record.role === "system") {
      // Skip the initial composed prompt; resume recomposes it. Also skip
      // trailing diagnostic system notices (validation, breaker notes).
      if (!skippedFirstSystem) {
        assets = parseAssetFingerprint(record.metadata?.assets);
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
      const thinkingBlocks = readThinkingBlocks(record.metadata?.thinkingBlocks);
      const engine = readEngineId(record.metadata?.engine);
      const model = typeof record.metadata?.model === "string" ? record.metadata.model : undefined;
      const usage = readResponseUsage(record.metadata?.usage);
      messages.push({
        role: "assistant",
        content: record.content,
        ...(engine ? { engine } : {}),
        ...(model ? { model } : {}),
        ...(reasoningContent ? { reasoningContent } : {}),
        ...(thinkingBlocks ? { thinkingBlocks } : {}),
        ...(toolCalls ? { toolCalls } : {}),
        ...(usage ? { usage } : {}),
      });
      continue;
    }

    if (record.role === "user") {
      const kind = typeof record.metadata?.kind === "string" ? record.metadata.kind : undefined;
      const usage = readResponseUsage(record.metadata?.usage);
      const images = parseImageAttachments(record.metadata?.images);
      messages.push({
        role: "user",
        content: record.content,
        ...(kind ? { kind } : {}),
        ...(usage ? { usage } : {}),
        ...(images ? { images } : {}),
      });
      continue;
    }

    if (record.role === "tool") {
      const toolCallId = record.metadata?.toolCallId as string | undefined;
      const toolOk = record.metadata?.ok as boolean | undefined;
      const toolFileEvent = record.metadata?.fileEvent as FileToolEvent | undefined;
      const toolWebEvent = record.metadata?.webEvent as WebToolEvent | undefined;
      const toolMcpEvent = record.metadata?.mcpEvent as McpToolEvent | undefined;
      const toolProcessEvent = record.metadata?.processEvent as ProcessToolEvent | undefined;
      const images = parseImageAttachments(record.metadata?.images);
      const kind = typeof record.metadata?.kind === "string" ? record.metadata.kind : undefined;
      const usage = readResponseUsage(record.metadata?.usage);
      messages.push({
        role: "tool",
        content: record.content,
        ...(toolCallId ? { toolCallId } : {}),
        ...(typeof toolOk === "boolean" ? { toolOk } : {}),
        ...(toolFileEvent ? { toolFileEvent } : {}),
        ...(toolWebEvent ? { toolWebEvent } : {}),
        ...(toolMcpEvent ? { toolMcpEvent } : {}),
        ...(toolProcessEvent ? { toolProcessEvent } : {}),
        ...(kind ? { kind } : {}),
        ...(usage ? { usage } : {}),
        ...(images ? { images } : {}),
      });
    }
  }

  const pendingGate = findPendingGate(records);
  const pendingEngineSwitch = findPendingEngineSwitch(records);
  const pendingUserQuestion = findPendingUserQuestion(records);
  const pendingPermission = findPendingPermission(records);
  appendIndeterminateProcessResults(messages, records);
  const preservedPendingCallIds = options.synthesizeDanglingToolResults
    ? new Set<string>()
    : new Set([
        pendingGate?.toolCallId,
        pendingEngineSwitch?.toolCallId,
        pendingUserQuestion?.toolCallId,
        pendingPermission?.toolCallId,
      ].filter((value): value is string => typeof value === "string"));
  // Preserve the one request that the interactive TUI can still resolve. Any
  // other unpaired call belongs to an interrupted execution window and must
  // receive a synthetic failure instead of being replayed implicitly.
  appendDanglingToolResults(messages, preservedPendingCallIds);

  return {
    sessionId,
    records,
    headUuid: records.at(-1)?.uuid ?? null,
    messages,
    ...(engine ? { engine } : {}),
    ...(providerSelection ? { providerSelection } : {}),
    ...(reasoningTier ? { reasoningTier } : {}),
    ...(reasoningDisplayMode ? { reasoningDisplayMode } : {}),
    ...(permissionMode ? { permissionMode } : {}),
    ...(assets ? { assets } : {}),
    ...(pendingGate
      ? {
          pendingGate: {
            gate: pendingGate.gate,
            toolCallId: pendingGate.toolCallId,
            assistantContent: pendingGate.assistantContent,
          },
        }
      : {}),
    ...(pendingEngineSwitch
      ? {
          pendingEngineSwitch: {
            request: pendingEngineSwitch.request,
            toolCallId: pendingEngineSwitch.toolCallId,
            assistantContent: pendingEngineSwitch.assistantContent,
          },
        }
      : {}),
    ...(pendingUserQuestion
      ? {
          pendingUserQuestion: {
            question: pendingUserQuestion.question,
            toolCallId: pendingUserQuestion.toolCallId,
            assistantContent: pendingUserQuestion.assistantContent,
          },
        }
      : {}),
    ...(pendingPermission ? { pendingPermission } : {}),
  };
}

function appendIndeterminateProcessResults(messages: ResumedMessage[], records: SessionRecord[]): void {
  const finishedRequestIds = new Set<string>();
  const answeredToolCallIds = new Set(messages.flatMap((message) => message.toolCallId ? [message.toolCallId] : []));
  for (const record of records) {
    if (record.role !== "tool") continue;
    const requestId = record.metadata?.permissionRequestId;
    if (typeof requestId === "string") finishedRequestIds.add(requestId);
  }
  for (const record of records) {
    if (record.metadata?.kind !== "process-started") continue;
    const requestId = record.metadata.requestId;
    const toolCallId = record.metadata.toolCallId;
    if (typeof requestId !== "string" || typeof toolCallId !== "string") continue;
    if (finishedRequestIds.has(requestId) || answeredToolCallIds.has(toolCallId)) continue;
    messages.push({
      role: "tool",
      toolCallId,
      toolOk: false,
      kind: "process-indeterminate",
      content: JSON.stringify({
        ok: false,
        result: "The approved shell process started before Vesicle stopped, but no completion record exists. Its side effects are indeterminate and the command was not replayed.",
      }),
    });
    answeredToolCallIds.add(toolCallId);
  }
}

function isPermissionMode(value: unknown): value is PermissionMode {
  return value === "MANUAL" || value === "INERTIA" || value === "MOMENTUM" || value === "YOLO";
}

function readEngineId(value: unknown): EngineId | undefined {
  return typeof value === "string" && (engineIds as readonly string[]).includes(value)
    ? value as EngineId
    : undefined;
}

function normalizeSessionRecords(records: Partial<SessionRecord>[]): SessionRecord[] {
  let previousUuid: string | null = null;
  return records.map((raw, index) => {
    const sessionId = typeof raw.sessionId === "string" ? raw.sessionId : "unknown-session";
    const uuid = typeof raw.uuid === "string" && raw.uuid.length > 0
      ? raw.uuid
      : `${sessionId}:legacy:${index}`;
    const explicitParent = Object.hasOwn(raw, "parentUuid")
      && (typeof raw.parentUuid === "string" || raw.parentUuid === null);
    const normalized = {
      ...raw,
      uuid,
      parentUuid: explicitParent ? raw.parentUuid! : previousUuid,
    } as SessionRecord;
    previousUuid = uuid;
    return normalized;
  });
}

async function readLatestRecordUuid(sessionPath: string): Promise<string | null> {
  try {
    const text = await readFile(sessionPath, "utf8");
    const lines = text.split("\n").filter((line) => line.trim().length > 0);
    const records = normalizeSessionRecords(lines.map((line) => JSON.parse(line) as Partial<SessionRecord>));
    return records.at(-1)?.uuid ?? null;
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return null;
    throw error;
  }
}

function readReasoningTier(value: unknown): ReasoningTier | undefined {
  return typeof value === "string" && (reasoningTiers as readonly string[]).includes(value)
    ? value as ReasoningTier
    : undefined;
}

function readReasoningDisplayMode(value: unknown): ReasoningDisplayMode | undefined {
  return value === "hidden" || value === "collapsed" || value === "expanded"
    ? value
    : undefined;
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

function findPendingEngineSwitch(records: SessionRecord[]): { request: EngineSwitchRequest; toolCallId: string; assistantContent: string } | undefined {
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
    const switchCall = toolCalls?.find((call) => call.name === "request_engine_switch" && !answeredToolCallIds.has(call.id));
    if (!switchCall) return undefined;
    try {
      return {
        request: parseEngineSwitchRequest(switchCall),
        toolCallId: switchCall.id,
        assistantContent: record.content,
      };
    } catch {
      return undefined;
    }
  }

  return undefined;
}

function findPendingUserQuestion(records: SessionRecord[]): { question: UserQuestionRequest; toolCallId: string; assistantContent: string } | undefined {
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
    const questionCall = toolCalls?.find((call) => call.name === "ask_user_question" && !answeredToolCallIds.has(call.id));
    if (!questionCall) return undefined;
    try {
      return {
        question: parseUserQuestionRequest(questionCall),
        toolCallId: questionCall.id,
        assistantContent: record.content,
      };
    } catch {
      return undefined;
    }
  }

  return undefined;
}

function findPendingPermission(records: SessionRecord[]): PermissionRequest | undefined {
  const resolved = new Set<string>();
  for (const record of records) {
    if (record.metadata?.kind !== "permission-resolution") continue;
    const requestId = record.metadata.requestId;
    if (typeof requestId === "string") resolved.add(requestId);
  }
  for (let index = records.length - 1; index >= 0; index--) {
    const record = records[index];
    if (record.metadata?.kind !== "permission-request") continue;
    const request = parsePermissionRequest(record.metadata.request);
    if (request && !resolved.has(request.id)) return request;
  }
  return undefined;
}

function readThinkingBlocks(value: unknown): ProviderThinkingBlock[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const blocks = value.filter(isKnownThinkingBlock);
  return blocks.length > 0 ? blocks : undefined;
}

function readResponseUsage(value: unknown): ResponseUsage | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const source = value as Record<string, unknown>;
  const usage: ResponseUsage = {};
  copyFiniteNumber(source, usage, "contextInputTokens");
  copyFiniteNumber(source, usage, "inputTokens");
  copyFiniteNumber(source, usage, "outputTokens");
  copyFiniteNumber(source, usage, "totalTokens");
  copyFiniteNumber(source, usage, "cacheReadInputTokens");
  copyFiniteNumber(source, usage, "cacheWriteInputTokens");
  copyFiniteNumber(source, usage, "cacheHitInputTokens");
  copyFiniteNumber(source, usage, "cacheMissInputTokens");
  copyFiniteNumber(source, usage, "reasoningTokens");
  copyFiniteNumber(source, usage, "effectiveTokens");
  if (source.providerDetails && typeof source.providerDetails === "object" && !Array.isArray(source.providerDetails)) {
    usage.providerDetails = { ...(source.providerDetails as Record<string, unknown>) };
  }
  return Object.keys(usage).length > 0 ? usage : undefined;
}

function copyFiniteNumber(source: Record<string, unknown>, target: ResponseUsage, key: keyof ResponseUsage): void {
  const value = source[key];
  if (typeof value === "number" && Number.isFinite(value)) {
    (target as Record<string, unknown>)[key] = value;
  }
}

function isKnownThinkingBlock(value: unknown): value is ProviderThinkingBlock {
  if (!value || typeof value !== "object") return false;
  const block = value as ProviderThinkingBlock;
  switch (block.type) {
    case "reasoning":
      return typeof block.reasoningContent === "string";
    case "thinking":
      return typeof block.thinking === "string";
    case "redacted_thinking":
      return typeof block.data === "string";
    case "thought_summary":
      return typeof block.text === "string" || typeof block.summary === "string";
    default:
      return false;
  }
}

/**
 * For every assistant tool_calls entry that lacks a following tool result,
 * append a synthetic interruption result unless the interactive TUI still
 * owns that exact request. This keeps provider history valid across every
 * crash window without replaying a possibly side-effecting tool.
 */
function appendDanglingToolResults(messages: ResumedMessage[], preservedCallIds = new Set<string>()): void {
  const answeredToolCallIds = new Set<string>();
  for (const message of messages) {
    if (message.role === "tool" && message.toolCallId) {
      answeredToolCallIds.add(message.toolCallId);
    }
  }

  for (let i = 0; i < messages.length; i++) {
    const message = messages[i];
    if (message.role !== "assistant" || !message.toolCalls) continue;
    const dangling = message.toolCalls.filter((call) =>
      !answeredToolCallIds.has(call.id) && !preservedCallIds.has(call.id)
    );
    if (dangling.length === 0) continue;

    // Insert synthetic tool results immediately after this assistant message
    // so the list stays provider-valid. Splice at i+1 and advance i past them.
    const synthetic: ResumedMessage[] = dangling.map((call) => ({
      role: "tool",
      toolCallId: call.id,
      toolOk: false,
      kind: "tool-interrupted",
      content: JSON.stringify({
        ok: false,
        result: "This tool call was not resolved with a durable result before Vesicle stopped. It was not replayed because its side effects may be indeterminate.",
      }),
    }));
    messages.splice(i + 1, 0, ...synthetic);
    i += synthetic.length;
  }
}
