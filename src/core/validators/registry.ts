import { validateCharacterCard, validateScenarioCard } from "./index";
import type { ValidationResult, ValidatorName } from "./index";

export type { ValidationResult, ValidatorName } from "./index";

/**
 * Registry mapping validator names (as declared in engine profiles) to their
 * implementation. A profile that names an unknown validator fails loudly at
 * turn time via resolveValidators — same principle as tool resolution.
 *
 * Validators are pure functions over content strings; they do not touch the
 * filesystem. The caller decides what content to feed them.
 */
const registry: Record<string, (content: string) => ValidationResult> = {
  "character-card": validateCharacterCard,
  "scenario-card": validateScenarioCard,
};

export function resolveValidators(names: string[]): Array<{ name: string; run: (content: string) => ValidationResult }> {
  const resolved: Array<{ name: string; run: (content: string) => ValidationResult }> = [];
  for (const name of names) {
    const run = registry[name];
    if (!run) {
      throw new Error(
        `Unknown validator "${name}". Known validators: ${Object.keys(registry).join(", ")}.`,
      );
    }
    resolved.push({ name, run });
  }
  return resolved;
}

/**
 * Run every resolved validator against the content and merge results.
 * Returns per-validator detail plus an aggregate ok flag.
 *
 * A merged result is 'ok' only if every validator passed with zero errors.
 * Warnings do not affect the aggregate.
 */
export function runValidators(
  validators: Array<{ name: string; run: (content: string) => ValidationResult }>,
  content: string,
): { ok: boolean; results: Array<{ name: string; result: ValidationResult }> } {
  const results = validators.map((validator) => ({
    name: validator.name,
    result: validator.run(content),
  }));
  return {
    ok: results.every((entry) => entry.result.ok),
    results,
  };
}

export const knownValidatorNames: readonly ValidatorName[] = Object.keys(registry) as ValidatorName[];
