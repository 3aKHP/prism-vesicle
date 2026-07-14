import { bootstrapTurn } from "./turn-bootstrap";
import { runLoop } from "./turn-loop";
import type { RunPromptOptions, RunPromptResult } from "./types";

export type { EngineId } from "../engine/profile";
export type { GateRequest, GateResolution } from "../gate/types";
export type {
  AgentLoopEvent,
  EngineSwitchConfirmedResult,
  ResolveEngineSwitchResult,
  RunPromptOptions,
  RunPromptResult,
  ValidatorOutcome,
} from "./types";
export { resolveEngineSwitch } from "./engine-switch-continuation";
export { resolveGate } from "./gate-continuation";
export { resolvePermission } from "./permission-continuation";
export { resumeQualityRewrite } from "./quality-continuation";
export { resolveUserQuestion } from "./user-question-continuation";

export async function runPrompt(options: RunPromptOptions): Promise<RunPromptResult> {
  return runLoop(await bootstrapTurn(options));
}
