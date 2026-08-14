// Per-candidate file coexistence (#88 Phase 2, full-manifest model).
//
// Regenerate and candidate switching move the conversation between candidate
// leaves at any depth of the session tree, but the filesystem is global: only
// one candidate's artifacts can be on disk at once. This module maintains the
// invariant that the disk equals the active candidate's post-state:
//
// - Leaving a candidate (switch-away or regenerate-over) captures a FULL
//   MANIFEST of everything on disk under the project content roots — every
//   directory and content-addressed file, with symlinks and special files
//   listed as exempt `untracked` — into an append-only `candidate-file-state`
//   bundle (envelope version 2) chained off the candidate's content leaf
//   (branch-private). Capture eligibility follows the leaf's latest file
//   event: a bundle is reused while it stays the latest event (a failed
//   restore can then never be mistaken for the candidate's true post-state);
//   a successful restore appends a `candidate-file-restored` marker, which
//   re-establishes on-disk authority and lets the next departure capture a
//   superseding bundle (user edits made while the candidate is active are
//   therefore never lost); a `candidate-file-degraded` marker refuses capture
//   until a future successful restore revives the candidate.
// - Switching to a candidate makes the disk strictly equal to its manifest:
//   manifest entries are restored and on-disk paths outside the manifest are
//   deleted, except symlinks/special files (never managed), paths exempted by
//   the bundle's `untracked` list, and ancestors of manifest paths (apply
//   recreates them). Manual edits and MCP writes are therefore snapshotted
//   when a candidate is left and deleted or restored like any other file.
// - Regenerate restores the fork baseline first — the first-wins merge of
//   every candidate's pre-turn ledger state in creation order — so a new
//   candidate runs against the state the fork turn actually started from.
//   The baseline deliberately stays ledger-scoped: deleting paths that were
//   never tracked would destroy files that predate the checkpoint ledger.
//
// Degradation: a switch whose target has no bundle restores nothing, so the
// invariant no longer holds for the now-active candidate. Such a switch (and
// every conversation-only switch chained after it) appends a
// `candidate-file-degraded` marker chained off the target leaf; captures for a
// marked leaf are refused so a wrong disk state can never be frozen into an
// authoritative bundle. Capture likewise refuses when the fork turn's branch
// carries no checkpoint ledger: the ledger anchor is what makes "the disk
// equals this candidate's post-state" trustworthy at capture time, and
// manifests stay full regardless of which paths the ledger tracked.
// Version-1 partial bundles (pre-full-manifest sessions) are rejected by the
// parser and degrade the same way: alpha-stage breaking change, no migration
// path.
//
// Bundles and markers use dedicated envelope kinds: they never enter
// snapshotsFromRecords (immune to the 100-snapshot window), are ignored by
// provider projection (unknown system records), and are transparent to
// candidate enumeration (system records are never content leaves). Scratch
// tmp/ stays outside the manifest (137B), and host-process turns carry the
// taint flag as a warning; symlinks are exempt, never restored, and surfaced
// in the switch outcome.

import { enumerateCandidateLeaves } from "../session/selection";
import { createSessionStore, loadSessionRecords, type SessionRecord } from "../session/store";
import { modelWritableRoots, projectContentRoots } from "../project/roots";
import {
  applyFileCheckpointEntries,
  captureProjectTree,
  diffDiskAgainstEntries,
  fileCheckpointingEnabled,
  fileCheckpointIsTainted,
  forkTurnPreState,
  listProjectTreePaths,
  type FileCheckpointDiffStats,
  type FileCheckpointEntry,
} from "./file-history";

export const CANDIDATE_FILE_STATE_KIND = "candidate-file-state";
export const CANDIDATE_FILE_DEGRADED_KIND = "candidate-file-degraded";
export const CANDIDATE_FILE_RESTORED_KIND = "candidate-file-restored";

const BACKUP_HASH_PATTERN = /^[0-9a-f]{64}$/;

export type CandidateFileStateEnvelope = {
  kind: typeof CANDIDATE_FILE_STATE_KIND;
  /** Full-manifest bundles are version 2; version-1 partial bundles are rejected. */
  version: 2;
  forkPointUuid: string;
  /** Content leaf of the candidate whose post-state this bundle carries. */
  leafUuid: string;
  files: Record<string, FileCheckpointEntry>;
  timestamp: string;
  /** Symlinks/special files present at capture: exempt from capture and restore. */
  untracked?: string[];
  /** The candidate's turn ran a host process; its post-state may be incomplete. */
  taintedByHostProcess?: true;
};

export type CandidateFileStateOutcome = {
  restored: boolean;
  changed: string[];
  tainted?: true;
  /** Symlinks/special files left untouched by the switch. */
  untracked?: string[];
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

export type CandidateFileEventKind = "bundle" | "degraded" | "restored";

/**
 * The latest file-state event recorded for `leafUuid` in physical order:
 * a bundle capture, a degradation marker, or a restored marker. Capture
 * eligibility is decided by this event, not by any-marker-exists checks:
 * a candidate whose manifest was genuinely restored since its last bundle
 * may legitimately have diverged on disk (user edits) and must be allowed to
 * produce a superseding bundle, while retry-safety (no restore since the last
 * bundle) and degradation (disk known wrong) keep refusing.
 */
export function latestCandidateFileEvent(
  records: SessionRecord[],
  leafUuid: string,
): { kind: CandidateFileEventKind; record: SessionRecord } | undefined {
  for (let index = records.length - 1; index >= 0; index -= 1) {
    const record = records[index]!;
    const metadata = record.metadata;
    if (metadata?.leafUuid !== leafUuid) continue;
    if (parseCandidateFileState(metadata)) return { kind: "bundle", record };
    if (metadata.kind === CANDIDATE_FILE_DEGRADED_KIND) return { kind: "degraded", record };
    if (metadata.kind === CANDIDATE_FILE_RESTORED_KIND) return { kind: "restored", record };
  }
  return undefined;
}

/**
 * Whether the disk is known NOT to equal this candidate's post-state: the
 * leaf's latest file event is a degradation marker (a conversation-only
 * switch made it active, or a failed switch poisoned the disk), so capturing
 * it would freeze a wrong state.
 */
export function isCandidateFileDegraded(records: SessionRecord[], leafUuid: string): boolean {
  return latestCandidateFileEvent(records, leafUuid)?.kind === "degraded";
}

/**
 * Capture the departing candidate's post-state as a full manifest of
 * everything on disk under the project content roots. Eligibility follows the
 * leaf's latest file event: an existing bundle is reused while it stays the
 * latest event (a failed restore can then never be mistaken for the
 * candidate's true post-state); a RESTORED marker superseded the last bundle,
 * meaning the disk was genuinely re-established for this candidate and any
 * later divergence (user edits, tool writes) is real post-state evolution, so
 * a new superseding bundle is captured; a degradation marker refuses capture.
 * Also returns undefined when checkpointing is disabled or the fork turn's
 * branch carries no checkpoint ledger — without that anchor there is no
 * guarantee the disk equals this candidate's post-state. Capture is
 * all-or-nothing: a mid-capture failure throws before any record is appended.
 */
export async function ensureCandidatePostState(
  rootDir: string,
  sessionId: string,
  selection: { forkPointUuid: string; leafUuid: string },
): Promise<CandidateFileStateEnvelope | undefined> {
  if (!fileCheckpointingEnabled()) return undefined;
  const records = await loadSessionRecords(rootDir, sessionId);
  const event = latestCandidateFileEvent(records, selection.leafUuid);
  if (event?.kind === "bundle") return parseCandidateFileState(event.record.metadata);
  if (event?.kind === "degraded") return undefined;

  const ledgerAnchor = await forkTurnPreState(rootDir, sessionId, selection.forkPointUuid, { headUuid: selection.leafUuid });
  if (!ledgerAnchor) return undefined;
  const capture = await captureProjectTree(rootDir, sessionId, projectContentRoots);
  const tainted = await fileCheckpointIsTainted(rootDir, sessionId, selection.forkPointUuid, { headUuid: selection.leafUuid });
  const envelope: CandidateFileStateEnvelope = {
    kind: CANDIDATE_FILE_STATE_KIND,
    version: 2,
    forkPointUuid: selection.forkPointUuid,
    leafUuid: selection.leafUuid,
    files: capture.files,
    timestamp: new Date().toISOString(),
    ...(capture.untracked.length > 0 ? { untracked: capture.untracked } : {}),
    ...(tainted ? { taintedByHostProcess: true as const } : {}),
  };
  // Chain the bundle off the candidate's content leaf so it is branch-private:
  // other candidates' branch projections never walk through it.
  const store = await createSessionStore(rootDir, sessionId, { parentUuid: selection.leafUuid });
  await store.append({ role: "system", content: "", metadata: envelope });
  return envelope;
}

/**
 * Record that `leafUuid`'s manifest was just applied to the disk: the
 * candidate's on-disk authority is re-established, so a later departure may
 * capture a superseding bundle. Branch-private like bundles.
 */
async function appendRestoredMarker(
  rootDir: string,
  sessionId: string,
  selection: { forkPointUuid: string; leafUuid: string },
): Promise<void> {
  const store = await createSessionStore(rootDir, sessionId, { parentUuid: selection.leafUuid });
  await store.append({
    role: "system",
    content: "",
    metadata: {
      kind: CANDIDATE_FILE_RESTORED_KIND,
      forkPointUuid: selection.forkPointUuid,
      leafUuid: selection.leafUuid,
      timestamp: new Date().toISOString(),
    },
  });
}

/**
 * Move the filesystem from candidate `fromLeaf` to candidate `toLeaf`: capture
 * the departing candidate's full manifest first, then make the disk strictly
 * equal to the target's manifest. Works at any depth of the session tree — the
 * capture keys on leaves, not fork points. When the target has no bundle the
 * switch degrades to conversation-only: nothing is captured or restored, and a
 * degradation marker records that the invariant no longer holds for the new
 * active candidate.
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

  const applied = await applyCandidateManifest(rootDir, sessionId, bundle).catch(async (error) => {
    // A failed application leaves the disk half-restored: it belongs to
    // neither candidate, so both lose on-disk authority until a future
    // successful restore re-establishes it.
    await appendDegradedMarker(rootDir, sessionId, { forkPointUuid: selection.forkPointUuid, toLeaf: selection.fromLeaf });
    await appendDegradedMarker(rootDir, sessionId, selection);
    throw error;
  });
  await appendRestoredMarker(rootDir, sessionId, { forkPointUuid: selection.forkPointUuid, leafUuid: selection.toLeaf });
  return {
    restored: true,
    changed: applied.changed,
    ...(bundle.taintedByHostProcess ? { tainted: true as const } : {}),
    ...(applied.untracked.length > 0 ? { untracked: applied.untracked } : {}),
  };
}

/**
 * Make the disk strictly equal to a bundle's full manifest: restore every
 * manifest entry and delete on-disk paths outside it. Deletions exempt
 * symlinks/special files (never managed), the bundle's `untracked` list, and
 * ancestors of manifest paths (apply recreates them as needed).
 */
async function applyCandidateManifest(
  rootDir: string,
  sessionId: string,
  bundle: CandidateFileStateEnvelope,
): Promise<{ changed: string[]; untracked: string[] }> {
  const listing = await listProjectTreePaths(rootDir, projectContentRoots);
  const exempt = bundle.untracked ?? [];
  const absents: Record<string, FileCheckpointEntry> = {};
  for (const path of manifestDeletionPaths(listing.paths, Object.keys(bundle.files), exempt)) {
    absents[path] = { backup: null, kind: "absent" };
  }
  const changed = await applyFileCheckpointEntries(rootDir, sessionId, { ...absents, ...bundle.files });
  const untracked = [...new Set([...exempt, ...listing.untracked])].sort();
  return { changed, untracked };
}

/**
 * On-disk paths a manifest application would delete: everything listed under
 * the content roots that is outside the manifest, not exempted by the
 * bundle's untracked list, and not an ancestor of a manifest path.
 */
function manifestDeletionPaths(
  diskPaths: Map<string, "file" | "directory">,
  manifestPaths: string[],
  exempt: string[],
): string[] {
  const deletions: string[] = [];
  for (const path of diskPaths.keys()) {
    if (manifestPaths.includes(path)) continue;
    if (isExemptByUntracked(path, exempt)) continue;
    if (isAncestorOfManifestPath(path, manifestPaths)) continue;
    deletions.push(path);
  }
  return deletions;
}

/**
 * Read-only preview of switching to `toLeaf`: the file diff the switch would
 * apply (manifest entries plus out-of-manifest deletions), or undefined when
 * checkpointing is disabled or the target has no bundle (a conversation-only
 * switch touches no files).
 */
export async function candidateSwitchPreview(
  rootDir: string,
  sessionId: string,
  toLeaf: string,
): Promise<FileCheckpointDiffStats | undefined> {
  if (!fileCheckpointingEnabled()) return undefined;
  const records = await loadSessionRecords(rootDir, sessionId);
  const bundle = findCandidatePostState(records, toLeaf);
  if (!bundle) return undefined;
  const listing = await listProjectTreePaths(rootDir, projectContentRoots);
  const deletions = manifestDeletionPaths(listing.paths, Object.keys(bundle.files), bundle.untracked ?? []);
  return diffDiskAgainstEntries(rootDir, sessionId, bundle.files, deletions);
}

function isExemptByUntracked(path: string, untracked: string[]): boolean {
  return untracked.some((exempt) => path === exempt || path.startsWith(`${exempt}/`));
}

function isAncestorOfManifestPath(path: string, manifestPaths: string[]): boolean {
  const prefix = `${path}/`;
  return manifestPaths.some((candidate) => candidate.startsWith(prefix));
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
  if (bundle) {
    await applyCandidateManifest(rootDir, sessionId, bundle);
    await appendRestoredMarker(rootDir, sessionId, { forkPointUuid, leafUuid: previousLeaf });
  }
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
  // Version-1 bundles captured only the ledger-tracked capture domain of the
  // fork turn; applying them under full-manifest semantics would restore a
  // partial state as if it were complete. Reject them outright (alpha-stage
  // breaking change): the switch degrades conversation-only instead.
  if (metadata.version !== 2) return undefined;
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
  let untracked: string[] | undefined;
  if (metadata.untracked !== undefined) {
    if (!Array.isArray(metadata.untracked)) return undefined;
    untracked = [];
    for (const path of metadata.untracked) {
      if (typeof path !== "string" || !isValidBundlePath(path)) return undefined;
      untracked.push(path);
    }
  }
  return {
    kind: CANDIDATE_FILE_STATE_KIND,
    version: 2,
    forkPointUuid: metadata.forkPointUuid,
    leafUuid: metadata.leafUuid,
    files,
    timestamp: typeof metadata.timestamp === "string" ? metadata.timestamp : "",
    ...(untracked && untracked.length > 0 ? { untracked } : {}),
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
