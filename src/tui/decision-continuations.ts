import { createEngineSwitchContinuation } from "./engine-switch-continuation";
import { createGateContinuation } from "./gate-continuation";
import { createPermissionContinuation } from "./permission-continuation";
import { createQualityDecisionContinuation } from "./quality-decision-continuation";
import type { DecisionContinuationOptions } from "./turn-controller-options";
import { createUserQuestionContinuation } from "./user-question-continuation";

export function createDecisionContinuations(options: DecisionContinuationOptions) {
  return {
    ...createQualityDecisionContinuation(options),
    ...createPermissionContinuation(options),
    ...createGateContinuation(options),
    ...createEngineSwitchContinuation(options),
    ...createUserQuestionContinuation(options),
  };
}
