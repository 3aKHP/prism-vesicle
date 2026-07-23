import { clearFrozenInstructionBlocks } from "../instructions/instruction-context";
import { loadSessionSnapshot } from "../session/store";
import {
  refreshQualityDecisionArtifacts,
  resolveActiveQualityRuntime,
} from "./quality-artifact-refresh";
import {
  resumePendingQualityRewrite,
  type QualityContinuationOptions,
} from "./quality-continuation-bootstrap";
import {
  retryQualityDecision,
  settleInterruptedQualityRewrite,
  settleQualityDecision,
} from "./quality-decision-settlement";
import type {
  QualityDecisionResolution,
  ResolveQualityDecisionResult,
  RunPromptResult,
} from "./types";

type ResolveQualityDecisionOptions = QualityContinuationOptions & {
  resolution: QualityDecisionResolution;
};

export async function resumeQualityRewrite(
  options: QualityContinuationOptions,
): Promise<RunPromptResult> {
  return resumePendingQualityRewrite(options);
}

export async function resolveQualityDecision(
  options: ResolveQualityDecisionOptions,
): Promise<ResolveQualityDecisionResult> {
  const rootDir = options.rootDir ?? process.cwd();
  let snapshot = await loadSessionSnapshot(rootDir, options.sessionId, {
    synthesizeDanglingToolResults: false,
  });
  const activeQuality = await resolveActiveQualityRuntime(options, snapshot);
  if (activeQuality && snapshot.pendingQualityDecision) {
    snapshot = await refreshQualityDecisionArtifacts(rootDir, options.sessionId, activeQuality);
  }
  const point = snapshot.pendingQualityDecision;
  const rewrite = snapshot.pendingQualityRewrite;
  if (!point && !rewrite && activeQuality) {
    clearFrozenInstructionBlocks(options.sessionId);
    return {
      kind: "quality_resolved",
      sessionId: options.sessionId,
      resolution: options.resolution === "stop" ? "stop" : "accept",
    };
  }
  if (!point && !rewrite) {
    throw new Error("Session does not have a pending Output Quality Guard decision.");
  }
  const producer = point?.request.producer ?? rewrite!.producer;
  if (producer !== options.engine) {
    throw new Error("Pending quality decision Engine does not match the requested continuation.");
  }

  if (options.resolution === "retry") {
    return point ? retryQualityDecision(options, point) : resumePendingQualityRewrite(options);
  }
  if (point) {
    await settleQualityDecision(rootDir, options.sessionId, snapshot, point, options.resolution);
  } else {
    await settleInterruptedQualityRewrite(rootDir, options.sessionId, snapshot, options.resolution);
  }
  clearFrozenInstructionBlocks(options.sessionId);
  return { kind: "quality_resolved", sessionId: options.sessionId, resolution: options.resolution };
}

export { refreshQualityDecisionArtifacts } from "./quality-artifact-refresh";
