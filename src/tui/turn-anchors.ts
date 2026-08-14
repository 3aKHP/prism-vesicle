// Turn-level focus anchors for the unified Alt+↑/↓ message cursor.
//
// The cursor stops at each authored turn: the user prompt and the turn's
// final assistant reply. Display ids are record uuids (the projector stamps
// recordUuid onto user/assistant messages), so anchors survive candidate
// switches and transcript reloads; streaming messages without records fall
// back to index-based ids in MessageStream and simply are not anchors yet.

import { isAuthoredPrompt, segmentSession } from "../core/session/segmentation";
import { buildChildrenIndex, candidateSubtreeRoots } from "../core/session/selection";
import { buildActiveSessionBranch, type SessionRecord } from "../core/session/store";

export type TurnAnchor = {
  /** The authored user prompt opening the turn — also its fork point. */
  forkUuid: string;
  /** Display id of the user prompt message. */
  userMessageId: string;
  /** Display id of the turn's final assistant message, when one exists. */
  assistantMessageId?: string;
  /** True when sibling candidate branches hang off the fork. */
  hasCandidates: boolean;
};

/**
 * Anchors for the active branch, with candidate awareness from the FULL record
 * list: branch projection hides sibling candidates, but the cursor must still
 * know which turns have alternatives to switch.
 */
export function turnAnchorsFromSnapshot(records: SessionRecord[]): TurnAnchor[] {
  const branch = buildActiveSessionBranch(records);
  const { turns } = segmentSession(branch);
  const index = buildChildrenIndex(records);
  const anchors: TurnAnchor[] = [];
  for (const turn of turns) {
    const authored = turn.records.find((record) => isAuthoredPrompt(record));
    if (!authored) continue;
    const lastAssistant = [...turn.records].reverse().find((record) => record.role === "assistant");
    anchors.push({
      forkUuid: authored.uuid,
      userMessageId: authored.uuid,
      ...(lastAssistant ? { assistantMessageId: lastAssistant.uuid } : {}),
      hasCandidates: candidateSubtreeRoots(index, authored.uuid).length >= 2,
    });
  }
  return anchors;
}
