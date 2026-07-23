import type { ExperimentalQualityProfile } from "../../config/quality";
import type { VesicleResponse } from "../../providers/shared/types";
import type { EngineId } from "../engine/profile";
import {
  evaluateBoundQuality,
  evaluateBoundQualityTargets,
  isQualityArtifactMutationCall,
  isQualityBoundary,
  observeBoundQualityWithJudge,
  qualityModeForEngine,
  readQualityArtifactTargets,
  type BoundQualityEvaluation,
  type QualityRuntimeContext,
} from "../quality";
import type { AgentLoopEvent } from "./types";
import { qualityDeliveryParts, qualityFindingCount, type QualityRoundState } from "./quality-round-state";

export async function evaluateQualityRoundBoundary(options: {
  rootDir: string;
  runtime?: QualityRuntimeContext;
  producer: EngineId;
  experimentalQuality?: ExperimentalQualityProfile;
  response: VesicleResponse;
  phase: "before-mutations" | "after-mutations";
  state: QualityRoundState;
  signal?: AbortSignal;
  onEvent?: (event: AgentLoopEvent) => void;
}): Promise<BoundQualityEvaluation | undefined> {
  if (!options.runtime || !isQualityBoundary(options.response)) return undefined;
  const hasArtifactMutation = (options.response.toolCalls ?? [])
    .some((call) => isQualityArtifactMutationCall(call, options.producer));
  if ((options.phase === "before-mutations" && hasArtifactMutation)
    || (options.phase === "after-mutations" && !hasArtifactMutation)) return undefined;
  const mode = qualityModeForEngine(options.runtime, options.producer);
  if (mode === "off" || mode === "analyze") return undefined;
  options.onEvent?.({ type: "quality_status", phase: "checking", attempt: options.state.attempts, findingCount: 0 });
  const deterministic = options.state.targets.length > 0
    ? evaluateBoundQualityTargets({
      runtime: options.runtime,
      producer: options.producer,
      mode,
      targets: await readQualityArtifactTargets(options.rootDir, options.state.targets),
      attempt: options.state.attempts,
      state: options.state,
      usage: options.response.usage,
    })
    : evaluateBoundQuality({
      runtime: options.runtime,
      producer: options.producer,
      mode,
      content: qualityDeliveryParts(options.state).join("\n\n"),
      attempt: options.state.attempts,
      state: options.state,
      usage: options.response.usage,
    });
  if (!deterministic) return undefined;
  const result = await observeBoundQualityWithJudge({
    result: deterministic,
    runtime: options.runtime,
    experimentalProfile: options.experimentalQuality,
    state: options.state,
    signal: options.signal,
  });
  if (result.event.experimentalJudge) options.state.experimentalJudge = result.event.experimentalJudge;
  options.state.lastResult = { outcome: result.outcome, findingCount: qualityFindingCount(result) };
  return result;
}
