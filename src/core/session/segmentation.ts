import { ENGINE_HANDOFF_KIND } from "../engine/transition";
import type { SessionRecord } from "./record-model";
import { readLogicalTurnId, readProviderRoundId } from "./execution-identity";

/**
 * Conservative session segmentation: the pure service that groups an active
 * branch into indivisible logical turns and provider/tool rounds. It is the
 * foundation for the portable replacement builder and never mutates records.
 *
 * Explicit identity metadata (`logicalTurnId` / `providerRoundId`) is the
 * primary oracle. Legacy records without identity are grouped conservatively:
 * a new turn is recognized only when an authored user prompt follows a completed
 * prior assistant boundary, tool results are reconstructed from tool-call ids,
 * and any ambiguous adjacent run is grown into one larger indivisible unit
 * rather than risk splitting a tool call from its result.
 */

export type SegmentedRound = {
  providerRoundId?: string;
  records: SessionRecord[];
  /** True when the round has an assistant reply and every declared tool call has a result. */
  complete: boolean;
};

export type SegmentedTurn = {
  logicalTurnId?: string;
  records: SessionRecord[];
  rounds: SegmentedRound[];
  /** True when the turn ended at a complete assistant boundary (no pending interaction). */
  complete: boolean;
  /** True when this turn's grouping was inferred without explicit identity metadata. */
  inferred: boolean;
};

export type SessionSegmentation = {
  /** Bootstrap root records (composed prompt + session metadata) — not part of any turn. */
  bootstrap: SessionRecord[];
  /** Ordered complete turns, oldest first. */
  turns: SegmentedTurn[];
  /** Trailing in-progress turn with no complete boundary; always retained verbatim. */
  frontier?: SegmentedTurn;
  /** True when any turn was inferred without explicit identity metadata. */
  inferred: boolean;
};

const HOST_INJECTED_USER_KINDS = new Set([
  "gate-resolution",
  "user-question-answer",
  "compact-summary",
  "background-process-results",
  "subagent-results",
  "quality-rewrite-feedback",
  ENGINE_HANDOFF_KIND,
  "queued-user-message",
]);

export function segmentSession(records: SessionRecord[]): SessionSegmentation {
  const bootstrapEnd = leadingBootstrapLength(records);
  const bootstrap = records.slice(0, bootstrapEnd);
  const body = records.slice(bootstrapEnd);

  const turns: SegmentedTurn[] = [];
  let frontier: SegmentedTurn | undefined;
  let inferredAny = false;

  let current: SegmentedTurn | undefined;
  for (const record of body) {
    const logicalTurnId = readLogicalTurnId(record);
    const startsNewTurn = current === undefined || isNewTurnBoundary(current, record, logicalTurnId);
    if (startsNewTurn) {
      if (current) {
        finalizeTurn(current);
        turns.push(current);
      }
      const inferred = logicalTurnId === undefined;
      if (inferred) inferredAny = true;
      current = { ...(logicalTurnId ? { logicalTurnId } : {}), records: [], rounds: [], complete: false, inferred };
    }
    // After the boundary check `current` is always defined: the first record
    // opens a turn, and every later record either continues it or opens a new one.
    appendToTurn(current!, record);
  }
  if (current) {
    finalizeTurn(current);
    // Only the trailing turn can be the active frontier; every earlier turn
    // closed before the next one opened and is retained in `turns` regardless.
    if (current.complete) turns.push(current);
    else frontier = current;
  }

  return { bootstrap, turns, ...(frontier ? { frontier } : {}), inferred: inferredAny };
}

function leadingBootstrapLength(records: SessionRecord[]): number {
  let index = 0;
  while (index < records.length && records[index]!.role === "system" && !isTurnRelevantSystem(records[index]!)) {
    index += 1;
  }
  return index;
}

/**
 * The very first system record is the composed-prompt session root and is never
 * part of a logical turn. Later system records (validation output, a failed-turn
 * marker, a compact checkpoint, or a no-progress breaker) belong to the turn
 * they sit inside, so the bootstrap prefix stops at the first of them.
 */
function isTurnRelevantSystem(record: SessionRecord): boolean {
  const kind = record.metadata?.kind;
  return kind === "validation"
    || kind === "failed-turn"
    || kind === "compact-checkpoint-v1"
    || kind === "compact-boundary"
    || kind === "no-progress-breaker";
}

function isNewTurnBoundary(current: SegmentedTurn, record: SessionRecord, logicalTurnId: string | undefined): boolean {
  if (logicalTurnId && current.logicalTurnId && logicalTurnId !== current.logicalTurnId) return true;
  // An explicit identity always continues the turn it names, even for a
  // host-injected user record stamped with the same logical turn id.
  if (logicalTurnId && current.logicalTurnId === logicalTurnId) return false;
  // Legacy inference: a new turn starts only at an authored user prompt.
  return isAuthoredPrompt(record);
}

function isAuthoredPrompt(record: SessionRecord): boolean {
  if (record.role !== "user") return false;
  const kind = record.metadata?.kind;
  if (typeof kind === "string" && HOST_INJECTED_USER_KINDS.has(kind)) return false;
  return record.content.trim().length > 0;
}

function appendToTurn(turn: SegmentedTurn, record: SessionRecord): void {
  turn.records.push(record);
  const last = turn.rounds[turn.rounds.length - 1];
  const providerRoundId = readProviderRoundId(record);
  const lastHasAssistant = last?.records.some((entry) => entry.role === "assistant") ?? false;
  // A new provider/tool round starts when the explicit providerRoundId advances
  // (identity-stamped) or, for legacy records, when a second assistant reply
  // arrives. A user input or queued message that carries the next round id
  // opens that round, and the assistant that shares the id then joins it rather
  // than splitting it.
  const startNewRound = last === undefined
    || (providerRoundId !== undefined && last.providerRoundId !== undefined && providerRoundId !== last.providerRoundId)
    || (record.role === "assistant" && last.providerRoundId === undefined && lastHasAssistant);
  if (startNewRound) {
    turn.rounds.push({ ...(providerRoundId ? { providerRoundId } : {}), records: [record], complete: false });
    return;
  }
  last.records.push(record);
}

function finalizeTurn(turn: SegmentedTurn): void {
  for (const round of turn.rounds) {
    round.complete = isRoundComplete(round);
  }
  const lastRound = turn.rounds[turn.rounds.length - 1];
  turn.complete = lastRound !== undefined && lastRound.complete;
}

function isRoundComplete(round: SegmentedRound): boolean {
  const assistant = round.records.find((record) => record.role === "assistant");
  if (!assistant) return false;
  const toolCalls = (assistant.metadata?.toolCalls as Array<{ id?: unknown }> | undefined) ?? [];
  if (toolCalls.length === 0) return true;
  const declared = new Set(toolCalls.map((call) => (typeof call?.id === "string" ? call.id : "")).filter((id): id is string => id.length > 0));
  if (declared.size === 0) return true;
  const answered = new Set<string>();
  for (const record of round.records) {
    if (record.role !== "tool") continue;
    const id = record.metadata?.toolCallId;
    if (typeof id === "string") answered.add(id);
  }
  for (const id of declared) {
    if (!answered.has(id)) return false;
  }
  return true;
}
