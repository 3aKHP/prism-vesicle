// Horizontal candidate regeneration for #88.
//
// regenerateTurn re-runs a completed turn as a NEW candidate: it forks a sibling
// subtree off the shared user record, retains that record's logicalTurnId, and
// persists a selection marker so the new candidate becomes the active branch.
// It is a thin wrapper over runPrompt — the fork plumbing
// (sessionParentUuid), the fresh-context snapshot scoping (branchHeadUuid,
// Phase 0), and the shared user record reuse (prePersistedInputUuid, Model B)
// are the same primitives the rewind flow already exercises. Routing through
// bootstrap (not a hand-built RunLoopArgs) reuses harness-identity assertion,
// Skill hydration, and tool-surface resolution. Its provider round is fresh,
// while its shared logical turn prevents compaction from splitting the prompt
// from the selected candidate.
//
// File policy (#88 Phase 2, full-manifest per-candidate coexistence): before
// the new candidate runs, the old candidate's post-state is captured as a FULL
// disk manifest into a branch candidate-file-state bundle (if not captured
// already) and the disk is restored to the fork baseline — the first-wins
// ledger merge of every candidate's pre-turn state — so the new candidate runs
// against the files the fork turn actually started from. On runPrompt failure
// or interruption the old candidate regains both the selection marker and
// (best-effort) its manifest. Scratch tmp/ stays outside manifests, and
// symlinks/host-process writes carry the exemptions and taint warnings defined
// by the candidate-files module, as with /rewind.

import { compensateFailedRegenerateFileState, ensureCandidatePostState, restoreForkBaseline } from "../checkpoints/candidate-files";
import { toVesicleMessage } from "../compact/summary-generator";
import { appendCandidateSelection, contentLeafAtOrAbove, enumerateCandidateLeaves, findLatestSelection, isCandidateSelectionRecord } from "../session/selection";
import { readLogicalTurnId } from "../session/execution-identity";
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
    | "prePersistedInputLogicalTurnId"
    | "rootDir"
    | "sessionId"
  >
  & { rootDir: string; sessionId: string; userRecordUuid: string };

/**
 * Re-run the turn rooted at `userRecordUuid` as a new candidate. The old
 * candidate's records remain in the append-only transcript; a fresh sibling
 * subtree is forked off the shared user record in that record's logical turn, and a
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
  if (defaultSnapshot.pendingGate || defaultSnapshot.pendingEngineSwitch || defaultSnapshot.pendingUserQuestion
    || defaultSnapshot.pendingPermission || defaultSnapshot.pendingQualityDecision || defaultSnapshot.pendingQualityRewrite) {
    throw new RegenerateBlockedError("Resolve the pending interaction before regenerating.");
  }

  // Capture the pre-regenerate physical tail. bootstrap appends the new
  // candidate's file-history snapshot BEFORE the first provider round, so a
  // failed or interrupted runPrompt would leave the default head on the
  // incomplete candidate with no marker to switch back. On failure we append a
  // marker chained off the previous leaf so the old candidate stays active.
  const existingRecords = await loadSessionRecords(rootDir, sessionId);
  const physicalTail = existingRecords.at(-1);
  const latestSelection = findLatestSelection(existingRecords);
  const activeRecordUuids = new Set(defaultSnapshot.records.map((record) => record.uuid));
  const selectedContentLeaf = latestSelection
    ? enumerateCandidateLeaves(existingRecords, latestSelection.forkPointUuid)
      .find((record) => activeRecordUuids.has(record.uuid))
    : undefined;
  const previousLeaf = selectedContentLeaf?.uuid
    ?? (physicalTail && isCandidateSelectionRecord(physicalTail)
      ? String(physicalTail.metadata?.selectedLeafUuid ?? physicalTail.uuid)
      : physicalTail?.uuid);
  // Host records (validation, provider switches) may follow the old candidate's
  // content leaf; file bundles key on the content leaf so candidate switching —
  // which enumerates content leaves — always finds them.
  const bundleLeaf = contentLeafAtOrAbove(existingRecords, previousLeaf) ?? previousLeaf;

  // Per-candidate file coexistence: preserve the old candidate's post-state
  // (disk equals it by invariant) before restoring the fork baseline, so the
  // new candidate starts from the files the fork turn actually saw. A
  // candidate that produces no bundle — no checkpoint ledger, degraded by a
  // conversation-only switch, or checkpointing disabled — stays truly
  // conversation-only: the baseline restore is skipped so a failed regenerate
  // cannot strand its files away from the disk state it started with.
  if (bundleLeaf) {
    const preserved = await ensureCandidatePostState(rootDir, sessionId, { forkPointUuid: userRecordUuid, leafUuid: bundleLeaf });
    if (preserved) {
      await restoreForkBaseline(rootDir, sessionId, userRecordUuid);
    }
  }

  let result: RunPromptResult;
  try {
    result = await runPrompt({
      ...runOptions,
      rootDir,
      sessionId,
      input: userRecord.content,
      sessionParentUuid: userRecordUuid,
      branchHeadUuid: userRecordUuid,
      prePersistedInputUuid: userRecordUuid,
      ...(readLogicalTurnId(userRecord) ? { prePersistedInputLogicalTurnId: readLogicalTurnId(userRecord) } : {}),
      messages: snapshot.messages.map(toVesicleMessage),
    });
  } catch (error) {
    // Best-effort file compensation, owned by the candidate-files module: the
    // failed candidate keeps whatever it left on disk as its bundle, and the
    // old candidate regains its bundled post-state when one exists.
    // Compensation failures are swallowed so the original error surfaces.
    try {
      if (bundleLeaf) {
        await compensateFailedRegenerateFileState(rootDir, sessionId, userRecordUuid, bundleLeaf, existingRecords);
      }
    } catch {
      // Best-effort: keep the conversation compensation below authoritative.
    }
    if (previousLeaf) {
      await appendCandidateSelection(rootDir, sessionId, {
        forkPointUuid: userRecordUuid,
        selectedLeafUuid: previousLeaf,
      });
    }
    throw error;
  }

  // Persist a selection marker so findLatestSelection reports the new candidate
  // as active. The new candidate is already the physical tail (the default
  // branch already walks to it), but the marker keeps the active-candidate
  // oracle consistent for the inline switcher.
  const records = await loadSessionRecords(rootDir, sessionId);
  // Validation and other host records may follow the final assistant. Prefer
  // the durable assistant identity returned by finalizeTurn; enumerate the
  // candidate content leaf only as a compatibility fallback for tool-bearing
  // or legacy completion paths that do not expose it.
  const newLeaf = (result.kind === "complete" ? result.assistantRecordUuid : undefined)
    ?? enumerateCandidateLeaves(records, userRecordUuid).at(-1)?.uuid;
  if (newLeaf) {
    await appendCandidateSelection(rootDir, sessionId, {
      forkPointUuid: userRecordUuid,
      selectedLeafUuid: newLeaf,
    });
  }
  return result;
}
