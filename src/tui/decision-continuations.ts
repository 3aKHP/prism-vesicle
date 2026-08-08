import { createEngineSwitchContinuation } from "./engine-switch-continuation";
import { createGateContinuation } from "./gate-continuation";
import { createPermissionContinuation } from "./permission-continuation";
import { createQualityDecisionContinuation } from "./quality-decision-continuation";
import type { RunPromptResult } from "../core/agent-loop/run";
import type { QueuedWorkController } from "./queued-work-controller";
import type { PermissionContext, TurnAgentPort, TurnDecisionPort, TurnHostActionPort, TurnRuntimePort, TurnSessionPort, TurnTranscriptPort, TurnUsagePort, TurnRunCancellable } from "./turn-controller-options";
import { createUserQuestionContinuation } from "./user-question-continuation";
import type { resolveQualityDecision as resolveQualityDecisionImport } from "../core/agent-loop/run";

/**
 * The continuation composition bundle: the named turn ports plus the
 * execution handles `createTurnController` synthesizes. Each continuation
 * factory declares its own port slices below, so no factory depends on the
 * full options bag; this module only wires the slices.
 */
export type DecisionContinuationBundle = {
  runtime: TurnRuntimePort;
  session: TurnSessionPort;
  transcript: TurnTranscriptPort;
  decision: TurnDecisionPort;
  agent: TurnAgentPort;
  usage: TurnUsagePort;
  hostAction: TurnHostActionPort;
  queuedWork: QueuedWorkController;
  runCancellable: TurnRunCancellable;
  handleResult: (result: RunPromptResult) => void;
  handleInterruptedTurn: () => void;
  reportError: (error: unknown) => void;
  permissionContext: () => PermissionContext;
  resolveQualityDecision?: typeof resolveQualityDecisionImport;
};

export function createDecisionContinuations(bundle: DecisionContinuationBundle) {
  return {
    ...createQualityDecisionContinuation(bundle),
    ...createPermissionContinuation(bundle),
    ...createGateContinuation(bundle),
    ...createEngineSwitchContinuation(bundle),
    ...createUserQuestionContinuation(bundle),
  };
}
