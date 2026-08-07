import type { ResumedMessage } from "./store";
import type { ProviderStateEnvelope } from "../../providers/shared/state";
import { parseProviderStateEnvelope } from "../../providers/shared/state";

/**
 * The durable, versioned replacement-history checkpoint installed by every
 * portable compaction. One system-role record with `metadata.kind =
 * "compact-checkpoint-v1"` carries this payload. The record — not regenerated
 * prose — is the authority for the provider-visible replacement history; the
 * original append-only transcript stays intact above it for transcript, rewind,
 * and audit. See `AUTO_COMPACTION_IMPLEMENTATION_PLAN.md` §3 (Frozen contract).
 */
export type CompactCheckpointTrigger = "manual" | "auto";
export type CompactCheckpointPhase = "pre-turn" | "mid-turn" | "manual";
export type CompactCheckpointReason = "requested" | "soft-threshold" | "hard-ceiling" | "model-switch";

export type PortableCompactCheckpointV1 = {
  version: 1;
  strategy: "portable-summary";
  trigger: CompactCheckpointTrigger;
  phase: CompactCheckpointPhase;
  reason: CompactCheckpointReason;
  sourceHeadUuid: string;
  createdWith: {
    providerId: string;
    model: string;
    engine: string;
  };
  replacementMessages: ResumedMessage[];
  summary: {
    text: string;
    evictedLogicalTurnIds: string[];
    evictedProviderRoundIds: string[];
  };
  retained: {
    logicalTurnIds: string[];
    providerRoundIds: string[];
  };
  accounting: {
    contextWindow?: number;
    softTriggerTokens?: number;
    hardInputCeilingTokens?: number;
    beforeTokens?: number;
    beforeSource: "provider" | "estimated" | "unknown";
    projectedAfterTokens?: number;
  };
  nativeProjection?: {
    sourceHeadUuid: string;
    state: ProviderStateEnvelope;
  };
};

export const COMPACT_CHECKPOINT_KIND = "compact-checkpoint-v1";

const KNOWN_VERSIONS = new Set<number>([1]);
const TRIGGERS = new Set<CompactCheckpointTrigger>(["manual", "auto"]);
const PHASES = new Set<CompactCheckpointPhase>(["pre-turn", "mid-turn", "manual"]);
const REASONS = new Set<CompactCheckpointReason>(["requested", "soft-threshold", "hard-ceiling", "model-switch"]);
const BEFORE_SOURCES = new Set(["provider", "estimated", "unknown"]);
const MESSAGE_ROLES = new Set(["user", "assistant", "tool"]);
const MESSAGE_KEYS = new Set([
  "recordUuid",
  "role",
  "content",
  "reasoningContent",
  "thinkingBlocks",
  "toolCallId",
  "toolCalls",
  "providerState",
  "toolOk",
  "toolFileEvent",
  "toolWebEvent",
  "toolMcpEvent",
  "toolProcessEvent",
  "toolSkillEvent",
  "engine",
  "model",
  "usage",
  "kind",
  "images",
]);
const MESSAGE_KEYS_BY_ROLE: Record<ResumedMessage["role"], Set<string>> = {
  user: new Set(["recordUuid", "role", "content", "usage", "kind", "images"]),
  assistant: new Set([
    "recordUuid",
    "role",
    "content",
    "reasoningContent",
    "thinkingBlocks",
    "toolCalls",
    "providerState",
    "engine",
    "model",
    "usage",
    "kind",
  ]),
  tool: new Set([
    "recordUuid",
    "role",
    "content",
    "toolCallId",
    "toolOk",
    "toolFileEvent",
    "toolWebEvent",
    "toolMcpEvent",
    "toolProcessEvent",
    "toolSkillEvent",
    "usage",
    "kind",
    "images",
  ]),
};
const USAGE_KEYS = new Set([
  "contextInputTokens",
  "inputTokens",
  "outputTokens",
  "totalTokens",
  "cacheReadInputTokens",
  "cacheWriteInputTokens",
  "cacheHitInputTokens",
  "cacheMissInputTokens",
  "reasoningTokens",
  "effectiveTokens",
  "providerDetails",
]);

export function isCompactCheckpointRecord(record: { metadata?: Record<string, unknown> | undefined }): boolean {
  return record.metadata?.kind === COMPACT_CHECKPOINT_KIND;
}

/**
 * Validate and parse a persisted checkpoint payload. An unknown future version
 * fails with an actionable session error rather than being silently ignored,
 * and a malformed v1 payload never partially projects. Callers must surface the
 * error instead of falling back to raw history.
 */
export function parseCompactCheckpoint(payload: unknown): PortableCompactCheckpointV1 {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("Session compact checkpoint is malformed: expected an object.");
  }
  const source = payload as Record<string, unknown>;
  const version = source.version;
  if (typeof version !== "number" || !KNOWN_VERSIONS.has(version)) {
    throw new Error(
      `Session compact checkpoint version ${typeof version === "number" ? version : "unknown"} is not supported by this version of Vesicle. Update Vesicle or resume from a session before the checkpoint.`,
    );
  }
  requireString(source, "strategy", "portable-summary");
  requireEnum(source, "trigger", TRIGGERS, "checkpoint trigger");
  requireEnum(source, "phase", PHASES, "checkpoint phase");
  requireEnum(source, "reason", REASONS, "checkpoint reason");
  requireString(source, "sourceHeadUuid");

  const createdWith = requireObject(source, "createdWith");
  requireString(createdWith, "providerId");
  requireString(createdWith, "model");
  requireString(createdWith, "engine");

  const replacementMessages = requireArray(source, "replacementMessages");
  const validatedMessages = replacementMessages.map(parseReplacementMessage);

  const summary = requireObject(source, "summary");
  requireString(summary, "text");
  const evictedLogicalTurnIds = requireStringArray(summary, "evictedLogicalTurnIds");
  const evictedProviderRoundIds = requireStringArray(summary, "evictedProviderRoundIds");
  const summaryMessages = validatedMessages.filter((message) => message.kind === "compact-summary");
  if (
    summaryMessages.length !== 1
    || validatedMessages[0] !== summaryMessages[0]
    || summaryMessages[0]!.role !== "user"
    || summaryMessages[0]!.content !== `[conversation summary]\n${summary.text}`
  ) {
    throw new Error("Session compact checkpoint replacement summary is malformed.");
  }

  const retained = requireObject(source, "retained");
  const retainedLogicalTurnIds = requireStringArray(retained, "logicalTurnIds");
  const retainedProviderRoundIds = requireStringArray(retained, "providerRoundIds");

  const accounting = requireObject(source, "accounting");
  const contextWindow = optionalPositiveInteger(accounting, "contextWindow");
  const softTriggerTokens = optionalPositiveInteger(accounting, "softTriggerTokens");
  const hardInputCeilingTokens = optionalPositiveInteger(accounting, "hardInputCeilingTokens");
  const beforeTokens = optionalPositiveInteger(accounting, "beforeTokens");
  requireEnum(accounting, "beforeSource", BEFORE_SOURCES, "checkpoint beforeSource");
  const projectedAfterTokens = optionalPositiveInteger(accounting, "projectedAfterTokens");

  let nativeProjection: PortableCompactCheckpointV1["nativeProjection"];
  if (Object.hasOwn(source, "nativeProjection")) {
    const value = source.nativeProjection;
    const native = value && typeof value === "object" && !Array.isArray(value)
      ? value as Record<string, unknown>
      : undefined;
    if (typeof native?.sourceHeadUuid === "string" && native.sourceHeadUuid !== source.sourceHeadUuid) {
      throw new Error("Session compact checkpoint native projection source head does not match the portable projection.");
    }
    if (native && native.sourceHeadUuid === source.sourceHeadUuid) {
      try {
        nativeProjection = {
          sourceHeadUuid: native.sourceHeadUuid as string,
          state: parseProviderStateEnvelope(native.state, "Session compact checkpoint native projection state"),
        };
      } catch {
        // Provider-native state is optional. Corruption drops only this
        // projection; the validated portable replacement remains readable.
      }
    }
  }

  return {
    version: 1,
    strategy: "portable-summary",
    trigger: source.trigger as CompactCheckpointTrigger,
    phase: source.phase as CompactCheckpointPhase,
    reason: source.reason as CompactCheckpointReason,
    sourceHeadUuid: source.sourceHeadUuid as string,
    createdWith: {
      providerId: createdWith.providerId as string,
      model: createdWith.model as string,
      engine: createdWith.engine as string,
    },
    replacementMessages: validatedMessages,
    summary: {
      text: summary.text as string,
      evictedLogicalTurnIds,
      evictedProviderRoundIds,
    },
    retained: {
      logicalTurnIds: retainedLogicalTurnIds,
      providerRoundIds: retainedProviderRoundIds,
    },
    accounting: {
      ...(contextWindow !== undefined ? { contextWindow } : {}),
      ...(softTriggerTokens !== undefined ? { softTriggerTokens } : {}),
      ...(hardInputCeilingTokens !== undefined ? { hardInputCeilingTokens } : {}),
      ...(beforeTokens !== undefined ? { beforeTokens } : {}),
      beforeSource: accounting.beforeSource as "provider" | "estimated" | "unknown",
      ...(projectedAfterTokens !== undefined ? { projectedAfterTokens } : {}),
    },
    ...(nativeProjection ? { nativeProjection } : {}),
  };
}

function parseReplacementMessage(entry: unknown, index: number): ResumedMessage {
  const label = `replacementMessages[${index}]`;
  if (!isPlainObject(entry)) throw new Error(`Session compact checkpoint ${label} is malformed.`);
  rejectUnknownKeys(entry, MESSAGE_KEYS, label);
  const role = entry.role;
  if (typeof role !== "string" || !MESSAGE_ROLES.has(role)) {
    throw new Error(`Session compact checkpoint ${label}.role is malformed.`);
  }
  rejectUnknownKeys(entry, MESSAGE_KEYS_BY_ROLE[role as ResumedMessage["role"]], label);
  if (typeof entry.content !== "string") {
    throw new Error(`Session compact checkpoint ${label}.content is malformed.`);
  }
  if (role === "tool" && (typeof entry.toolCallId !== "string" || entry.toolCallId.length === 0)) {
    throw new Error(`Session compact checkpoint ${label}.toolCallId is malformed.`);
  }

  const message: ResumedMessage = { role: role as ResumedMessage["role"], content: entry.content };
  copyOptionalString(entry, message as unknown as Record<string, unknown>, "recordUuid", label);
  copyOptionalString(entry, message as unknown as Record<string, unknown>, "reasoningContent", label);
  copyOptionalString(entry, message as unknown as Record<string, unknown>, "toolCallId", label);
  copyOptionalString(entry, message as unknown as Record<string, unknown>, "engine", label);
  copyOptionalString(entry, message as unknown as Record<string, unknown>, "model", label);
  copyOptionalString(entry, message as unknown as Record<string, unknown>, "kind", label);
  copyOptionalBoolean(entry, message as unknown as Record<string, unknown>, "toolOk", label);

  if (Object.hasOwn(entry, "toolCalls")) message.toolCalls = parseToolCalls(entry.toolCalls, label);
  if (Object.hasOwn(entry, "providerState")) {
    message.providerState = parseProviderStateEnvelope(entry.providerState, `Session compact checkpoint ${label}.providerState`);
  }
  if (Object.hasOwn(entry, "thinkingBlocks")) message.thinkingBlocks = parseThinkingBlocks(entry.thinkingBlocks, label);
  if (Object.hasOwn(entry, "images")) message.images = parseImages(entry.images, label);
  if (Object.hasOwn(entry, "usage")) message.usage = parseUsage(entry.usage, label);
  for (const key of ["toolFileEvent", "toolWebEvent", "toolMcpEvent", "toolProcessEvent", "toolSkillEvent"] as const) {
    if (!Object.hasOwn(entry, key)) continue;
    requireJsonObject(entry[key], `${label}.${key}`);
    (message as unknown as Record<string, unknown>)[key] = entry[key];
  }
  return message;
}

function parseToolCalls(value: unknown, label: string): NonNullable<ResumedMessage["toolCalls"]> {
  if (!Array.isArray(value)) throw new Error(`Session compact checkpoint ${label}.toolCalls is malformed.`);
  return value.map((entry, index) => {
    if (!isPlainObject(entry)) throw new Error(`Session compact checkpoint ${label}.toolCalls[${index}] is malformed.`);
    rejectUnknownKeys(entry, new Set(["id", "name", "arguments"]), `${label}.toolCalls[${index}]`);
    for (const key of ["id", "name", "arguments"] as const) {
      if (typeof entry[key] !== "string" || (key !== "arguments" && entry[key].length === 0)) {
        throw new Error(`Session compact checkpoint ${label}.toolCalls[${index}].${key} is malformed.`);
      }
    }
    return { id: entry.id as string, name: entry.name as string, arguments: entry.arguments as string };
  });
}

function parseThinkingBlocks(value: unknown, label: string): NonNullable<ResumedMessage["thinkingBlocks"]> {
  if (!Array.isArray(value)) throw new Error(`Session compact checkpoint ${label}.thinkingBlocks is malformed.`);
  return value.map((entry, index) => {
    if (!isPlainObject(entry) || typeof entry.type !== "string") {
      throw new Error(`Session compact checkpoint ${label}.thinkingBlocks[${index}] is malformed.`);
    }
    const valid = entry.type === "reasoning"
      ? typeof entry.reasoningContent === "string"
      : entry.type === "thinking"
        ? typeof entry.thinking === "string"
        : entry.type === "redacted_thinking"
          ? typeof entry.data === "string"
          : entry.type === "thought_summary" && (typeof entry.text === "string" || typeof entry.summary === "string");
    if (!valid || !isJsonValue(entry)) {
      throw new Error(`Session compact checkpoint ${label}.thinkingBlocks[${index}] is malformed.`);
    }
    return { ...entry } as NonNullable<ResumedMessage["thinkingBlocks"]>[number];
  });
}

function parseImages(value: unknown, label: string): NonNullable<ResumedMessage["images"]> {
  if (!Array.isArray(value)) throw new Error(`Session compact checkpoint ${label}.images is malformed.`);
  return value.map((entry, index) => {
    const imageLabel = `${label}.images[${index}]`;
    if (!isPlainObject(entry)) throw new Error(`Session compact checkpoint ${imageLabel} is malformed.`);
    rejectUnknownKeys(entry, new Set(["id", "path", "mediaType", "bytes", "sha256", "filename", "source", "sourcePath", "detail"]), imageLabel);
    if (
      typeof entry.id !== "string"
      || typeof entry.path !== "string"
      || !entry.path.startsWith(".vesicle/attachments/")
      || entry.path.length === ".vesicle/attachments/".length
      || entry.path.slice(".vesicle/attachments/".length) === ".."
      || entry.path.slice(".vesicle/attachments/".length).includes("/")
      || entry.path.includes("\\")
      || !["image/png", "image/jpeg", "image/gif", "image/webp"].includes(String(entry.mediaType))
      || typeof entry.bytes !== "number"
      || !Number.isInteger(entry.bytes)
      || entry.bytes < 0
      || typeof entry.sha256 !== "string"
      || !/^[a-f0-9]{64}$/.test(entry.sha256)
      || (entry.source !== "clipboard" && entry.source !== "project" && entry.source !== "mcp")
    ) throw new Error(`Session compact checkpoint ${imageLabel} is malformed.`);
    for (const key of ["filename", "sourcePath"] as const) {
      if (Object.hasOwn(entry, key) && typeof entry[key] !== "string") throw new Error(`Session compact checkpoint ${imageLabel}.${key} is malformed.`);
    }
    if (Object.hasOwn(entry, "detail") && !["auto", "high", "original"].includes(String(entry.detail))) {
      throw new Error(`Session compact checkpoint ${imageLabel}.detail is malformed.`);
    }
    return entry as NonNullable<ResumedMessage["images"]>[number];
  });
}

function parseUsage(value: unknown, label: string): NonNullable<ResumedMessage["usage"]> {
  if (!isPlainObject(value)) throw new Error(`Session compact checkpoint ${label}.usage is malformed.`);
  rejectUnknownKeys(value, USAGE_KEYS, `${label}.usage`);
  for (const [key, entry] of Object.entries(value)) {
    if (key === "providerDetails") {
      requireJsonObject(entry, `${label}.usage.providerDetails`);
    } else if (typeof entry !== "number" || !Number.isFinite(entry) || entry < 0) {
      throw new Error(`Session compact checkpoint ${label}.usage.${key} is malformed.`);
    }
  }
  return { ...value };
}

function copyOptionalString(source: Record<string, unknown>, target: Record<string, unknown>, key: string, label: string): void {
  if (!Object.hasOwn(source, key)) return;
  if (typeof source[key] !== "string") throw new Error(`Session compact checkpoint ${label}.${key} is malformed.`);
  target[key] = source[key];
}

function copyOptionalBoolean(source: Record<string, unknown>, target: Record<string, unknown>, key: string, label: string): void {
  if (!Object.hasOwn(source, key)) return;
  if (typeof source[key] !== "boolean") throw new Error(`Session compact checkpoint ${label}.${key} is malformed.`);
  target[key] = source[key];
}

function rejectUnknownKeys(record: Record<string, unknown>, allowed: Set<string>, label: string): void {
  const unknown = Object.keys(record).find((key) => !allowed.has(key));
  if (unknown) throw new Error(`Session compact checkpoint ${label}.${unknown} is not supported.`);
}

function requireJsonObject(value: unknown, label: string): asserts value is Record<string, unknown> {
  if (!isPlainObject(value) || !isJsonValue(value)) throw new Error(`Session compact checkpoint ${label} is malformed.`);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isJsonValue(value: unknown): boolean {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJsonValue);
  return isPlainObject(value) && Object.values(value).every(isJsonValue);
}

function requireString(record: Record<string, unknown>, key: string, expected?: string): void {
  const value = record[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Session compact checkpoint ${key} is malformed.`);
  }
  if (expected !== undefined && value !== expected) {
    throw new Error(`Session compact checkpoint ${key} "${value}" is not supported (expected ${expected}).`);
  }
}

function requireEnum(record: Record<string, unknown>, key: string, allowed: Set<string>, label: string): void {
  const value = record[key];
  if (typeof value !== "string" || !allowed.has(value)) {
    throw new Error(`Session compact checkpoint ${label} is malformed.`);
  }
}

function requireObject(record: Record<string, unknown>, key: string): Record<string, unknown> {
  const value = record[key];
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Session compact checkpoint ${key} is malformed.`);
  }
  return value as Record<string, unknown>;
}

function requireArray(record: Record<string, unknown>, key: string): unknown[] {
  const value = record[key];
  if (!Array.isArray(value)) {
    throw new Error(`Session compact checkpoint ${key} is malformed.`);
  }
  return value;
}

function requireStringArray(record: Record<string, unknown>, key: string): string[] {
  const value = requireArray(record, key);
  for (const entry of value) {
    if (typeof entry !== "string") throw new Error(`Session compact checkpoint ${key} contains a non-string entry.`);
  }
  return value as string[];
}

function optionalPositiveInteger(record: Record<string, unknown>, key: string): number | undefined {
  if (!Object.hasOwn(record, key)) return undefined;
  const value = record[key];
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || !Number.isInteger(value)) {
    throw new Error(`Session compact checkpoint ${key} is malformed.`);
  }
  return value;
}
