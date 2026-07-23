export type ValidationResult = {
  ok: boolean;
  warnings: string[];
  errors: string[];
};

export type ValidatorName = "character-card" | "scenario-card" | "runtime-packet" | "evaluate-report";

export function validateM0Output(content: string): ValidationResult {
  return {
    ok: content.trim().length > 0,
    warnings: [],
    errors: content.trim().length > 0 ? [] : ["Output is empty."],
  };
}

export { validateCharacterCard } from "./character-card";
export { validateScenarioCard } from "./scenario-card";
export { validateRuntimePacket } from "./runtime-packet";
export { validateEvaluateReport } from "./evaluate-report";
