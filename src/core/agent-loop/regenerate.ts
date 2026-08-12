// Horizontal candidate regeneration for #88.
//
// regenerateTurn re-runs a completed turn as a NEW candidate: it forks a sibling
// subtree off the shared user record, mints a fresh logicalTurnId (via
// bootstrap), and persists a selection marker so the new candidate becomes the
// active branch. It is a thin wrapper over runPrompt — the fork plumbing
// (sessionParentUuid), the fresh-context snapshot scoping (branchHeadUuid,
// Phase 0), and the shared user record reuse (prePersistedInputUuid, Model B)
// are the same primitives the rewind flow already exercises. Routing through
// bootstrap (not a hand-built RunLoopArgs) reuses harness-identity assertion,
// Skill hydration, and tool-surface resolution, and mints the fresh turn id
// unconditionally (the resolveGate/continuation path that REUSES the old id is
// the anti-pattern).
//
// MVP file policy: regenerate does NOT roll back the old candidate's on-disk
// artifacts. A regenerated tool-bearing turn executes against the previous
// candidate's files (documented as a user-manual caveat). Per-candidate file
// coexistence is a committed follow-up (post-state capture bundles).

import { toVesicleMessage } from "../compact/summary-generator";
import { appendCandidateSelection } from "../session/selection";
import { loadSessionRecords, loadSessionSnapshot } from "../session/store";
import { runPrompt } from "./run";
import type { RunPromptOptions, RunPromptResult } from "./types";

export class RegenerateBlockedError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "RegenerateBlockedError";
  }
}

export type RegenerateTurnOptions =
  & Omit<
    RunPromptOptions,
    | "input"
    | "messages"
    | "sessionParentUuid"
    | "branchHeadUuid"
    | "prePersistedInputUuid"
    | "rootDir"
    | "sessionId"
  >
  & { rootDir: string; sessionId: string; userRecordUuid: string };

/**
 * Re-run the turn rooted at `userRecordUuid` as a new candidate. The old
 * candidate's records remain in the append-only transcript; a fresh sibling
 * subtree is forked off the shared user record with a new logical turn id, and a
 * selection marker makes it the active branch. Throws {@link RegenerateBlockedError}
 * when the target record is not on the current branch or is not a user prompt.
 */
export async function regenerateTurn(options: RegenerateTurnOptions): Promise<RunPromptResult> {
  const { rootDir, sessionId, userRecordUuid, ...runOptions } = options;

  // Defense-in-depth: the target must be a user prompt on the current active
  // branch. The TUI only offers active-branch user records for regenerate (via
  // listRewindPoints), so this guards against an abandoned sibling branch.
  const defaultSnapshot = await loadSessionSnapshot(rootDir, sessionId);
  if (!defaultSnapshot.records.some((record) => record.uuid === userRecordUuid)) {
    throw new RegenerateBlockedError("The target turn is not on the current branch.");
  }

  // Fresh-context load: the snapshot ending at the user record excludes the old
  // candidate's subtree (those records descend from a different child of it).
  // Any compact checkpoint before this record is part of the branch and its
  // replacement messages carry through, so a compacted turn remains regenerable
  // against its summarized context.
  const snapshot = await loadSessionSnapshot(rootDir, sessionId, {
    headUuid: userRecordUuid,
    synthesizeDanglingToolResults: false,
  });
  const userRecord = snapshot.records.find((record) => record.uuid === userRecordUuid);
  if (!userRecord || userRecord.role !== "user") {
    throw new RegenerateBlockedError("The target record is not a regenerable user prompt.");
  }

  // Fork a sibling candidate subtree off the shared user record. sessionParentUuid
  // forks the append chain; branchHeadUuid scopes bootstrap's snapshot to the
  // fresh-context branch (and skips pre-turn compaction); prePersistedInputUuid
  // reuses the user record without re-appending. Background-delegation safety
  // (a turn is not done until its background SubAgents finish) is guarded by the
  // TUI caller, which owns the AgentManager.
  const result = await runPrompt({
    ...runOptions,
    rootDir,
    sessionId,
    input: userRecord.content,
    sessionParentUuid: userRecordUuid,
    branchHeadUuid: userRecordUuid,
    prePersistedInputUuid: userRecordUuid,
    messages: snapshot.messages.map(toVesicleMessage),
  });

  // Persist a selection marker so findLatestSelection reports the new candidate
  // as active. The new candidate is already the physical tail (the default
  // branch already walks to it), but the marker keeps the active-candidate
  // oracle consistent for the inline switcher.
  const records = await loadSessionRecords(rootDir, sessionId);
  const newLeaf = records.at(-1)?.uuid;
  if (newLeaf) {
    await appendCandidateSelection(rootDir, sessionId, {
      forkPointUuid: userRecordUuid,
      selectedLeafUuid: newLeaf,
    });
  }
  return result;
}
