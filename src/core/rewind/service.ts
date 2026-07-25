import {
  fileCheckpointDiffStats,
  fileCheckpointIsTainted,
  fileCheckpointTurnDiffStats,
  restoreFileCheckpoint,
  type FileCheckpointDiffStats,
} from "../checkpoints/file-history";
import {
  FAILED_TURN_KIND,
  loadSessionSnapshot,
  type SessionRecord,
  type SessionSnapshot,
} from "../session/store";
import { ENGINE_HANDOFF_KIND } from "../engine/transition";
import { parseImageAttachments } from "../attachments/store";
import type { VesicleImageAttachment } from "../../providers/shared/types";
export { summarizeConversationFrom } from "./summarize";

export type RewindPoint = {
  uuid: string;
  parentUuid: string | null;
  content: string;
  timestamp: string;
  branchHeadUuid: string | null;
  turnDiffStats?: FileCheckpointDiffStats;
  diffStats?: FileCheckpointDiffStats;
  images?: VesicleImageAttachment[];
  checkpointTainted?: true;
  /** This prompt's turn ended without an assistant reply (provider failure). */
  failedTurn?: true;
};

export type ConversationRewind = {
  snapshot: SessionSnapshot;
  prompt: string;
  parentUuid: string | null;
  images?: VesicleImageAttachment[];
};

export async function listRewindPoints(
  rootDir: string,
  sessionId: string,
  options: { headUuid?: string | null } = {},
): Promise<RewindPoint[]> {
  const snapshot = await loadSessionSnapshot(rootDir, sessionId, options);
  const points: RewindPoint[] = [];
  const selectable = snapshot.records.filter(isSelectableUserRecord);
  // A failed-turn marker invalidates the most recent selectable user prompt at
  // or before it, so the picker can show that turn as a no-reply ghost. A single
  // forward pass tracks the last selectable user uuid (markers are system
  // records, never selectable themselves).
  const failedTurnUuids = new Set<string>();
  let lastSelectableUserUuid: string | undefined;
  for (const record of snapshot.records) {
    if (isSelectableUserRecord(record)) lastSelectableUserUuid = record.uuid;
    if (record.metadata?.kind === FAILED_TURN_KIND && lastSelectableUserUuid) {
      failedTurnUuids.add(lastSelectableUserUuid);
    }
  }
  for (let index = 0; index < selectable.length; index++) {
    const record = selectable[index]!;
    const next = selectable[index + 1];
    const diffStats = await fileCheckpointDiffStats(rootDir, sessionId, record.uuid, { headUuid: snapshot.headUuid });
    const turnDiffStats = await fileCheckpointTurnDiffStats(
      rootDir,
      sessionId,
      record.uuid,
      next?.uuid,
      { headUuid: snapshot.headUuid },
    );
    const checkpointTainted = await fileCheckpointIsTainted(rootDir, sessionId, record.uuid, { headUuid: snapshot.headUuid });
    points.push({
      uuid: record.uuid,
      parentUuid: record.parentUuid,
      content: record.content,
      timestamp: record.ts,
      branchHeadUuid: snapshot.headUuid,
      ...(turnDiffStats ? { turnDiffStats } : {}),
      ...(diffStats ? { diffStats } : {}),
      ...(checkpointTainted ? { checkpointTainted: true as const } : {}),
      ...(failedTurnUuids.has(record.uuid) ? { failedTurn: true as const } : {}),
      ...(parseImageAttachments(record.metadata?.images)
        ? { images: parseImageAttachments(record.metadata?.images) }
        : {}),
    });
  }
  return points;
}

export async function rewindConversation(
  rootDir: string,
  sessionId: string,
  point: RewindPoint,
): Promise<ConversationRewind> {
  const snapshot = await loadSessionSnapshot(rootDir, sessionId, { headUuid: point.parentUuid });
  return {
    snapshot,
    prompt: point.content,
    parentUuid: point.parentUuid,
    ...(point.images ? { images: point.images.map((image) => ({ ...image })) } : {}),
  };
}

export async function rewindCode(rootDir: string, sessionId: string, point: RewindPoint): Promise<string[]> {
  return restoreFileCheckpoint(rootDir, sessionId, point.uuid, { headUuid: point.branchHeadUuid });
}

export async function rewindCodeAndConversation(
  rootDir: string,
  sessionId: string,
  point: RewindPoint,
): Promise<ConversationRewind & { restoredFiles: string[] }> {
  const restoredFiles = await rewindCode(rootDir, sessionId, point);
  const conversation = await rewindConversation(rootDir, sessionId, point);
  return { ...conversation, restoredFiles };
}

export function isSelectableUserRecord(record: SessionRecord): boolean {
  if (record.role !== "user") return false;
  const kind = record.metadata?.kind;
  // Exclude every host-injected user-role record that is not an authored prompt:
  // continuation resolutions, compacted context, and round inputs that projection
  // treats as droppable failed-turn input (background-process results, SubAgent
  // deliveries, quality-rewrite feedback). These should never appear as rewind
  // points, and the failed-turn scan must skip them to attribute a marker to the
  // real prompt.
  if (
    kind === "gate-resolution"
    || kind === "user-question-answer"
    || kind === "compact-summary"
    || kind === "background-process-results"
    || kind === "subagent-results"
    || kind === "quality-rewrite-feedback"
    || kind === ENGINE_HANDOFF_KIND
  ) return false;
  return record.content.trim().length > 0;
}
