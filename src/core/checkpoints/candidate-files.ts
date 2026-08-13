// Per-candidate file coexistence for #88 Phase 2.
//
// Regenerate and candidate switching move the conversation between sibling
// subtrees, but the filesystem is global: only one candidate's artifacts can
// be on disk at once. This module maintains the invariant that, while the fork
// point is still the session's last turn, the disk equals the active
// candidate's post-state:
//
// - Leaving a candidate (switch-away or regenerate-over) captures the current
//   disk — which by invariant IS that candidate's post-state — into an
//   append-only `candidate-file-state` bundle chained off the candidate's
//   content leaf (branch-private). A candidate that already has a bundle is
//   never re-captured, so a failed restore retried later cannot mistake a
//   half-restored disk for the candidate's true post-state.
// - Switching to a candidate applies pre(to) ∪ pre(from) ∪ bundle(to): the
//   target bundle carries the real post-state, pre(from) contributes deletion
//   entries for files the departing candidate created, and pre(to) fills paths
//   neither candidate touched.
// - Regenerate restores the fork baseline first — the first-wins merge of
//   every candidate's pre-turn state in creation order — so a new candidate
//   runs against the state the fork turn actually started from, even when
//   MVP-era candidates ran against each other's files.
//
// Bundles use a dedicated envelope kind: they never enter
// snapshotsFromRecords (immune to the 100-snapshot window), are ignored by
// provider projection (unknown system records), and are transparent to
// candidate enumeration (system records are never content leaves). Blind spots
// shared with /rewind — MCP tool writes, host processes (surfaced via the
// taint flag), scratch tmp/, and manual edits — are documented, not solved.

import { enumerateCandidateLeaves } from "../session/selection";
import { createSessionStore, loadSessionRecords, type SessionRecord } from "../session/store";
import {
  applyFileCheckpointEntries,
  capturePath,
  fileCheckpointingEnabled,
  fileCheckpointIsTainted,
  forkTurnPreState,
  type FileCheckpointEntry,
} from "./file-history";

export const CANDIDATE_FILE_STATE_KIND = "candidate-file-state";

export type CandidateFileStateEnvelope = {
  kind: typeof CANDIDATE_FILE_STATE_KIND;
  forkPointUuid: string;
  /** Content leaf of the candidate whose post-state this bundle carries. */
  leafUuid: string;
  files: Record<string, FileCheckpointEntry>;
  timestamp: string;
  /** The candidate's turn ran a host process; its post-state may be incomplete. */
  taintedByHostProcess?: true;
};

export type CandidateFileStateOutcome = {
  restored: boolean;
  changed: string[];
  tainted?: true;
  /** "disabled": checkpointing off. "missing": target candidate has no bundle. */
  reason?: "disabled" | "missing";
};

export function isCandidateFileStateRecord(record: SessionRecord): boolean {
  return record.metadata?.kind === CANDIDATE_FILE_STATE_KIND;
}

/** The latest bundle recorded for `leafUuid`, or undefined. */
export function findCandidatePostState(records: SessionRecord[], leafUuid: string): CandidateFileStateEnvelope | undefined {
  for (let index = records.length - 1; index >= 0; index -= 1) {
    const envelope = parseCandidateFileState(records[index]!.metadata);
    if (envelope && envelope.leafUuid === leafUuid) return envelope;
  }
  return undefined;
}

/**
 * Capture the departing candidate's post-state if it has no bundle yet.
 * Returns undefined when checkpointing is disabled or the candidate's branch
 * carries no checkpoint history (nothing to capture).
 */
export async function ensureCandidatePostState(
  rootDir: string,
  sessionId: string,
  selection: { forkPointUuid: string; leafUuid: string },
): Promise<CandidateFileStateEnvelope | undefined> {
  if (!fileCheckpointingEnabled()) return undefined;
  const existing = findCandidatePostState(await loadSessionRecords(rootDir, sessionId), selection.leafUuid);
  if (existing) return existing;

  const preState = await forkTurnPreState(rootDir, sessionId, selection.forkPointUuid, { headUuid: selection.leafUuid });
  if (!preState) return undefined;
  const files: Record<string, FileCheckpointEntry> = {};
  for (const path of Object.keys(preState)) {
    files[path] = await capturePath(rootDir, sessionId, path);
  }
  const tainted = await fileCheckpointIsTainted(rootDir, sessionId, selection.forkPointUuid, { headUuid: selection.leafUuid });
  const envelope: CandidateFileStateEnvelope = {
    kind: CANDIDATE_FILE_STATE_KIND,
    forkPointUuid: selection.forkPointUuid,
    leafUuid: selection.leafUuid,
    files,
    timestamp: new Date().toISOString(),
    ...(tainted ? { taintedByHostProcess: true as const } : {}),
  };
  // Chain the bundle off the candidate's content leaf so it is branch-private:
  // other candidates' branch projections never walk through it.
  const store = await createSessionStore(rootDir, sessionId, { parentUuid: selection.leafUuid });
  await store.append({ role: "system", content: "", metadata: envelope });
  return envelope;
}

/**
 * Move the filesystem from candidate `fromLeaf` to candidate `toLeaf`.
 * Captures the departing candidate's post-state first, then applies the target
 * state. When the target has no bundle (produced before this feature and never
 * departed since) the switch degrades to the MVP behavior: conversation only.
 */
export async function switchCandidateFileState(
  rootDir: string,
  sessionId: string,
  selection: { forkPointUuid: string; fromLeaf: string; toLeaf: string },
): Promise<CandidateFileStateOutcome> {
  if (!fileCheckpointingEnabled()) return { restored: false, changed: [], reason: "disabled" };
  await ensureCandidatePostState(rootDir, sessionId, { forkPointUuid: selection.forkPointUuid, leafUuid: selection.fromLeaf });
  const records = await loadSessionRecords(rootDir, sessionId);
  const bundle = findCandidatePostState(records, selection.toLeaf);
  if (!bundle) return { restored: false, changed: [], reason: "missing" };

  const preTo = await forkTurnPreState(rootDir, sessionId, selection.forkPointUuid, { headUuid: selection.toLeaf });
  const preFrom = await forkTurnPreState(rootDir, sessionId, selection.forkPointUuid, { headUuid: selection.fromLeaf });
  const state: Record<string, FileCheckpointEntry> = {
    ...(preTo ?? {}),
    ...(preFrom ?? {}),
    ...bundle.files,
  };
  const changed = await applyFileCheckpointEntries(rootDir, sessionId, state);
  return {
    restored: true,
    changed,
    ...(bundle.taintedByHostProcess ? { tainted: true as const } : {}),
  };
}

/**
 * Restore the fork baseline before regenerating: the first-wins merge of every
 * candidate's pre-turn state in creation order. First-wins matters for
 * MVP-era sessions where a later candidate ran against an earlier candidate's
 * files — the earliest candidate's pre-state carries the true baseline for
 * every path it tracked.
 */
export async function restoreForkBaseline(rootDir: string, sessionId: string, forkPointUuid: string): Promise<string[]> {
  if (!fileCheckpointingEnabled()) return [];
  const records = await loadSessionRecords(rootDir, sessionId);
  const baseline: Record<string, FileCheckpointEntry> = {};
  for (const leaf of enumerateCandidateLeaves(records, forkPointUuid)) {
    const preState = await forkTurnPreState(rootDir, sessionId, forkPointUuid, { headUuid: leaf.uuid });
    if (!preState) continue;
    for (const [path, entry] of Object.entries(preState)) {
      if (!Object.hasOwn(baseline, path)) baseline[path] = entry;
    }
  }
  if (Object.keys(baseline).length === 0) return [];
  return applyFileCheckpointEntries(rootDir, sessionId, baseline);
}

function parseCandidateFileState(metadata: Record<string, unknown> | undefined): CandidateFileStateEnvelope | undefined {
  if (metadata?.kind !== CANDIDATE_FILE_STATE_KIND) return undefined;
  if (typeof metadata.forkPointUuid !== "string" || typeof metadata.leafUuid !== "string") return undefined;
  if (!metadata.files || typeof metadata.files !== "object") return undefined;
  const files: Record<string, FileCheckpointEntry> = {};
  for (const [path, value] of Object.entries(metadata.files as Record<string, unknown>)) {
    if (!value || typeof value !== "object") return undefined;
    const backup = (value as FileCheckpointEntry).backup;
    if (backup !== null && typeof backup !== "string") return undefined;
    files[path] = value as FileCheckpointEntry;
  }
  return {
    kind: CANDIDATE_FILE_STATE_KIND,
    forkPointUuid: metadata.forkPointUuid,
    leafUuid: metadata.leafUuid,
    files,
    timestamp: typeof metadata.timestamp === "string" ? metadata.timestamp : "",
    ...(metadata.taintedByHostProcess === true ? { taintedByHostProcess: true as const } : {}),
  };
}
