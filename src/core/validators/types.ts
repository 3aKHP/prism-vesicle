export type ValidationResult = {
  ok: boolean;
  warnings: string[];
  errors: string[];
};

export type ValidatorName = "character-card" | "scenario-card" | "runtime-packet" | "evaluate-report";
