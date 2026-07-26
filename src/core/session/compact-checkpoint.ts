import type { ResumedMessage } from "./store";

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
};

export const COMPACT_CHECKPOINT_KIND = "compact-checkpoint-v1";

const KNOWN_VERSIONS = new Set<number>([1]);
const TRIGGERS = new Set<CompactCheckpointTrigger>(["manual", "auto"]);
const PHASES = new Set<CompactCheckpointPhase>(["pre-turn", "mid-turn", "manual"]);
const REASONS = new Set<CompactCheckpointReason>(["requested", "soft-threshold", "hard-ceiling", "model-switch"]);
const BEFORE_SOURCES = new Set(["provider", "estimated", "unknown"]);

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
  const validatedMessages: ResumedMessage[] = replacementMessages.map((entry, index) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error(`Session compact checkpoint replacementMessages[${index}] is malformed.`);
    }
    const message = entry as Record<string, unknown>;
    if (typeof message.role !== "string" || typeof message.content !== "string") {
      throw new Error(`Session compact checkpoint replacementMessages[${index}] is missing role/content.`);
    }
    return message as unknown as ResumedMessage;
  });

  const summary = requireObject(source, "summary");
  requireString(summary, "text");
  const evictedLogicalTurnIds = requireStringArray(summary, "evictedLogicalTurnIds");
  const evictedProviderRoundIds = requireStringArray(summary, "evictedProviderRoundIds");

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
  };
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
