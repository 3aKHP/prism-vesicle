import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseGateRequest } from "../gate/types";
import type { GateRequest } from "../gate/types";
import type { EngineId } from "../engine/profile";
import { parseEngineSwitchRequest } from "../engine/switch";
import type { EngineSwitchRequest } from "../engine/switch";
import type { ProviderSelection } from "../../config/providers";
import { parseUserQuestionRequest } from "../user-question/types";
import type { UserQuestionRequest } from "../user-question/types";
import type { ProviderThinkingBlock, ReasoningTier, ResponseUsage } from "../../providers/shared/types";
import type { VesicleImageAttachment } from "../../providers/shared/types";
import type { FileToolEvent, McpToolEvent, ProcessToolEvent, WebToolEvent } from "../tools";
import type { AssetFingerprint } from "../runtime/assets";
import { parsePermissionRequest } from "../permissions";
import type { PermissionMode, PermissionRequest } from "../permissions";
import { parseHarnessDelegationDecision, type HarnessDelegationDecision } from "../harness/driver";
import {
  type DurableQualityArtifactTarget,
  type QualityDecisionCandidate,
  type QualityDecisionPoint,
  type ExperimentalQualityProfileSnapshot,
  type QualityEvent,
  type QualityWarning,
} from "../quality";
import type { HarnessRuntimeIdentity } from "../harness/driver";
import { parseStageBootstrapMetadata, type StageBootstrapMetadata } from "../stage/types";
import { buildActiveSessionBranch, normalizeSessionRecords, type ResumedToolCall, type SessionRecord } from "./record-model";
import { projectSessionHistory } from "./history-projector";
import { repairProviderHistory } from "./provider-history-repair";
import { findPendingQualityDecision, findPendingQualityRewrite, findQualityEvents, findQualityWarnings } from "./quality-recovery";

export { buildActiveSessionBranch } from "./record-model";
export type { SessionRecord, SessionRole } from "./record-model";
export { createSessionStore } from "./append-store";
export type { SessionStore } from "./append-store";

export type ReasoningDisplayMode = "hidden" | "collapsed" | "expanded";

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
  pendingDelegationRetry?: PendingDelegationRetry;
  pendingQuality?: {
    state: "decision" | "interrupted";
    producer: EngineId;
    findingCount: number;
  };
};

export type PendingDelegationRetry = {
  intentId: string;
  interactionId: string;
  failedRunId: string;
  delegationId: string;
  attempt: number;
  retryCallId: string;
};

export type PendingQualityRewrite = {
  producer: EngineId;
  packId: string;
  packVersion: string;
  manifestSha256: string;
  ruleVersion: string;
  ruleSourceHash: string;
  attempts: number;
  rejectedHashes: string[];
  candidateParts: string[];
  targets: DurableQualityArtifactTarget[];
  warningId?: string;
  warningTargetIds?: string[];
  candidate?: QualityDecisionCandidate;
  experimentalJudge?: ExperimentalQualityProfileSnapshot;
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
    const pendingDelegationRetry = findPendingDelegationRetry(records);
    const pendingDelegationDecisionRecovery = findPendingDelegationDecisionRecovery(records);
    const pendingQualityDecision = findPendingQualityDecision(records);
    const pendingQualityRewrite = findPendingQualityRewrite(records);
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
      ...(pendingUserQuestion || pendingDelegationDecisionRecovery
        ? {
          pendingUserQuestion: {
            header: (pendingUserQuestion?.question ?? pendingDelegationDecisionRecovery!.question).header,
            question: (pendingUserQuestion?.question ?? pendingDelegationDecisionRecovery!.question).question,
          },
        }
        : {}),
      ...(pendingPermission
        ? { pendingPermission: { tool: pendingPermission.toolName, ...(pendingPermission.executionPlan ? { command: pendingPermission.executionPlan.command } : {}) } }
        : {}),
      ...(pendingDelegationRetry ? { pendingDelegationRetry } : {}),
      ...(pendingQualityDecision
        ? {
            pendingQuality: {
              state: "decision" as const,
              producer: pendingQualityDecision.request.producer,
              findingCount: pendingQualityDecision.request.findingCount,
            },
          }
        : pendingQualityRewrite
          ? {
              pendingQuality: {
                state: "interrupted" as const,
                producer: pendingQualityRewrite.producer,
                findingCount: findQualityEvents(records).at(-1)?.findingIds.length ?? 0,
              },
            }
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
  harness?: HarnessRuntimeIdentity;
  /** Frozen character/scenario context for a Stage session. */
  stageBootstrap?: StageBootstrapMetadata;
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
    delegationDecision?: HarnessDelegationDecision;
  };
  pendingPermission?: PermissionRequest;
  pendingDelegationRetry?: PendingDelegationRetry;
  pendingDelegationDecisionRecovery?: HarnessDelegationDecision;
  pendingQualityRewrite?: PendingQualityRewrite;
  pendingQualityDecision?: QualityDecisionPoint;
  qualityWarnings: QualityWarning[];
  qualityEvents: QualityEvent[];
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

  const projection = projectSessionHistory(records);
  const messages = projection.messages;

  const pendingGate = findPendingGate(records);
  const pendingEngineSwitch = findPendingEngineSwitch(records);
  const pendingUserQuestion = findPendingUserQuestion(records);
  const pendingPermission = findPendingPermission(records);
  const pendingDelegationRetry = findPendingDelegationRetry(records);
  const pendingDelegationDecisionRecovery = findPendingDelegationDecisionRecovery(records);
  const qualityEvents = findQualityEvents(records);
  const pendingQualityRewrite = findPendingQualityRewrite(records);
  const pendingQualityDecision = findPendingQualityDecision(records);
  const qualityWarnings = findQualityWarnings(records);
  const stageBootstrap = records
    .filter((record) => record.role === "system")
    .map((record) => parseStageBootstrapMetadata(record.metadata?.stageBootstrap))
    .find((value): value is StageBootstrapMetadata => value !== undefined);
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
  repairProviderHistory(messages, records, preservedPendingCallIds);

  return {
    sessionId,
    records,
    headUuid: records.at(-1)?.uuid ?? null,
    messages,
    qualityEvents,
    qualityWarnings,
    ...(projection.engine ? { engine: projection.engine } : {}),
    ...(projection.providerSelection ? { providerSelection: projection.providerSelection } : {}),
    ...(projection.reasoningTier ? { reasoningTier: projection.reasoningTier } : {}),
    ...(projection.reasoningDisplayMode ? { reasoningDisplayMode: projection.reasoningDisplayMode } : {}),
    ...(projection.permissionMode ? { permissionMode: projection.permissionMode } : {}),
    ...(projection.assets ? { assets: projection.assets } : {}),
    ...(projection.harness ? { harness: projection.harness } : {}),
    ...(stageBootstrap ? { stageBootstrap } : {}),
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
            ...(pendingUserQuestion.delegationDecision ? { delegationDecision: pendingUserQuestion.delegationDecision } : {}),
          },
        }
      : {}),
    ...(pendingPermission ? { pendingPermission } : {}),
    ...(pendingDelegationRetry ? { pendingDelegationRetry } : {}),
    ...(pendingDelegationDecisionRecovery ? { pendingDelegationDecisionRecovery } : {}),
    ...(pendingQualityRewrite ? { pendingQualityRewrite } : {}),
    ...(pendingQualityDecision ? { pendingQualityDecision } : {}),
  };
}

function findPendingDelegationDecisionRecovery(records: SessionRecord[]): HarnessDelegationDecision | undefined {
  const persisted = new Map<string, HarnessDelegationDecision>();
  const restored = new Set<string>();
  for (const record of records) {
    if (record.role === "tool" && record.metadata?.delegationDecision) {
      try {
        const decision = parseHarnessDelegationDecision(record.metadata.delegationDecision);
        persisted.set(decision.failed.runId, decision);
      } catch {
        // Invalid host metadata cannot be restored as an executable decision.
      }
    }
    if (record.role === "assistant" && record.metadata?.kind === "delegation-decision-point") {
      try {
        restored.add(parseHarnessDelegationDecision(record.metadata.decision).failed.runId);
      } catch {
        // The malformed decision point remains unusable and does not mask recovery.
      }
    }
  }
  return [...persisted.values()].reverse().find((decision) => !restored.has(decision.failed.runId));
}

function findPendingDelegationRetry(records: SessionRecord[]): PendingDelegationRetry | undefined {
  const intents = new Map<string, PendingDelegationRetry>();
  const authorized = new Set<string>();
  const answeredToolCallIds = new Set(records.flatMap((record) =>
    record.role === "tool" && typeof record.metadata?.toolCallId === "string"
      ? [record.metadata.toolCallId]
      : []
  ));
  for (const record of records) {
    if (record.metadata?.kind === "delegation-retry-intent") {
      const intent = parsePendingDelegationRetry(record.metadata.retryIntent);
      if (intent) intents.set(intent.intentId, intent);
    }
    const retryIntentId = record.metadata?.retryIntentId;
    if (typeof retryIntentId !== "string") continue;
    if (record.metadata?.kind === "delegation-decision-resolution" && record.metadata.optionId === "retry") {
      authorized.add(retryIntentId);
    }
  }
  return [...intents.values()].reverse().find((intent) =>
    authorized.has(intent.intentId) && !answeredToolCallIds.has(intent.retryCallId)
  );
}

function parsePendingDelegationRetry(value: unknown): PendingDelegationRetry | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const source = value as Record<string, unknown>;
  if (typeof source.id !== "string"
    || typeof source.interactionId !== "string"
    || typeof source.failedRunId !== "string"
    || typeof source.delegationId !== "string"
    || !Number.isInteger(source.attempt)
    || Number(source.attempt) < 1
    || typeof source.retryCallId !== "string") return undefined;
  return {
    intentId: source.id,
    interactionId: source.interactionId,
    failedRunId: source.failedRunId,
    delegationId: source.delegationId,
    attempt: Number(source.attempt),
    retryCallId: source.retryCallId,
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

function findPendingUserQuestion(records: SessionRecord[]): {
  question: UserQuestionRequest;
  toolCallId: string;
  assistantContent: string;
  delegationDecision?: HarnessDelegationDecision;
} | undefined {
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
      const delegationDecision = record.metadata?.kind === "delegation-decision-point"
        ? parseHarnessDelegationDecision(record.metadata.decision)
        : undefined;
      return {
        question: delegationDecision?.question ?? parseUserQuestionRequest(questionCall),
        toolCallId: questionCall.id,
        assistantContent: record.content,
        ...(delegationDecision ? { delegationDecision } : {}),
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
