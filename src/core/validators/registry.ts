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
  "character-card": { applies: isCharacterCard, run: validateCharacterCard },
  "scenario-card": { applies: isScenarioCard, run: validateScenarioCard },
  "runtime-packet": { applies: isRuntimePacket, run: validateRuntimePacket },
  "evaluate-report": { applies: isEvaluateReport, run: validateEvaluateReport },
};

/**
 * Module A body section headers (schema_character §3). Used only to recognize
 * character-card shape; the validator itself checks all seven are present.
 */
const MODULE_A_SECTIONS = [
  "## Visual Cortex",
  "## Biography",
  "## Cognitive Stack",
  "## Instinct Protocol",
  "## Persona Topology",
  "## Narrative Engine",
  "## World Context",
];

// Frontmatter key families that identify each card type. `name` is intentionally
// excluded from the character family (it is generic); a name-only card needs a
// Module A body section to be recognized as a character card.
const CHARACTER_KEYS = ["archetype", "age_gender", "inventory"];
const SCENARIO_KEYS = ["scenario_name", "world_state", "beat_map"];

/**
 * Leniently parse a leading `---` frontmatter block into its top-level keys and
 * the body that follows. Used for CLASSIFICATION (the `applies` predicates), so
 * it deliberately does not require a closing `---` fence: a card whose keys are
 * present but whose closing fence is missing must still be recognized, so the
 * validator gets to run and report the malformation. The strict closing-fence
 * requirement lives in `splitFrontmatter` (index.ts), which the validators use
 * to decide whether the frontmatter is well-formed.
 *
 * Non-card content is rejected by the `keys.size === 0` guard in the predicates:
 * a `---` Markdown horizontal rule over prose yields no `key:` lines.
 */
function parseFrontmatter(content: string): { keys: Set<string>; body: string } | null {
  const trimmed = content.trimStart();
  if (!trimmed.startsWith("---")) return null;
  const lines = trimmed.split(/\r?\n/);
  const keys = new Set<string>();
  let closeIndex = -1;
  for (let index = 1; index < lines.length; index++) {
    const line = lines[index].trim();
    if (line === "---") {
      closeIndex = index;
      break;
    }
    const colon = line.indexOf(":");
    if (colon > 0) keys.add(line.slice(0, colon).trim());
  }
  // With no closing fence, treat the whole post-`---` region as the body so
  // body-section signals (e.g. Module A sections) still work for classification.
  const bodyStart = closeIndex === -1 ? 1 : closeIndex + 1;
  return { keys, body: lines.slice(bodyStart).join("\n") };
}

/**
 * Top-level YAML keys from a leading frontmatter block (empty for content with
 * no real frontmatter, e.g. a `---`-led report).
 */
export function frontmatterKeys(content: string): Set<string> {
  return parseFrontmatter(content)?.keys ?? new Set();
}

/**
 * Recognize a Module A character card by shape, not by any single field the
 * validator is meant to diagnose: any character-family frontmatter key OR any
 * Module A body section suffices. So a card missing `archetype` still matches.
 */
function isCharacterCard(content: string): boolean {
  const fm = parseFrontmatter(content);
  if (!fm || fm.keys.size === 0) return false;
  return CHARACTER_KEYS.some((key) => fm.keys.has(key)) || MODULE_A_SECTIONS.some((section) => fm.body.includes(section));
}

/**
 * Recognize a Module B scenario card by shape: any scenario-family frontmatter
 * key. A card missing `scenario_name` but carrying `world_state`/`beat_map`
 * still matches.
 *
 * Unlike `isCharacterCard`, there is no body-section fallback: a Module B
 * card's distinctive structure is its frontmatter (`beat_map`/`world_state`),
 * whereas Module A's is its seven named body sections. A scenario card missing
 * all three family keys is not recognized; that is an extreme malformation that
 * is unlikely in practice, and a body heuristic (HTML-comment markers) would
 * risk re-admitting non-card content.
 */
function isScenarioCard(content: string): boolean {
  const fm = parseFrontmatter(content);
  if (!fm || fm.keys.size === 0) return false;
  return SCENARIO_KEYS.some((key) => fm.keys.has(key));
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

/**
 * The validator names whose `applies` predicate matches the content. Both the
 * turn-finalizer (auto-validation) and the artifact workbench (/validate) go
 * through this so the two paths cannot drift in which validators they run.
 */
export function applicableValidators(names: string[], content: string): string[] {
  return resolveValidators(names)
    .filter((validator) => validator.applies(content))
    .map((validator) => validator.name);
}

/**
 * Resolve, filter to applying validators, and run them in one step. Returns
 * undefined when no validator applies (so a `---`-led report or prose triggers
 * nothing). This is the single wired path used by both turn-finalizer and
 * workbench validation.
 */
export function validateContent(
  names: string[],
  content: string,
): { ok: boolean; results: Array<{ name: string; result: ValidationResult }> } | undefined {
  const applying = resolveValidators(names).filter((validator) => validator.applies(content));
  if (applying.length === 0) return undefined;
  return runValidators(applying, content);
}

export const knownValidatorNames: readonly ValidatorName[] = Object.keys(registry) as ValidatorName[];
