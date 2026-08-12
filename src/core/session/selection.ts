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

import { createSessionStore, loadSessionRecords, type SessionRecord } from "./store";

export const CANDIDATE_SELECTION_KIND = "candidate-selection";

export type CandidateSelection = {
  /** The shared fork point the candidates hang off (the user record uuid). */
  forkPointUuid: string;
  /** The content leaf of the now-active candidate. */
  selectedLeafUuid: string;
};

function isSelectionEvent(record: SessionRecord): boolean {
  return record.metadata?.kind === CANDIDATE_SELECTION_KIND;
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
 * The content leaf of each candidate subtree hanging off forkPointUuid, ordered
 * by subtree root timestamp. A candidate root is a direct child of the fork
 * point that is not itself a selection marker; its content leaf is the deepest
 * descendant that is not a selection marker (selection markers chain off a
 * content leaf when that candidate is selected, and must not be mistaken for the
 * candidate's own leaf). Loading the session at any content leaf projects that
 * candidate's branch.
 */
export function enumerateCandidateLeaves(records: SessionRecord[], forkPointUuid: string): SessionRecord[] {
  const childrenOf = new Map<string | null, SessionRecord[]>();
  for (const record of records) {
    const siblings = childrenOf.get(record.parentUuid) ?? [];
    siblings.push(record);
    childrenOf.set(record.parentUuid, siblings);
  }
  const roots = (childrenOf.get(forkPointUuid) ?? [])
    .filter((record) => !isSelectionEvent(record))
    .sort((a, b) => a.ts.localeCompare(b.ts));
  return roots.map((root) => contentLeaf(root, childrenOf));
}

function contentLeaf(start: SessionRecord, childrenOf: Map<string | null, SessionRecord[]>): SessionRecord {
  let current = start;
  while (true) {
    const children = (childrenOf.get(current.uuid) ?? []).filter((record) => !isSelectionEvent(record));
    if (children.length === 0) return current;
    // Candidate subtrees are linear chains. If a branch ever appears, take the
    // latest child so the most recent append defines the active leaf.
    current = children.sort((a, b) => b.ts.localeCompare(a.ts))[0]!;
  }
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
