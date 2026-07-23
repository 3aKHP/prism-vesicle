import type { ValidationResult } from "./types";
import { findLeakedLSystemTags, makeValidationResult, splitFrontmatter } from "./document-structure";

type Beat = Record<string, string | undefined>;

export function validateScenarioCard(content: string): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const { yaml, body } = splitFrontmatter(content);
  if (!yaml) {
    errors.push("Module B: YAML frontmatter is missing or malformed.");
    return makeValidationResult(errors, warnings);
  }
  if (/l_system_level\s*:/.test(yaml)) errors.push('Module B: legacy field "l_system_level" must not appear; use tension_target values.');
  if (/Action Guide/i.test(yaml)) errors.push('Module B: legacy field "Action Guide" must not appear; use beat_map.');

  const worldStateMatch = /^world_state:\s*(.+)$/m.exec(yaml);
  if (!worldStateMatch) warnings.push('Module B: "world_state" is missing from frontmatter.');
  else if (worldStateMatch[1].includes("\n")) errors.push('Module B: "world_state" must be a single-line string.');

  const beats = parseBeatMap(yaml);
  if (beats === null) {
    errors.push("Module B: beat_map is missing from frontmatter.");
  } else {
    if (beats.length < 3 || beats.length > 5) errors.push(`Module B: beat_map must have 3–5 beats, found ${beats.length}.`);
    for (let index = 0; index < beats.length; index++) {
      const beat = beats[index];
      const missing = ["label", "tension_target", "variant_config", "pivot_condition"].filter(
        (field) => beat[field] === undefined || beat[field] === "",
      );
      if (missing.length > 0) {
        errors.push(`Module B: beat ${index + 1} is missing fields: ${missing.join(", ")}.`);
        continue;
      }
      const tension = Number(beat.tension_target);
      if (!Number.isInteger(tension) || tension < 0 || tension > 100) {
        errors.push(`Module B: beat "${beat.label}" has tension_target ${beat.tension_target} (must be integer 0–100).`);
      }
    }
    if (beats.length >= 2) {
      const tensions = beats.map((beat) => Number(beat.tension_target)).filter((value) => Number.isInteger(value));
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

  if (body.trim().length === 0) errors.push("Module B: body is empty; expected an opening paragraph.");
  if (!body.includes("<!--") || !body.includes("-->")) {
    warnings.push("Module B: HTML comment block (Scene Premise / Neural State / User Role) is missing.");
  }
  for (const tag of findLeakedLSystemTags(content)) errors.push(`Module B: L-System tag "${tag}" leaked into output.`);
  return makeValidationResult(errors, warnings);
}

function parseBeatMap(yaml: string): Beat[] | null {
  const startMatch = /^beat_map:\s*$/m.exec(yaml);
  if (!startMatch) return null;
  const afterKey = yaml.slice(startMatch.index + startMatch[0].length);
  const endMatch = /\n(?=[A-Za-z_][A-Za-z0-9_]*:)/.exec(afterKey);
  const block = endMatch ? afterKey.slice(0, endMatch.index) : afterKey;
  const beats: Beat[] = [];
  let current: Beat | null = null;
  for (const rawLine of block.split("\n")) {
    if (rawLine.trim() === "") continue;
    const itemMatch = /^\s*-\s+(.*)$/.exec(rawLine);
    const fieldMatch = /^\s+([A-Za-z_][A-Za-z0-9_]*):\s*(.*)$/.exec(rawLine);
    if (itemMatch) {
      current = {};
      beats.push(current);
      const inline = /^([A-Za-z_][A-Za-z0-9_]*):\s*(.*)$/.exec(itemMatch[1]);
      if (inline) current[inline[1]] = unquote(inline[2]);
    } else if (fieldMatch && current) {
      current[fieldMatch[1]] = unquote(fieldMatch[2]);
    }
  }
  return beats;
}

function unquote(value: string): string {
  const trimmed = value.trim();
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}
