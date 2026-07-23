import type { ExperimentalQualityProfile } from "../../config/quality";
import type { VesicleResponse } from "../../providers/shared/types";
import type { EngineId } from "../engine/profile";
import {
  durableQualityTargets,
  qualityArtifactTargetFromResult,
  upsertQualityArtifactTarget,
  type BoundQualityEvaluation,
  type DurableQualityState,
  type QualityDecisionCandidate,
  type QualityRewriteState,
  type QualityRuntimeContext,
} from "../quality";
import type { ToolResult } from "../tools";

export type QualityRoundState = QualityRewriteState & {
  proseParts: string[];
  mutationParts: string[];
  targets: NonNullable<QualityRewriteState["targets"]>;
  lastResult?: { outcome: BoundQualityEvaluation["outcome"]; findingCount: number };
};

export function createQualityRoundState(initial?: QualityRewriteState): QualityRoundState {
  return {
    attempts: initial?.attempts ?? 0,
    rejectedHashes: new Set(initial?.rejectedHashes ?? []),
    proseParts: [],
    mutationParts: [...(initial?.candidateParts ?? [])],
    targets: (initial?.targets ?? []).map((target) => ({
      ...target,
      mutationCallIds: [...target.mutationCallIds],
      rejectedHashes: new Set(target.rejectedHashes),
    })),
    warningId: initial?.warningId,
    warningTargetIds: initial?.warningTargetIds ? [...initial.warningTargetIds] : undefined,
    candidate: initial?.candidate,
    experimentalJudge: initial?.experimentalJudge,
  };
}

export function qualityDeliveryParts(state: QualityRoundState): string[] {
  return state.mutationParts.length > 0 ? state.mutationParts : state.proseParts;
}

export function qualityFindingCount(result: BoundQualityEvaluation): number {
  return result.event.targets.reduce((total, target) => total + target.findings.length, 0);
}

export function clearQualityCandidate(state: QualityRoundState): void {
  state.proseParts = [];
  state.mutationParts = [];
  state.targets = [];
}

export function qualityDecisionCandidate(response: VesicleResponse): QualityDecisionCandidate {
  return {
    responseId: response.id,
    content: response.content,
    toolCalls: (response.toolCalls ?? []).map((call) => ({ ...call })),
    ...(response.reasoningContent ? { reasoningContent: response.reasoningContent } : {}),
    ...(response.thinkingBlocks ? { thinkingBlocks: response.thinkingBlocks.map((block) => ({ ...block })) } : {}),
    ...(response.finishReason ? { finishReason: response.finishReason } : {}),
    ...(response.usage ? { usage: response.usage } : {}),
  };
}

export function durableQualityState(options: {
  runtime?: QualityRuntimeContext;
  producer: EngineId;
  experimentalQuality?: ExperimentalQualityProfile;
  state: QualityRoundState;
  buffered: boolean;
}): DurableQualityState | undefined {
  const experimentalRewrite = options.experimentalQuality?.mode === "rewrite"
    && (options.producer === "runtime" || options.producer === "stage");
  if (!options.runtime || (!options.buffered && !experimentalRewrite)) return undefined;
  const state = options.state;
  return {
    producer: options.producer,
    packId: options.runtime.packId,
    packVersion: options.runtime.packVersion,
    manifestSha256: options.runtime.manifestSha256,
    ruleVersion: options.runtime.ruleManifest.version,
    ruleSourceHash: options.runtime.ruleManifest.sourceHash,
    attempts: state.attempts,
    rejectedHashes: [...state.rejectedHashes],
    candidateParts: [...qualityDeliveryParts(state)],
    targets: durableQualityTargets(state.targets),
    ...(state.warningId ? { warningId: state.warningId } : {}),
    ...(state.warningTargetIds ? { warningTargetIds: [...state.warningTargetIds] } : {}),
    ...(state.candidate ? { candidate: state.candidate } : {}),
    ...(state.experimentalJudge ? { experimentalJudge: state.experimentalJudge } : {}),
  };
}

export function captureQualityArtifactResult(
  state: QualityRoundState,
  producer: EngineId,
  result: Pick<ToolResult, "callId" | "ok" | "fileEvent">,
): void {
  const target = qualityArtifactTargetFromResult(producer, result);
  if (target) upsertQualityArtifactTarget(state.targets, target);
}

export function retainBlockingArtifactTargets(
  state: QualityRoundState,
  result: BoundQualityEvaluation,
): void {
  if (!result.targetEvaluations) return;
  const unresolvedIds = new Set(result.targetEvaluations
    .filter((target) => target.evaluation.blockingFindings.length > 0 || target.warningReason)
    .map((target) => target.target.id));
  state.targets = state.targets.filter((target) => unresolvedIds.has(target.id));
}
