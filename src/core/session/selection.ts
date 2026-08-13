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
 * The content leaf of each candidate subtree hanging off forkPointUuid, ordered
 * by subtree root timestamp. A candidate root is a direct child of the fork
 * point that is not itself a selection marker; its content leaf is the deepest
 * descendant that is not a selection marker (selection markers chain off a
 * content leaf when that candidate is selected, and must not be mistaken for the
 * candidate's own leaf). Selection markers are transparent during traversal so
 * a paused candidate's later continuation remains part of that candidate. A
 * subtree is exposed only after it contains an assistant response, excluding a
 * failed regenerate that stopped after its file-history snapshot.
 */
export function enumerateCandidateLeaves(records: SessionRecord[], forkPointUuid: string): SessionRecord[] {
  const childrenOf = new Map<string | null, SessionRecord[]>();
  for (const record of records) {
    const siblings = childrenOf.get(record.parentUuid) ?? [];
    siblings.push(record);
    childrenOf.set(record.parentUuid, siblings);
  }
  const roots = (childrenOf.get(forkPointUuid) ?? [])
    .filter((record) => !isCandidateSelectionRecord(record))
    .sort((a, b) => a.ts.localeCompare(b.ts));
  return roots.flatMap((root) => {
    const candidate = contentLeaf(root, childrenOf);
    return candidate.hasAssistant && candidate.leaf ? [candidate.leaf] : [];
  });
}

function contentLeaf(
  start: SessionRecord,
  childrenOf: Map<string | null, SessionRecord[]>,
): { leaf?: SessionRecord; hasAssistant: boolean } {
  let leaf = isContentRecord(start) ? start : undefined;
  let hasAssistant = start.role === "assistant";
  const children = (childrenOf.get(start.uuid) ?? []).sort((a, b) => b.ts.localeCompare(a.ts));
  for (const child of children) {
    const descendant = contentLeaf(child, childrenOf);
    hasAssistant ||= descendant.hasAssistant;
    if (descendant.leaf) {
      leaf = descendant.leaf;
      break;
    }
  }
  return { leaf, hasAssistant };
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
