import type { SessionRecord } from "./record-model";

/**
 * Durable identity persisted on every record that belongs to a top-level Agent
 * Loop or a provider/tool round. One complete top-level, user-initiated Agent
 * Loop shares a `logicalTurnId`; one complete provider/tool round within it
 * shares a `providerRoundId`. See
 * `dev/docs/working/AUTO_COMPACTION_IMPLEMENTATION_PLAN.md` §2 (Frozen contract).
 *
 * `providerRoundId` is optional on the persisted shape only because the host
 * allocates the first round alongside the initiating input; in practice every
 * conversational record carries both ids.
 */
export type SessionExecutionIdentity = {
  logicalTurnId: string;
  providerRoundId?: string;
};

/**
 * The active round a recorder is appending into right now. Both ids are always
 * present while a turn is running: the logical turn id is stable for the whole
 * turn, and the provider round id advances once per prepared provider request.
 */
export type ExecutionRound = {
  logicalTurnId: string;
  providerRoundId: string;
};

export function newLogicalTurnId(): string {
  return `turn_${crypto.randomUUID()}`;
}

export function newProviderRoundId(): string {
  return `round_${crypto.randomUUID()}`;
}

export function readLogicalTurnId(record: SessionRecord): string | undefined {
  const value = record.metadata?.logicalTurnId;
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function readProviderRoundId(record: SessionRecord): string | undefined {
  const value = record.metadata?.providerRoundId;
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** Metadata fields to merge onto a record so it carries the active identity. */
export function executionIdentityMetadata(identity: ExecutionRound): { logicalTurnId: string; providerRoundId: string } {
  return { logicalTurnId: identity.logicalTurnId, providerRoundId: identity.providerRoundId };
}

// --- active-round runtime context ------------------------------------------
//
// The active round is process-local and keyed by session id, mirroring the
// frozen Persistent-Instruction snapshot in `core/instructions`. The Agent
// Loop binds it before appending; recorders read it so identity threads through
// every assistant/tool/interaction record without each call site repeating it.
// A continuation re-binds the recovered round before appending its resolution,
// so resuming a pause never creates a new logical turn.

const activeRounds = new Map<string, ExecutionRound>();

export function bindExecutionRound(sessionId: string, identity: ExecutionRound): void {
  activeRounds.set(sessionId, identity);
}

export function readExecutionRound(sessionId: string): ExecutionRound | undefined {
  return activeRounds.get(sessionId);
}

export function clearExecutionRound(sessionId: string): void {
  activeRounds.delete(sessionId);
}

/**
 * Merge the active round's identity into a record's metadata. Returns the
 * metadata unchanged when no round is bound (legacy records, test fixtures, or
 * appends outside a running turn), so existing behavior is preserved.
 */
export function withExecutionRound(sessionId: string, metadata: Record<string, unknown> | undefined): Record<string, unknown> {
  const round = activeRounds.get(sessionId);
  if (!round) return metadata ?? {};
  return { ...(metadata ?? {}), ...executionIdentityMetadata(round) };
}

/**
 * Recover the active logical turn + provider round for a resumed pause. The
 * logical turn is the newest persisted `logicalTurnId`; the provider round is
 * the round of the most recent record that carries one — the round that
 * produced the paused interaction. Returns undefined when no identity has been
 * persisted yet (a legacy session), so the continuation falls back to the old
 * append behavior instead of guessing.
 */
export function recoverActiveIdentity(records: SessionRecord[]): ExecutionRound | undefined {
  let logicalTurnId: string | undefined;
  let providerRoundId: string | undefined;
  for (const record of records) {
    const turn = readLogicalTurnId(record);
    if (turn) logicalTurnId = turn;
    const round = readProviderRoundId(record);
    if (round) providerRoundId = round;
  }
  if (!logicalTurnId || !providerRoundId) return undefined;
  return { logicalTurnId, providerRoundId };
}
