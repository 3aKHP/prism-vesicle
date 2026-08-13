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
//   entries for files the departing candidate created, and pre(to) covers
//   tracked paths outside the bundle's capture domain.
// - Regenerate restores the fork baseline first — the first-wins merge of
//   every candidate's pre-turn state in creation order — so a new candidate
//   runs against the state the fork turn actually started from, even when
//   MVP-era candidates ran against each other's files.
//
// Degradation: a switch whose target has no bundle restores nothing, so the
// invariant no longer holds for the now-active candidate. Such a switch (and
// every conversation-only switch chained after it) appends a
// `candidate-file-degraded` marker chained off the target leaf; captures for a
// marked leaf are refused so a wrong disk state can never be frozen into an
// authoritative bundle. The same applies to forks whose turn has no checkpoint
// ledger (file checkpointing disabled while it ran): there is no truthful
// post-state to capture and no baseline to restore, so regenerate skips the
// file dance entirely and a failed regenerate never touches the disk.
//
// Bundles and markers use dedicated envelope kinds: they never enter
// snapshotsFromRecords (immune to the 100-snapshot window), are ignored by
// provider projection (unknown system records), and are transparent to
// candidate enumeration (system records are never content leaves). Blind spots
// shared with /rewind — MCP tool writes, host processes (surfaced via the
// taint flag), scratch tmp/, and manual edits — are documented, not solved.

import { enumerateCandidateLeaves } from "../session/selection";
import { createSessionStore, loadSessionRecords, type SessionRecord } from "../session/store";
import { modelWritableRoots } from "../project/roots";
import {
  applyFileCheckpointEntries,
  capturePath,
  fileCheckpointingEnabled,
  fileCheckpointIsTainted,
  forkTurnPreState,
  type FileCheckpointEntry,
} from "./file-history";

export const CANDIDATE_FILE_STATE_KIND = "candidate-file-state";
export const CANDIDATE_FILE_DEGRADED_KIND = "candidate-file-degraded";

const BACKUP_HASH_PATTERN = /^[0-9a-f]{64}$/;

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
 * Whether `leafUuid` carries a degradation marker: the disk was not this
 * candidate's post-state when it became active (a conversation-only switch),
 * so capturing it would freeze a wrong state. Markers chain OFF the leaf they
 * name, so the leaf's own branch walk never contains them — scan all records;
 * a marker is only ever created for the leaf it names.
 */
export function isCandidateFileDegraded(records: SessionRecord[], leafUuid: string): boolean {
  return records.some(
    (record) => record.metadata?.kind === CANDIDATE_FILE_DEGRADED_KIND && record.metadata.leafUuid === leafUuid,
  );
}

/**
 * Capture the departing candidate's post-state if it has no bundle yet.
 * Returns undefined when checkpointing is disabled, the candidate's branch
 * carries no checkpoint history (nothing truthful to capture), or the
 * candidate is degradation-marked (the disk is not its post-state).
 */
export async function ensureCandidatePostState(
  rootDir: string,
  sessionId: string,
  selection: { forkPointUuid: string; leafUuid: string },
): Promise<CandidateFileStateEnvelope | undefined> {
  if (!fileCheckpointingEnabled()) return undefined;
  const records = await loadSessionRecords(rootDir, sessionId);
  const existing = findCandidatePostState(records, selection.leafUuid);
  if (existing) return existing;
  if (isCandidateFileDegraded(records, selection.leafUuid)) return undefined;

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
 * Captures the departing candidate's post-state first — but only while the
 * invariant holds for it — then applies the target state. When the target has
 * no bundle the switch degrades to conversation-only: nothing is captured or
 * restored, and a degradation marker records that the invariant no longer
 * holds for the new active candidate.
 */
export async function switchCandidateFileState(
  rootDir: string,
  sessionId: string,
  selection: { forkPointUuid: string; fromLeaf: string; toLeaf: string },
): Promise<CandidateFileStateOutcome> {
  if (!fileCheckpointingEnabled()) return { restored: false, changed: [], reason: "disabled" };
  // Capture the departing candidate first: at this moment the disk still
  // truthfully equals its post-state, even when the switch is about to degrade
  // conversation-only below. A degradation-marked fromLeaf was never truthful,
  // so skip it.
  const records = await loadSessionRecords(rootDir, sessionId);
  if (!isCandidateFileDegraded(records, selection.fromLeaf)) {
    await ensureCandidatePostState(rootDir, sessionId, { forkPointUuid: selection.forkPointUuid, leafUuid: selection.fromLeaf });
  }
  const bundle = findCandidatePostState(await loadSessionRecords(rootDir, sessionId), selection.toLeaf);
  if (!bundle) {
    await appendDegradedMarker(rootDir, sessionId, selection);
    return { restored: false, changed: [], reason: "missing" };
  }

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

/**
 * File-state compensation for a failed or interrupted regenerate, owned here
 * because the disk-equals-active-candidate invariant belongs to this module.
 * A candidate whose leaf was appended by the failed run keeps whatever it left
 * on disk as its bundle; the disk then returns to `previousLeaf`'s bundled
 * post-state when that bundle exists. Best-effort: callers surface the
 * original error regardless.
 */
export async function compensateFailedRegenerateFileState(
  rootDir: string,
  sessionId: string,
  forkPointUuid: string,
  previousLeaf: string,
  preRunRecords: SessionRecord[],
): Promise<void> {
  if (!fileCheckpointingEnabled()) return;
  const preRunUuids = new Set(preRunRecords.map((record) => record.uuid));
  const afterRecords = await loadSessionRecords(rootDir, sessionId);
  const failedLeaf = enumerateCandidateLeaves(afterRecords, forkPointUuid)
    .map((record) => record.uuid)
    .filter((leaf) => leaf !== previousLeaf && !preRunUuids.has(leaf))
    .at(-1);
  if (failedLeaf) {
    await switchCandidateFileState(rootDir, sessionId, { forkPointUuid, fromLeaf: failedLeaf, toLeaf: previousLeaf });
    return;
  }
  const bundle = await ensureCandidatePostState(rootDir, sessionId, { forkPointUuid, leafUuid: previousLeaf });
  if (bundle) await applyFileCheckpointEntries(rootDir, sessionId, bundle.files);
}

/**
 * Append a degradation marker chained off the switch target leaf: the disk did
 * not equal that candidate's post-state when it became active, so later
 * captures for it must be refused. Branch-private like bundles; multiple
 * markers may chain across conversation-only switches, and the latest one on
 * the branch decides.
 */
async function appendDegradedMarker(
  rootDir: string,
  sessionId: string,
  selection: { forkPointUuid: string; toLeaf: string },
): Promise<void> {
  const store = await createSessionStore(rootDir, sessionId, { parentUuid: selection.toLeaf });
  await store.append({
    role: "system",
    content: "",
    metadata: {
      kind: CANDIDATE_FILE_DEGRADED_KIND,
      forkPointUuid: selection.forkPointUuid,
      leafUuid: selection.toLeaf,
      timestamp: new Date().toISOString(),
    },
  });
}

function parseCandidateFileState(metadata: Record<string, unknown> | undefined): CandidateFileStateEnvelope | undefined {
  if (metadata?.kind !== CANDIDATE_FILE_STATE_KIND) return undefined;
  if (typeof metadata.forkPointUuid !== "string" || typeof metadata.leafUuid !== "string") return undefined;
  if (!metadata.files || typeof metadata.files !== "object") return undefined;
  const files: Record<string, FileCheckpointEntry> = {};
  for (const [path, value] of Object.entries(metadata.files as Record<string, unknown>)) {
    if (!isValidBundlePath(path)) return undefined;
    if (!value || typeof value !== "object") return undefined;
    const backup = (value as FileCheckpointEntry).backup;
    // Legitimate backups are content-addressed sha256 names written by
    // capturePath; anything else could steer readBackup/join outside the
    // backup store.
    if (backup !== null && (typeof backup !== "string" || !BACKUP_HASH_PATTERN.test(backup))) return undefined;
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

/**
 * Bundle paths are restore targets resolved against the project root, so a
 * crafted session file must not be able to steer them outside the writable
 * roots: reject absolute paths, `.`/`..` segments, and anything not under a
 * model-writable root.
 */
function isValidBundlePath(path: string): boolean {
  if (path.length === 0 || path.startsWith("/") || path.includes("\\")) return false;
  const segments = path.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) return false;
  return modelWritableRoots.some((root) => root === segments[0]);
}
