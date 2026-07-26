import type { ProviderSelection } from "../../config/providers";
import {
  parseCompactCheckpoint,
  projectSessionHistory,
  type PortableCompactCheckpointV1,
  type ResumedMessage,
  type SessionStore,
} from "../session/store";
import type { ReplacementSelection } from "./replacement-builder";

export type CompactCheckpointTrigger = "manual" | "auto";
export type CompactCheckpointPhase = "pre-turn" | "mid-turn" | "manual";
export type CompactCheckpointReason = "requested" | "soft-threshold" | "hard-ceiling" | "model-switch";

export type InstallCheckpointOptions = {
  rootDir: string;
  sessionId: string;
  session: SessionStore;
  selection: ReplacementSelection;
  summary: string;
  trigger: CompactCheckpointTrigger;
  phase: CompactCheckpointPhase;
  reason: CompactCheckpointReason;
  createdWith: { providerId: string; model: string; engine: string };
  providerSelection?: Partial<ProviderSelection>;
  accounting: {
    contextWindow?: number;
    beforeTokens?: number;
    beforeSource: "provider" | "estimated" | "unknown";
  };
};

export type InstalledCheckpoint = {
  checkpointUuid: string;
  sourceHeadUuid: string;
  replacementMessages: ResumedMessage[];
  accounting: InstallCheckpointOptions["accounting"];
};

/**
 * Build, validate, and atomically append the single compact-checkpoint record.
 * The summary must already be generated (the caller owns the provider request).
 * Validation runs before the append, so a malformed payload or append failure
 * leaves the former head active and usable — nothing is installed in memory.
 */
export async function installCompactCheckpoint(options: InstallCheckpointOptions): Promise<InstalledCheckpoint> {
  const sourceHeadUuid = options.session.headUuid() ?? options.selection.evictedRecords[0]?.parentUuid ?? "session-root";
  const retainedMessages = projectSessionHistory(options.selection.retainedRecords).messages;
  const summaryMessage: ResumedMessage = {
    role: "user",
    content: `[conversation summary]\n${options.summary}`,
    kind: "compact-summary",
  };
  const replacementMessages: ResumedMessage[] = [summaryMessage, ...retainedMessages];

  const payload: PortableCompactCheckpointV1 = {
    version: 1,
    strategy: "portable-summary",
    trigger: options.trigger,
    phase: options.phase,
    reason: options.reason,
    sourceHeadUuid,
    createdWith: options.createdWith,
    replacementMessages,
    summary: {
      text: options.summary,
      evictedLogicalTurnIds: options.selection.evictedLogicalTurnIds,
      evictedProviderRoundIds: options.selection.evictedProviderRoundIds,
    },
    retained: {
      logicalTurnIds: options.selection.retainedLogicalTurnIds,
      providerRoundIds: options.selection.retainedProviderRoundIds,
    },
    accounting: {
      ...(options.accounting.contextWindow !== undefined ? { contextWindow: options.accounting.contextWindow } : {}),
      ...(options.accounting.beforeTokens !== undefined ? { beforeTokens: options.accounting.beforeTokens } : {}),
      beforeSource: options.accounting.beforeSource,
    },
  };
  // Validate the exact payload before it is persisted. parseCompactCheckpoint
  // throws on an unknown version or a malformed v1, so a bad payload never
  // reaches the JSONL and never partially projects.
  parseCompactCheckpoint(payload);

  const record = await options.session.append({
    role: "system",
    content: "Conversation compacted into a portable checkpoint.",
    metadata: { kind: "compact-checkpoint-v1", checkpoint: payload },
  });
  return {
    checkpointUuid: record.uuid,
    sourceHeadUuid,
    replacementMessages,
    accounting: options.accounting,
  };
}
