// Horizontal candidate selection for #88 (regenerate + branch).
//
// Vesicle's session JSONL is already a parent-pointer record tree, and a
// horizontal candidate is just a sibling subtree off a shared fork point (the
// user record). This module owns the persisted selection marker and the pure
// candidate-enumeration queries. It does NOT change default-head resolution:
// the marker is appended at the physical tail chained off the selected
// candidate's content leaf, so buildActiveSessionBranch's existing
// records.at(-1) default walks through it to the selected candidate (Option X).
//
// The marker is role:"system" with a dedicated kind, which makes it invisible
// to provider message projection (history-projector drops unknown system
// records), rewind-point enumeration (isSelectableUserRecord rejects non-user
// records), and pending-interaction recovery (the single-tail assistant scan
// skips it). So selecting a candidate also scopes interaction recovery to that
// candidate for free.

import { buildActiveSessionBranch } from "./record-model";
import { isAuthoredPrompt } from "./segmentation";
import { createSessionStore, loadSessionRecords, type SessionRecord } from "./store";

export const CANDIDATE_SELECTION_KIND = "candidate-selection";

export type CandidateSelection = {
  /** The shared fork point the candidates hang off (the user record uuid). */
  forkPointUuid: string;
  /** The content leaf of the now-active candidate. */
  selectedLeafUuid: string;
};

export function isCandidateSelectionRecord(record: SessionRecord): boolean {
  return record.metadata?.kind === CANDIDATE_SELECTION_KIND;
}

export function isContentRecord(record: SessionRecord): boolean {
  // System records are host metadata (validation, checkpoints, preferences,
  // quality state, and candidate markers), never candidate content. Keeping the
  // boundary role-based avoids a fragile whitelist as new host record kinds are
  // added. User, assistant, and tool records remain content leaves.
  return record.role !== "system";
}

/**
 * Append a candidate-selection marker at the physical tail, chained off the
 * selected candidate's content leaf. The marker becomes the new physical tail,
 * so the default-head branch walk follows its parentUuid to the selected
 * candidate's subtree. The leaf is validated first: a marker whose parentUuid
 * does not exist in the file would make buildActiveSessionBranch throw and fail
 * the whole session load.
 */
export async function appendCandidateSelection(
  rootDir: string,
  sessionId: string,
  selection: CandidateSelection,
): Promise<SessionRecord> {
  const records = await loadSessionRecords(rootDir, sessionId);
  if (!records.some((record) => record.uuid === selection.selectedLeafUuid)) {
    throw new Error(
      `Cannot select candidate: leaf ${selection.selectedLeafUuid} is not in session ${sessionId}.`,
    );
  }
  const store = await createSessionStore(rootDir, sessionId, { parentUuid: selection.selectedLeafUuid });
  return store.append({
    role: "system",
    content: "",
    metadata: {
      kind: CANDIDATE_SELECTION_KIND,
      forkPointUuid: selection.forkPointUuid,
      selectedLeafUuid: selection.selectedLeafUuid,
    },
  });
}

/**
 * Parent->children index over the full physical record list, each child list
 * in append (timestamp) order. Shared by every candidate-tree query.
 */
export function buildChildrenIndex(records: SessionRecord[]): Map<string | null, SessionRecord[]> {
  const childrenOf = new Map<string | null, SessionRecord[]>();
  for (const record of records) {
    const siblings = childrenOf.get(record.parentUuid) ?? [];
    siblings.push(record);
    childrenOf.set(record.parentUuid, siblings);
  }
  for (const siblings of childrenOf.values()) {
    siblings.sort((a, b) => a.ts.localeCompare(b.ts));
  }
  return childrenOf;
}

/**
 * Continuation children of a record: content children when any exist, else
 * the system children (newest-first). Content continuations chain THROUGH
 * system records — bootstrap file-history snapshots, selection markers, and
 * validation metadata sit between content records — so endpoint queries must
 * keep walking through them, matching the legacy contentLeaf transparency.
 */
function continuationChildrenOf(index: Map<string | null, SessionRecord[]>, uuid: string): SessionRecord[] {
  const children = index.get(uuid) ?? [];
  const content = children.filter((record) => isContentRecord(record));
  if (content.length > 0) return content;
  return children.slice().reverse();
}

/**
 * Direct candidate roots hanging off a fork point, in creation order. A root
 * is either a content child, or the first content record of a child system
 * chain — a regenerated candidate's bootstrap appends its file-history
 * snapshot off the fork point first, and the candidate's assistant chains
 * below it. Selection markers expose nothing (their content descendants are
 * reachable from the candidate they chain off), and a system chain with no
 * content below (a failed regenerate that stopped after its snapshot) exposes
 * no root, preserving the "subtree contains an assistant" exposure rule.
 */
export function candidateSubtreeRoots(
  index: Map<string | null, SessionRecord[]>,
  forkPointUuid: string,
): SessionRecord[] {
  const roots: SessionRecord[] = [];
  for (const child of index.get(forkPointUuid) ?? []) {
    if (isCandidateSelectionRecord(child)) continue;
    if (isContentRecord(child)) {
      roots.push(child);
      continue;
    }
    const chainHead = firstContentDescendant(child, index);
    if (chainHead) roots.push(chainHead);
  }
  return roots.sort((a, b) => a.ts.localeCompare(b.ts));
}

function firstContentDescendant(
  start: SessionRecord,
  index: Map<string | null, SessionRecord[]>,
): SessionRecord | undefined {
  for (const child of continuationChildrenOf(index, start.uuid)) {
    if (isContentRecord(child)) return child;
    if (isCandidateSelectionRecord(child)) continue;
    const found = firstContentDescendant(child, index);
    if (found) return found;
  }
  return undefined;
}

/**
 * The content leaf of the candidate subtree rooted at `start`: the deepest
 * content descendant following the newest content child at each step.
 * Selection markers are transparent (system records are never content) so a
 * paused candidate's later continuation remains part of that candidate. This
 * is the ENDPOINT-ledger query used for selection markers and file bundles;
 * display enumeration must use listForkCandidates/buildCandidateTree so a
 * nested fork is never flattened into its deepest continuation.
 */
export function subtreeEndpoint(
  start: SessionRecord,
  index: Map<string | null, SessionRecord[]>,
): { leaf?: SessionRecord; hasAssistant: boolean } {
  let leaf = isContentRecord(start) ? start : undefined;
  let hasAssistant = start.role === "assistant";
  const children = (index.get(start.uuid) ?? []).slice().reverse();
  for (const child of children) {
    const descendant = subtreeEndpoint(child, index);
    hasAssistant ||= descendant.hasAssistant;
    if (descendant.leaf) {
      leaf = descendant.leaf;
      break;
    }
  }
  return { leaf, hasAssistant };
}

/**
 * The endpoint (deepest content leaf) of each candidate subtree hanging off
 * forkPointUuid, ordered by creation. A subtree is exposed only after it
 * contains an assistant response, excluding a failed regenerate that stopped
 * after its file-history snapshot. Retained for regenerate compensation and
 * the inline switcher's leaf arithmetic.
 */
export function enumerateCandidateLeaves(records: SessionRecord[], forkPointUuid: string): SessionRecord[] {
  const index = buildChildrenIndex(records);
  return candidateSubtreeRoots(index, forkPointUuid).flatMap((root) => {
    const candidate = subtreeEndpoint(root, index);
    return candidate.hasAssistant && candidate.leaf ? [candidate.leaf] : [];
  });
}

/** The first assistant record inside the subtree rooted at `start`, if any. */
export function candidateReplyRecord(
  start: SessionRecord,
  index: Map<string | null, SessionRecord[]>,
): SessionRecord | undefined {
  if (start.role === "assistant") return start;
  for (const child of continuationChildrenOf(index, start.uuid)) {
    if (isCandidateSelectionRecord(child)) continue;
    const found = candidateReplyRecord(child, index);
    if (found) return found;
  }
  return undefined;
}

/** Count of authored user prompts inside the subtree rooted at `start` (inclusive). */
export function countAuthoredTurns(start: SessionRecord, index: Map<string | null, SessionRecord[]>): number {
  let count = isAuthoredPrompt(start) ? 1 : 0;
  for (const child of continuationChildrenOf(index, start.uuid)) {
    if (isCandidateSelectionRecord(child)) continue;
    count += countAuthoredTurns(child, index);
  }
  return count;
}

export type ForkCandidate = {
  rootUuid: string;
  endpointUuid: string;
  replyUuid?: string;
  ts: string;
  hasAssistant: boolean;
  authoredTurnCount: number;
};

/**
 * Display-facing enumeration of one fork point's candidates: each exposed as
 * its own branch (root + endpoint + reply) without flattening nested forks.
 * Exposure keeps the "subtree contains an assistant" rule.
 */
export function listForkCandidates(records: SessionRecord[], forkPointUuid: string): ForkCandidate[] {
  const index = buildChildrenIndex(records);
  const candidates: ForkCandidate[] = [];
  for (const root of candidateSubtreeRoots(index, forkPointUuid)) {
    const endpoint = subtreeEndpoint(root, index);
    if (!endpoint.hasAssistant || !endpoint.leaf) continue;
    const reply = candidateReplyRecord(root, index);
    candidates.push({
      rootUuid: root.uuid,
      endpointUuid: endpoint.leaf.uuid,
      ...(reply ? { replyUuid: reply.uuid } : {}),
      ts: root.ts,
      hasAssistant: true,
      authoredTurnCount: countAuthoredTurns(root, index),
    });
  }
  return candidates;
}

export type CandidateTreeFork = {
  /** The record the candidate branches hang off: an authored user prompt for
   * horizontal candidates, or the previous turn's tail for /rewind forks. */
  forkRecordUuid: string;
  forkExcerpt: string;
  ts: string;
  activePath: boolean;
  candidates: CandidateTreeBranch[];
};

export type CandidateTreeBranch = {
  rootUuid: string;
  endpointUuid: string;
  replyUuid?: string;
  /** Representative first line: the branch's own prompt when its root is an
   * authored user record, else its first assistant reply. */
  excerpt: string;
  ts: string;
  activePath: boolean;
  /** Authored turns inside this branch, including the branch's own prompt. */
  authoredTurnCount: number;
  fork?: CandidateTreeFork;
};

/**
 * The full candidate tree of the session: every fork (a content record with
 * two or more content-child subtrees) with all of its branches, recursing
 * into inactive branches as well. The active branch is flagged at every level
 * so the panel can default-expand it.
 */
export function buildCandidateTree(records: SessionRecord[]): CandidateTreeFork[] {
  if (records.length === 0) return [];
  const index = buildChildrenIndex(records);
  const activeUuids = new Set(buildActiveSessionBranch(records).map((record) => record.uuid));
  const fork = findForkBelow(records[0]!, index, activeUuids, true);
  return fork ? [fork] : [];
}

function findForkBelow(
  start: SessionRecord,
  index: Map<string | null, SessionRecord[]>,
  activeUuids: Set<string>,
  includeStart: boolean,
): CandidateTreeFork | undefined {
  // Walk the candidate-root skeleton: a record forks when two or more
  // candidate roots hang off it; a single root continues the chain (including
  // roots reached through bootstrap snapshot system chains).
  let current: SessionRecord | undefined = includeStart ? start : undefined;
  if (!includeStart) {
    const roots = candidateSubtreeRoots(index, start.uuid);
    if (roots.length >= 2) return buildForkNode(start, index, activeUuids);
    current = roots[0];
  }
  while (current) {
    const roots = candidateSubtreeRoots(index, current.uuid);
    if (roots.length >= 2) return buildForkNode(current, index, activeUuids);
    current = roots[0];
  }
  return undefined;
}

function buildForkNode(
  forkRecord: SessionRecord,
  index: Map<string | null, SessionRecord[]>,
  activeUuids: Set<string>,
): CandidateTreeFork {
  return {
    forkRecordUuid: forkRecord.uuid,
    forkExcerpt: forkRecord.content,
    ts: forkRecord.ts,
    activePath: activeUuids.has(forkRecord.uuid),
    candidates: candidateSubtreeRoots(index, forkRecord.uuid).map((root) => buildBranchNode(root, index, activeUuids)),
  };
}

function buildBranchNode(
  root: SessionRecord,
  index: Map<string | null, SessionRecord[]>,
  activeUuids: Set<string>,
): CandidateTreeBranch {
  const endpoint = subtreeEndpoint(root, index);
  const reply = candidateReplyRecord(root, index);
  const excerpt = root.role === "user" ? root.content : reply?.content ?? root.content;
  const nested = findForkBelow(root, index, activeUuids, false);
  return {
    rootUuid: root.uuid,
    endpointUuid: endpoint.leaf?.uuid ?? root.uuid,
    ...(reply ? { replyUuid: reply.uuid } : {}),
    excerpt,
    ts: root.ts,
    activePath: activeUuids.has(root.uuid),
    authoredTurnCount: countAuthoredTurns(root, index),
    ...(nested ? { fork: nested } : {}),
  };
}

/**
 * The authored user prompt owning a leaf: the nearest authored user record at
 * or above it in the parent chain. Selection markers for any-depth switches
 * key their forkPointUuid on this value, which re-arms the inline switcher at
 * the switched-to depth.
 */
export function ownerForkOfLeaf(records: SessionRecord[], leafUuid: string): string | undefined {
  const byUuid = new Map(records.map((record) => [record.uuid, record] as const));
  let current = byUuid.get(leafUuid);
  while (current) {
    if (isAuthoredPrompt(current)) return current.uuid;
    current = current.parentUuid ? byUuid.get(current.parentUuid) : undefined;
  }
  return undefined;
}

/**
 * The latest candidate-selection marker in the session, or undefined when no
 * candidate operation has occurred. The TUI uses this as the active-candidate
 * oracle for rendering the inline `<n/m>` switcher.
 */
export function findLatestSelection(records: SessionRecord[]): CandidateSelection | undefined {
  for (let index = records.length - 1; index >= 0; index -= 1) {
    const metadata = records[index]!.metadata;
    if (metadata?.kind === CANDIDATE_SELECTION_KIND) {
      return {
        forkPointUuid: String(metadata.forkPointUuid),
        selectedLeafUuid: String(metadata.selectedLeafUuid),
      };
    }
  }
  return undefined;
}

/**
 * The nearest content (non-system) record at or above `uuid` in the parent
 * chain. Host records such as validation metadata trail a candidate's content
 * leaf; this resolves the chain back to the leaf itself.
 */
export function contentLeafAtOrAbove(records: SessionRecord[], uuid: string | undefined): string | undefined {
  if (!uuid) return undefined;
  const byUuid = new Map(records.map((record) => [record.uuid, record] as const));
  let current = byUuid.get(uuid);
  while (current) {
    if (isContentRecord(current)) return current.uuid;
    current = current.parentUuid ? byUuid.get(current.parentUuid) : undefined;
  }
  return undefined;
}
