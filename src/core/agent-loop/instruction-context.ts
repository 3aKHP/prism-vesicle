/**
 * In-process frozen instruction snapshot for the active turn of a session.
 *
 * Persistent Instructions are live user configuration, but within ONE top-level
 * turn the provider/tool loop must observe a single stable instruction set: a
 * tool call decided under one instruction set must not continue under another
 * after a mid-turn pause (permission/gate/question/quality). Otherwise a user
 * who edits an instruction file during the pause would see one turn start under
 * rule A and finish under rule B — a single-turn semantic break.
 *
 * `bootstrapTurn` therefore freezes the turn-start instruction blocks here, and
 * every in-process continuation reuses that frozen value instead of re-reading
 * disk. The cache is in-process only: a Vesicle restart loses it, so a resumed
 * continuation re-reads current disk — correct, because a restart is a resume
 * boundary, not mid-turn. A new top-level turn overwrites the entry, so edits
 * take effect on the next turn, never mid-turn.
 */
const frozenInstructionBlocks = new Map<string, string>();

export function freezeInstructionBlocks(sessionId: string, blocks: string): void {
  frozenInstructionBlocks.set(sessionId, blocks);
}

export function readFrozenInstructionBlocks(sessionId: string): string | undefined {
  return frozenInstructionBlocks.get(sessionId);
}

/** Drop the frozen snapshot once the turn has completed (success path). */
export function clearFrozenInstructionBlocks(sessionId: string): void {
  frozenInstructionBlocks.delete(sessionId);
}
