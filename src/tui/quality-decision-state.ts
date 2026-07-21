import type { SessionSnapshot } from "../core/session/store";
import type { PendingQualityDecisionState } from "./decision-interaction";
import { joinSessionPath, vesicleMessagesFromResumed } from "./session-presenter";

export function pendingQualityDecisionFromSnapshot(
  snapshot: SessionSnapshot,
  blockedReason?: string,
): PendingQualityDecisionState | undefined {
  if (snapshot.pendingQualityDecision) {
    const point = snapshot.pendingQualityDecision;
    return {
      kind: "needs_quality_decision",
      sessionId: snapshot.sessionId,
      sessionPath: joinSessionPath(snapshot.sessionId),
      engine: point.request.producer,
      decision: blockedReason
        ? { ...point.request, canRetry: false, blockedReason }
        : point.request,
      assistantContent: point.candidate.content,
      messages: vesicleMessagesFromResumed(snapshot.messages),
    };
  }
  const pending = snapshot.pendingQualityRewrite;
  if (!pending) return undefined;
  const event = [...snapshot.qualityEvents].reverse().find((candidate) => candidate.producer === pending.producer);
  const targets = event?.targets.map((target) => ({
    id: target.id,
    ...(target.path ? { path: target.path } : {}),
    findingIds: [...target.findingIds],
  })) ?? pending.targets.map((target) => ({ id: target.id, path: target.path, findingIds: event?.findingIds ?? [] }));
  return {
    kind: "needs_quality_decision",
    sessionId: snapshot.sessionId,
    sessionPath: joinSessionPath(snapshot.sessionId),
    engine: pending.producer,
    decision: {
      id: pending.warningId ?? `quality-interrupted:${snapshot.sessionId}`,
      reason: "interrupted",
      producer: pending.producer,
      findingCount: event?.findingIds.length ?? 0,
      targets,
      canRetry: !blockedReason,
      ...(blockedReason ? { blockedReason } : {}),
    },
    assistantContent: pending.candidate?.content ?? "",
    messages: vesicleMessagesFromResumed(snapshot.messages),
  };
}
