import { validateCharacterCard, validateScenarioCard, validateRuntimePacket, validateEvaluateReport } from "./index";
import type { ValidationResult, ValidatorName } from "./index";

export type { ValidationResult, ValidatorName } from "./index";

/**
 * Registry mapping validator names (as declared in engine profiles) to their
 * implementation. A profile that names an unknown validator fails loudly at
 * turn time via resolveValidators — same principle as tool resolution.
 *
 * Each entry also declares an `applies` predicate that recognizes the content
 * shape the validator targets. The agent loop runs a profile's validators only
 * when at least one of them `applies` to the assistant content, so ordinary
 * phase-transition prose is not reported as a schema failure and each engine's
 * validator stays silent on content it does not recognize.
 *
 * Validators are pure functions over content strings; they do not touch the
 * filesystem. The caller decides what content to feed them.
 */
type ValidatorEntry = {
  applies: (content: string) => boolean;
  run: (content: string) => ValidationResult;
};

const registry: Record<string, ValidatorEntry> = {
  "character-card": { applies: isFrontmatterArtifact, run: validateCharacterCard },
  "scenario-card": { applies: isFrontmatterArtifact, run: validateScenarioCard },
  "runtime-packet": { applies: isRuntimePacket, run: validateRuntimePacket },
  "evaluate-report": { applies: isEvaluateReport, run: validateEvaluateReport },
};

function isFrontmatterArtifact(content: string): boolean {
  // ETL cards carry YAML frontmatter; ordinary phase-transition prose does not.
  return content.trimStart().startsWith("---");
}

function isRuntimePacket(content: string): boolean {
  // A runtime turn emits the three-part packet inline: a Hidden Neural Chain
  // (HTML comment) and a five-line [Beat]/[Tension]/... Dynamic HUD.
  return content.includes("[!Neural Chain]") || content.includes("[Beat]");
}

function isEvaluateReport(content: string): boolean {
  // The audit report is emitted inline with a Neuro-Integrity heading and an
  // Overall Verdict. If the model only writes reports/audit_*.md and returns a
  // short summary, this stays false and validation is skipped (advisory only).
  return /Neuro-Integrity Report|Overall Verdict/i.test(content);
}

export function resolveValidators(
  names: string[],
): Array<{ name: string; applies: (content: string) => boolean; run: (content: string) => ValidationResult }> {
  const resolved: Array<{ name: string; applies: (content: string) => boolean; run: (content: string) => ValidationResult }> = [];
  for (const name of names) {
    const entry = registry[name];
    if (!entry) {
      throw new Error(
        `Unknown validator "${name}". Known validators: ${Object.keys(registry).join(", ")}.`,
      );
    }
    resolved.push({ name, applies: entry.applies, run: entry.run });
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
