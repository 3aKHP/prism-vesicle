import type { ResumedMessage } from "../session/store";
import type { SessionRecord } from "../session/record-model";
import {
  COMPACT_CHECKPOINT_KIND,
  parseCompactCheckpoint,
  segmentSession,
  type SegmentedTurn,
} from "../session/store";

/**
 * Selects the durable replacement history for a portable compaction.
 *
 * The active frontier (the trailing in-progress Agent Loop) and every ambiguous
 * legacy suffix are pinned and retained verbatim. Among the complete logical
 * turns, the newest is retained and everything older is the contiguous evicted
 * prefix that the summary will cover. When the single newest complete turn is
 * itself oversized, selection falls back to its newest complete provider/tool
 * round so a tool call is never split from its result. This is the plan's
 * manual-compact sizing (issue #107 §4): token-precision post-compact sizing
 * arrives with the budget evaluator in PR 3.
 */
export type ReplacementSelection = {
  /** Active branch head against which this selection was built. */
  sourceHeadUuid: string;
  /** Records to summarize (the contiguous evicted prefix), oldest→newest. */
  evictedRecords: SessionRecord[];
  /** Records to retain verbatim after the summary, oldest→newest. */
  retainedRecords: SessionRecord[];
  evictedLogicalTurnIds: string[];
  evictedProviderRoundIds: string[];
  retainedLogicalTurnIds: string[];
  retainedProviderRoundIds: string[];
  /** Summary text carried by the latest prior checkpoint, to merge — not re-summarize. */
  previousSummary: string | undefined;
};

export type ReplacementOptions = {
  contextWindow?: number;
};

/**
 * Select the replacement history. Returns undefined when no complete unit can be
 * evicted without splitting an indivisible round — the caller reports that the
 * session cannot be compacted further instead of guessing.
 */
export function selectReplacement(records: SessionRecord[], _options: ReplacementOptions = {}): ReplacementSelection | undefined {
  const sourceHeadUuid = records.at(-1)?.uuid;
  if (!sourceHeadUuid) return undefined;
  const checkpoint = findLatestCheckpoint(records);
  const compactable = checkpoint
    ? [...checkpoint.retainedRecords, ...records.slice(checkpoint.index + 1)]
    : stripLeadingBootstrap(records);
  const segmentation = segmentSession(compactable);
  const frontier = segmentation.frontier;
  const completeTurns = segmentation.turns;
  if (completeTurns.length === 0) {
    // Only an active frontier remains — nothing complete to evict.
    return undefined;
  }

  // Newest complete turn is retained; older complete turns are evicted.
  const newestTurn = completeTurns[completeTurns.length - 1]!;
  const evictTurns = completeTurns.slice(0, -1);
  let retainTurns: SegmentedTurn[] = [newestTurn];
  let evictedFromOversized: SessionRecord[] = [];
  let retainedFromOversized: SessionRecord[] = [];

  if (evictTurns.length === 0) {
    // A single complete turn: fall back to its newest complete provider/tool
    // round so a large turn can still be reduced without splitting a round.
    const fallback = splitOversizedSingleTurn(newestTurn);
    if (!fallback) return undefined;
    retainTurns = [];
    retainedFromOversized = fallback.retained;
    evictedFromOversized = fallback.evicted;
  }

  const evictedRecords = [...evictTurns.flatMap((turn) => turn.records), ...evictedFromOversized];
  const retainedRecords = [...retainTurns.flatMap((turn) => turn.records), ...retainedFromOversized, ...(frontier ? frontier.records : [])];

  if (evictedRecords.length === 0) return undefined;

  return {
    sourceHeadUuid,
    evictedRecords,
    retainedRecords,
    evictedLogicalTurnIds: uniqueIds(evictedRecords, "logicalTurnId"),
    evictedProviderRoundIds: uniqueIds(evictedRecords, "providerRoundId"),
    retainedLogicalTurnIds: uniqueIds(retainedRecords, "logicalTurnId"),
    retainedProviderRoundIds: uniqueIds(retainedRecords, "providerRoundId"),
    previousSummary: checkpoint?.summary,
  };
}

function splitOversizedSingleTurn(turn: SegmentedTurn): { retained: SessionRecord[]; evicted: SessionRecord[] } | undefined {
  const completeRounds = turn.rounds.filter((round) => round.complete);
  if (completeRounds.length < 2) return undefined;
  // Retain the newest complete round plus every round after it (any trailing
  // incomplete round is the active frontier — its tool calls may still lack
  // results). Only complete rounds before the newest are evicted, so the summary
  // never sees a dangling tool call without its result.
  const retainedAnchor = completeRounds[completeRounds.length - 1]!;
  const retainedAnchorIndex = turn.rounds.lastIndexOf(retainedAnchor);
  const retained = turn.rounds.slice(retainedAnchorIndex).flatMap((round) => round.records);
  const evicted = turn.rounds.slice(0, retainedAnchorIndex).flatMap((round) => round.records);
  if (evicted.length === 0) return undefined;
  return { retained, evicted };
}

function findLatestCheckpoint(records: SessionRecord[]): {
  index: number;
  summary: string | undefined;
  retainedRecords: SessionRecord[];
} | undefined {
  for (let index = records.length - 1; index >= 0; index--) {
    const record = records[index]!;
    if (record.metadata?.kind !== COMPACT_CHECKPOINT_KIND) continue;
    const checkpoint = parseCompactCheckpoint(record.metadata.checkpoint);
    const summary = checkpoint.replacementMessages
      .find((message) => message.kind === "compact-summary")
      ?.content.replace(/^\[conversation summary\]\s*/i, "");
    const sourceRecordsByUuid = new Map(records.slice(0, index).map((entry) => [entry.uuid, entry]));
    const retainedRecords = checkpoint.replacementMessages
      .filter((message) => message.kind !== "compact-summary")
      .map((message, messageIndex) => replacementMessageRecord(record, message, messageIndex, sourceRecordsByUuid));
    return { index, summary, retainedRecords };
  }
  return undefined;
}

function replacementMessageRecord(
  checkpointRecord: SessionRecord,
  message: ResumedMessage,
  index: number,
  sourceRecordsByUuid: Map<string, SessionRecord>,
): SessionRecord {
  const sourceMetadata = message.recordUuid ? sourceRecordsByUuid.get(message.recordUuid)?.metadata : undefined;
  const metadata: Record<string, unknown> = {
    ...(message.kind ? { kind: message.kind } : {}),
    ...(message.usage ? { usage: message.usage } : {}),
    ...(message.images ? { images: message.images } : {}),
    ...(typeof sourceMetadata?.logicalTurnId === "string" ? { logicalTurnId: sourceMetadata.logicalTurnId } : {}),
    ...(typeof sourceMetadata?.providerRoundId === "string" ? { providerRoundId: sourceMetadata.providerRoundId } : {}),
  };
  if (message.role === "assistant") {
    Object.assign(metadata, {
      ...(message.engine ? { engine: message.engine } : {}),
      ...(message.model ? { model: message.model } : {}),
      ...(message.reasoningContent ? { reasoningContent: message.reasoningContent } : {}),
      ...(message.thinkingBlocks ? { thinkingBlocks: message.thinkingBlocks } : {}),
      ...(message.toolCalls ? { toolCalls: message.toolCalls } : {}),
    });
  } else if (message.role === "tool") {
    Object.assign(metadata, {
      ...(message.toolCallId ? { toolCallId: message.toolCallId } : {}),
      ...(typeof message.toolOk === "boolean" ? { ok: message.toolOk } : {}),
      ...(message.toolFileEvent ? { fileEvent: message.toolFileEvent } : {}),
      ...(message.toolWebEvent ? { webEvent: message.toolWebEvent } : {}),
      ...(message.toolMcpEvent ? { mcpEvent: message.toolMcpEvent } : {}),
      ...(message.toolProcessEvent ? { processEvent: message.toolProcessEvent } : {}),
      ...(message.toolSkillEvent ? { skillEvent: message.toolSkillEvent } : {}),
    });
  }
  return {
    uuid: message.recordUuid ?? `${checkpointRecord.uuid}:replacement:${index}`,
    parentUuid: index === 0 ? checkpointRecord.parentUuid : `${checkpointRecord.uuid}:replacement:${index - 1}`,
    ts: checkpointRecord.ts,
    sessionId: checkpointRecord.sessionId,
    role: message.role,
    content: message.content,
    ...(Object.keys(metadata).length > 0 ? { metadata } : {}),
  };
}

function stripLeadingBootstrap(records: SessionRecord[]): SessionRecord[] {
  let index = 0;
  while (index < records.length && records[index]!.role === "system") index += 1;
  return records.slice(index);
}

function uniqueIds(records: SessionRecord[], key: "logicalTurnId" | "providerRoundId"): string[] {
  const ids = new Set<string>();
  for (const record of records) {
    const value = record.metadata?.[key];
    if (typeof value === "string" && value.length > 0) ids.add(value);
  }
  return [...ids];
}
