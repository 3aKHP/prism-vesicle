import type { ValidationResult } from "./types";
import { artifactLanguagePolicyWarnings } from "./artifact-language-policy";
import {
  duplicateTopLevelYamlKeys,
  findLeakedLSystemTags,
  isNonEmptyString,
  isYamlMapping,
  makeValidationResult,
  parseYamlMapping,
  splitFrontmatter,
  type YamlMapping,
} from "./document-structure";

const YAML_ALLOWED_FIELDS = new Set(["scenario_name", "tags", "world_state", "beat_map"]);
const BEAT_FIELDS = ["label", "tension_target", "variant_config", "pivot_condition"] as const;

export function validateScenarioCard(content: string): ValidationResult {
  const errors: string[] = [];
  const warnings = artifactLanguagePolicyWarnings("Module B", content);
  const { yaml, body } = splitFrontmatter(content);
  if (!yaml) {
    errors.push("Module B: YAML frontmatter is missing or malformed.");
    return makeValidationResult(errors, warnings);
  }
  const parsed = parseYamlMapping(yaml);
  if (!parsed.value) {
    errors.push(`Module B: YAML ${parsed.error}`);
    return makeValidationResult(errors, warnings);
  }
  for (const field of Object.keys(parsed.value)) {
    if (!YAML_ALLOWED_FIELDS.has(field)) errors.push(`Module B: YAML frontmatter field "${field}" is not allowed.`);
  }
  for (const field of duplicateTopLevelYamlKeys(yaml)) {
    errors.push(`Module B: YAML frontmatter field "${field}" is duplicated.`);
  }
  for (const duplicate of duplicateBeatFields(yaml)) {
    errors.push(`Module B: beat ${duplicate.beat} field "${duplicate.field}" is duplicated.`);
  }

  validateRequiredString(parsed.value, "scenario_name", errors);
  validateTags(parsed.value.tags, errors);
  if (!isNonEmptyString(parsed.value.world_state)) {
    errors.push('Module B: YAML field "world_state" must be a non-empty string.');
  } else if (!hasInlineSingleLineWorldState(yaml) || /[\r\n]/.test(parsed.value.world_state)) {
    errors.push('Module B: "world_state" must be an ordinary single-line string.');
  }

  const beats = parsed.value.beat_map;
  if (!Array.isArray(beats)) {
    errors.push("Module B: beat_map must be a YAML list.");
  } else {
    if (beats.length < 3 || beats.length > 5) errors.push(`Module B: beat_map must have 3–5 beats, found ${beats.length}.`);
    for (let index = 0; index < beats.length; index++) {
      const beat = beats[index];
      if (!isYamlMapping(beat)) {
        errors.push(`Module B: beat ${index + 1} must be a YAML mapping.`);
        continue;
      }
      const unknown = Object.keys(beat).filter((field) => !BEAT_FIELDS.includes(field as typeof BEAT_FIELDS[number]));
      if (unknown.length > 0) errors.push(`Module B: beat ${index + 1} has unknown fields: ${unknown.join(", ")}.`);
      const missing = BEAT_FIELDS.filter((field) => !(field in beat));
      if (missing.length > 0) {
        errors.push(`Module B: beat ${index + 1} is missing fields: ${missing.join(", ")}.`);
        continue;
      }
      for (const field of ["label", "variant_config", "pivot_condition"] as const) {
        if (!isNonEmptyString(beat[field])) errors.push(`Module B: beat ${index + 1} field "${field}" must be a non-empty string.`);
      }
      const tension = beat.tension_target;
      if (!Number.isInteger(tension) || (tension as number) < 0 || (tension as number) > 100) {
        errors.push(`Module B: beat "${beat.label}" has tension_target ${beat.tension_target} (must be integer 0–100).`);
      }
    }
    if (beats.length >= 2) {
      const tensions = beats
        .filter(isYamlMapping)
        .map((beat) => beat.tension_target)
        .filter((value): value is number => Number.isInteger(value));
      let hasDescentOrStall = false;
      for (let index = 1; index < tensions.length; index++) {
        if (tensions[index] <= tensions[index - 1]) {
          hasDescentOrStall = true;
          break;
        }
      }
      if (!hasDescentOrStall) warnings.push("Module B: tension trajectory is strictly monotonic; at least one beat should descend or stall.");
    }
  }

  validateScenarioBody(body, errors);
  for (const tag of findLeakedLSystemTags(content)) errors.push(`Module B: L-System tag "${tag}" leaked into output.`);
  return makeValidationResult(errors, warnings);
}

function validateRequiredString(mapping: YamlMapping, field: string, errors: string[]): void {
  if (!(field in mapping)) errors.push(`Module B: required YAML field "${field}" is missing.`);
  else if (!isNonEmptyString(mapping[field])) errors.push(`Module B: YAML field "${field}" must be a non-empty string.`);
}

function validateTags(value: unknown, errors: string[]): void {
  if (!Array.isArray(value) || value.length === 0 || value.some((tag) => !isNonEmptyString(tag))) {
    errors.push('Module B: YAML field "tags" must be a non-empty list of strings.');
  }
}

function hasInlineSingleLineWorldState(yaml: string): boolean {
  const lines = yaml.split("\n");
  const index = lines.findIndex((line) => /^world_state:/.test(line));
  if (index < 0) return false;
  const value = lines[index]!.slice(lines[index]!.indexOf(":") + 1).trim();
  if (!value || /^[|>][-+]?$/.test(value)) return false;
  for (let cursor = index + 1; cursor < lines.length; cursor++) {
    if (!lines[cursor]!.trim()) continue;
    return !/^[ \t]+/.test(lines[cursor]!);
  }
  return true;
}

function duplicateBeatFields(yaml: string): Array<{ beat: number; field: string }> {
  const duplicates: Array<{ beat: number; field: string }> = [];
  let inBeatMap = false;
  let beat = 0;
  let fields = new Set<string>();
  for (const line of yaml.split("\n")) {
    if (/^beat_map:\s*$/.test(line)) {
      inBeatMap = true;
      continue;
    }
    if (!inBeatMap) continue;
    if (/^[A-Za-z_][A-Za-z0-9_]*:/.test(line)) break;
    const item = /^\s*-\s+([A-Za-z_][A-Za-z0-9_]*):/.exec(line);
    if (item) {
      beat += 1;
      fields = new Set([item[1]]);
      continue;
    }
    const field = /^\s+([A-Za-z_][A-Za-z0-9_]*):/.exec(line)?.[1];
    if (!field || beat === 0) continue;
    if (fields.has(field)) duplicates.push({ beat, field });
    fields.add(field);
  }
  return duplicates;
}

function validateScenarioBody(body: string, errors: string[]): void {
  const open = body.indexOf("<!--");
  const close = open < 0 ? -1 : body.indexOf("-->", open + 4);
  const visibleOpening = (open < 0 ? body : body.slice(0, open)).trim();
  if (!visibleOpening) errors.push("Module B: visible opening paragraph is empty.");
  if (open < 0 || close < 0) {
    errors.push("Module B: complete HTML comment block is missing.");
    return;
  }
  const comment = body.slice(open + 4, close);
  const headings = ["## Scene Premise", "## Neural State", "## User Role"];
  let previous = -1;
  for (let index = 0; index < headings.length; index++) {
    const heading = headings[index]!;
    const matches = [...comment.matchAll(new RegExp(`^${heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*$`, "gm"))];
    if (matches.length !== 1) {
      errors.push(`Module B: HTML comment must contain exactly one "${heading}" section.`);
      continue;
    }
    const start = matches[0]!.index;
    if (start <= previous) errors.push(`Module B: HTML comment section "${heading}" is out of order.`);
    previous = start;
    const contentStart = start + matches[0]![0].length;
    const nextHeading = headings[index + 1];
    const contentEnd = nextHeading ? comment.indexOf(nextHeading, contentStart) : comment.length;
    if (contentEnd >= 0 && !comment.slice(contentStart, contentEnd).trim()) {
      errors.push(`Module B: HTML comment section "${heading}" is empty.`);
    }
  }
}
