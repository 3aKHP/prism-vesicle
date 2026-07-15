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

/**
 * L-System tags are production-layer working language that must never appear
 * in deployed Module A / Module B artifacts. The full set from schema §5.
 */
// L-System tags that must never appear in deployed artifacts. Bare L4 is
// omitted because the schema's L4 family is L4-A / L4-B; including L4 would
// double-report any "L4-A" leak (CR N2). L1 / L2 / L5 are standalone layer
// names that do appear as tags; L3 only exists as L3-A / L3-B.
const LSYSTEM_TAGS = [
  "L1",
  "L2",
  "L3-A",
  "L3-B",
  "L4-A",
  "L4-B",
  "L5",
];

/**
 * Find L-System tags that leaked into output. Matches word-boundary tag forms
 * like "L3-A" but not legitimate substrings like "L3" inside a longer token.
 * We look for the tag preceded by a non-alphanumeric and followed by a
 * non-alphanumeric (or end of string), so "FL5" or "L3-AC" do not trip.
 */
function findLeakedLSystemTags(content: string): string[] {
  const found: string[] = [];
  for (const tag of LSYSTEM_TAGS) {
    const escaped = tag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const pattern = new RegExp(`(^|[^A-Za-z0-9])${escaped}([^A-Za-z0-9]|$)`);
    if (pattern.test(content)) {
      found.push(tag);
    }
  }
  return found;
}

/**
 * Extract the YAML frontmatter block (between leading `---` fences) and the
 * Markdown body that follows it. Returns nulls when no frontmatter is present.
 */
function splitFrontmatter(content: string): { yaml: string | null; body: string } {
  // Normalise CRLF -> LF first. The beat_map and section parsers split on \n
  // and use line-anchored regexes; trailing \r on Windows-authored files
  // would otherwise make (.*)$ fail to match and silently empty the parse.
  const source = content.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const trimmed = source.replace(/^\s+/, "");
  if (!trimmed.startsWith("---")) {
    return { yaml: null, body: source };
  }
  const end = trimmed.indexOf("\n---", 3);
  if (end === -1) {
    return { yaml: null, body: source };
  }
  const yaml = trimmed.slice(3, end).trim();
  const body = trimmed.slice(end + 4).replace(/^\s+/, "");
  return { yaml, body };
}

function makeResult(errors: string[], warnings: string[] = []): ValidationResult {
  return { ok: errors.length === 0, errors, warnings };
}

// --- Module A: Compact Character Card --------------------------------------

const MODULE_A_REQUIRED_SECTIONS = [
  "## Visual Cortex",
  "## Biography",
  "## Cognitive Stack",
  "## Instinct Protocol",
  "## Persona Topology",
  "## Narrative Engine",
  "## World Context",
];

const MODULE_A_YAML_ALLOWED_FIELDS = new Set(["name", "archetype", "age_gender", "inventory"]);

/**
 * Validate a Module A character card against schema_character.md §3.
 *
 * Checks:
 * 1. YAML frontmatter present and contains only the four allowed fields.
 * 2. All seven body sections present.
 * 3. Persona Topology has the three mandatory subsections.
 * 4. At least two Invariant Axes.
 * 5. At least three Variant Axes, one describing a positive shift direction.
 * 6. Hard limit present in Boundary Conditions.
 * 7. No L-System tags anywhere.
 */
export function validateCharacterCard(content: string): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  const { yaml, body } = splitFrontmatter(content);
  if (!yaml) {
    errors.push("Module A: YAML frontmatter is missing or malformed (expected leading --- block).");
    return makeResult(errors, warnings);
  }

  // Allowed-fields check. We scan `key:` lines at the start of a line.
  const yamlLines = yaml.split("\n");
  const seenFields = new Set<string>();
  for (const line of yamlLines) {
    const match = /^([A-Za-z_][A-Za-z0-9_]*):/.exec(line);
    if (match) {
      seenFields.add(match[1]);
    }
  }
  for (const field of seenFields) {
    if (!MODULE_A_YAML_ALLOWED_FIELDS.has(field)) {
      errors.push(`Module A: YAML frontmatter field "${field}" is not allowed. Permitted fields: ${[...MODULE_A_YAML_ALLOWED_FIELDS].join(", ")}.`);
    }
  }
  for (const required of MODULE_A_YAML_ALLOWED_FIELDS) {
    if (!seenFields.has(required)) {
      warnings.push(`Module A: recommended YAML field "${required}" is missing.`);
    }
  }

  // Required sections.
  const missingSections = MODULE_A_REQUIRED_SECTIONS.filter((section) => !body.includes(section));
  for (const section of missingSections) {
    errors.push(`Module A: missing mandatory section ${section}.`);
  }

  // Persona Topology subsections.
  if (body.includes("## Persona Topology")) {
    for (const sub of ["### Invariant Axes", "### Variant Axes", "### Boundary Conditions"]) {
      if (!body.includes(sub)) {
        errors.push(`Module A: Persona Topology is missing subsection ${sub}.`);
      }
    }

    const invariantCount = countListItemsUnder(body, "### Invariant Axes");
    if (invariantCount !== null && invariantCount < 2) {
      errors.push(`Module A: Invariant Axes must have at least two entries, found ${invariantCount}.`);
    }

    const variantBlock = sliceSection(body, "### Variant Axes", "### Boundary Conditions");
    const variantCount = variantBlock ? countListItems(variantBlock) : 0;
    if (variantCount !== null && variantCount < 3) {
      errors.push(`Module A: Variant Axes must have at least three entries, found ${variantCount}.`);
    }
    // Positive shift direction: at least one variant axis should mention a
    // softening/opening/warmth direction, not only suppression.
    if (variantBlock) {
      // Look for vocabulary that describes a *positive* shift direction —
      // something opening, softening, or becoming accessible under tension,
      // not just nouns like "trust" (which "trust evaporates" also contains).
      // We match verbs/adjectives of opening/softening, plus the explicit
      // Chinese shift-toward-warmth phrasing.
      const positivePattern = /\b(softens?|soften|opens?|opening|warms?|warmth|becomes accessible|becomes reachable|gentler|tender|relaxes?|humor surfaces|genuine connection)\b|(变得可达|变得可触及|软化|开放|松弛|幽默浮现|真诚连接|亲近)/i;
      if (!positivePattern.test(variantBlock)) {
        warnings.push("Module A: no Variant Axis describes a positive (opening/softening) shift direction. At least one is recommended.");
      }
    }
  }

  // Boundary Conditions: Hard limit is mandatory.
  if (body.includes("### Boundary Conditions")) {
    if (!/hard limit/i.test(body) && !/硬限制|硬边界|绝不会|绝不做/i.test(body)) {
      warnings.push('Module A: Boundary Conditions should state a "Hard limit" the character will never cross.');
    }
  }

  const leaked = findLeakedLSystemTags(content);
  for (const tag of leaked) {
    errors.push(`Module A: L-System tag "${tag}" leaked into output. These are production-layer only.`);
  }

  return makeResult(errors, warnings);
}

// --- Module B: Compact Scenario Card ---------------------------------------

/**
 * Validate a Module B scenario card against schema_scenario.md §4.
 *
 * Checks:
 * 1. YAML frontmatter present.
 * 2. beat_map exists with 3–5 beats.
 * 3. Each beat has label, tension_target, variant_config, pivot_condition.
 * 4. tension_target values are integers 0–100.
 * 5. Tension trajectory is not strictly monotonic (at least one descent/stall).
 * 6. world_state is a single-line string.
 * 7. Opening paragraph present in the body.
 * 8. HTML comment block with the three subsections present.
 * 9. No L-System tags, no legacy Action Guide / l_system_level fields.
 */
export function validateScenarioCard(content: string): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  const { yaml, body } = splitFrontmatter(content);
  if (!yaml) {
    errors.push("Module B: YAML frontmatter is missing or malformed.");
    return makeResult(errors, warnings);
  }

  // Legacy field rejection.
  if (/l_system_level\s*:/.test(yaml)) {
    errors.push('Module B: legacy field "l_system_level" must not appear; use tension_target values.');
  }
  if (/Action Guide/i.test(yaml)) {
    errors.push('Module B: legacy field "Action Guide" must not appear; use beat_map.');
  }

  // world_state single-line.
  const worldStateMatch = /^world_state:\s*(.+)$/m.exec(yaml);
  if (!worldStateMatch) {
    warnings.push('Module B: "world_state" is missing from frontmatter.');
  } else if (worldStateMatch[1].includes("\n")) {
    errors.push('Module B: "world_state" must be a single-line string.');
  }

  // Beat map.
  const beats = parseBeatMap(yaml);
  if (beats === null) {
    errors.push("Module B: beat_map is missing from frontmatter.");
  } else {
    if (beats.length < 3 || beats.length > 5) {
      errors.push(`Module B: beat_map must have 3–5 beats, found ${beats.length}.`);
    }
    for (let i = 0; i < beats.length; i++) {
      const beat = beats[i];
      const missing = ["label", "tension_target", "variant_config", "pivot_condition"].filter(
        (field) => beat[field] === undefined || beat[field] === "",
      );
      if (missing.length > 0) {
        errors.push(`Module B: beat ${i + 1} is missing fields: ${missing.join(", ")}.`);
        continue;
      }
      const tension = Number(beat.tension_target);
      if (!Number.isInteger(tension) || tension < 0 || tension > 100) {
        errors.push(`Module B: beat "${beat.label}" has tension_target ${beat.tension_target} (must be integer 0–100).`);
      }
    }

    // Tension trajectory: not strictly monotonic increasing.
    if (beats.length >= 2) {
      const tensions = beats.map((b) => Number(b.tension_target)).filter((n) => Number.isInteger(n));
      let hasDescentOrStall = false;
      for (let i = 1; i < tensions.length; i++) {
        if (tensions[i] <= tensions[i - 1]) {
          hasDescentOrStall = true;
          break;
        }
      }
      if (!hasDescentOrStall) {
        warnings.push("Module B: tension trajectory is strictly monotonic; at least one beat should descend or stall.");
      }
    }
  }

  // Body: opening paragraph + HTML comment.
  if (body.trim().length === 0) {
    errors.push("Module B: body is empty; expected an opening paragraph.");
  }
  if (!body.includes("<!--") || !body.includes("-->")) {
    warnings.push("Module B: HTML comment block (Scene Premise / Neural State / User Role) is missing.");
  }

  const leaked = findLeakedLSystemTags(content);
  for (const tag of leaked) {
    errors.push(`Module B: L-System tag "${tag}" leaked into output.`);
  }

  return makeResult(errors, warnings);
}

// --- Runtime Engine: three-part turn packet --------------------------------

const RUNTIME_HUD_MARKERS = ["[Beat]", "[Tension]", "[Char]", "[Scene]", "[Turn]"];
const RUNTIME_NEURAL_CHAIN_FIELDS = ["Perception", "Instinct", "State", "Decision"];

/**
 * Validate a Runtime engine turn packet against the three-part format declared
 * in assets/prompts/engines/runtime.md: an HTML-comment Hidden Neural Chain, a
 * five-line Dynamic HUD, and prose. The runtime output contract is owned by the
 * mother project (Neural-Narratology), so this is a thin structural MVP over
 * the format the current prompt emits; it will be tightened when prompts are
 * rewritten.
 *
 * Checks:
 * 1. Hidden Neural Chain block carries the [!Neural Chain] header.
 * 2. All five Dynamic HUD line markers are present.
 * 3. Neural Chain reasoning fields are present (advisory).
 * 4. No L-System tag leak anywhere in the packet.
 */
export function validateRuntimePacket(content: string): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (!content.includes("[!Neural Chain]")) {
    errors.push("Runtime: Hidden Neural Chain block ([!Neural Chain]) is missing.");
  }
  for (const field of RUNTIME_NEURAL_CHAIN_FIELDS) {
    if (!content.includes(`${field}:`)) {
      warnings.push(`Runtime: Neural Chain field "${field}:" is missing.`);
    }
  }

  for (const marker of RUNTIME_HUD_MARKERS) {
    if (!content.includes(marker)) {
      errors.push(`Runtime: Dynamic HUD is missing line marker ${marker}.`);
    }
  }

  const leaked = findLeakedLSystemTags(content);
  for (const tag of leaked) {
    errors.push(`Runtime: L-System tag "${tag}" leaked into the packet.`);
  }

  return makeResult(errors, warnings);
}

// --- Evaluate Engine: audit report -----------------------------------------

const EVALUATE_REPORT_SECTIONS = [
  "## 1. Executive Summary",
  "## 2. Dimension Scores",
  "## 3. Detailed Findings",
  "## 4. Issue List",
  "## 5. Optimization Recommendations",
];

/**
 * Validate an Evaluate engine audit report against the structure declared in
 * assets/prompts/engines/evaluate.md: an Overall Verdict (PASS / CONDITIONAL /
 * FAIL) and five numbered report sections. The report's content contract is
 * owned by the mother project (Neural-Narratology); this is a thin structural
 * MVP.
 *
 * Note: the Evaluate prompt writes the report to reports/audit_*.md. This
 * validator runs only on assistant content emitted inline; if the model only
 * writes the file and returns a short summary, validation stays silent.
 * L-System terms are intentionally not flagged here because an audit may
 * reference them legitimately in its findings.
 */
export function validateEvaluateReport(content: string): ValidationResult {
  const errors: string[] = [];

  if (!/\*\*Overall Verdict:\*\*\s*(PASS|CONDITIONAL|FAIL)/i.test(content)) {
    errors.push('Evaluate: missing "**Overall Verdict:**" line with PASS / CONDITIONAL / FAIL.');
  }

  for (const section of EVALUATE_REPORT_SECTIONS) {
    if (!content.includes(section)) {
      errors.push(`Evaluate: missing report section "${section}".`);
    }
  }

  return makeResult(errors, []);
}

type Beat = Record<string, string | undefined>;

/**
 * Parse a beat_map block from YAML frontmatter. Returns null when no
 * beat_map key is present. This is a narrow parser that handles the
 * schema's block-list shape (label / tension_target / variant_config /
 * pivot_condition per beat); it deliberately does not implement YAML
 * generally.
 */
function parseBeatMap(yaml: string): Beat[] | null {
  const startMatch = /^beat_map:\s*$/m.exec(yaml);
  if (!startMatch) return null;
  const afterKey = yaml.slice(startMatch.index + startMatch[0].length);
  // Stop at the next top-level key (a line starting with a non-space char
  // followed by a colon) or end of string.
  const endMatch = /\n(?=[A-Za-z_][A-Za-z0-9_]*:)/.exec(afterKey);
  const block = endMatch ? afterKey.slice(0, endMatch.index) : afterKey;

  const beats: Beat[] = [];
  let current: Beat | null = null;
  for (const rawLine of block.split("\n")) {
    if (rawLine.trim() === "") continue;
    const itemMatch = /^\s*-\s+(.*)$/.exec(rawLine);
    const fieldMatch = /^\s+([A-Za-z_][A-Za-z0-9_]*):\s*(.*)$/.exec(rawLine);
    if (itemMatch) {
      // A list item that starts a new beat. The remainder may carry an
      // inline field (e.g. "- label: Arrival").
      current = {};
      beats.push(current);
      const inline = /^([A-Za-z_][A-Za-z0-9_]*):\s*(.*)$/.exec(itemMatch[1]);
      if (inline) {
        current[inline[1]] = unquote(inline[2]);
      }
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

function sliceSection(body: string, startHeader: string, endHeader: string): string | null {
  const start = body.indexOf(startHeader);
  if (start === -1) return null;
  const end = body.indexOf(endHeader, start + startHeader.length);
  return end === -1 ? body.slice(start) : body.slice(start, end);
}

function countListItems(block: string): number {
  const matches = block.match(/^\s*[-*]\s+/gm);
  return matches ? matches.length : 0;
}

function countListItemsUnder(body: string, header: string): number | null {
  const start = body.indexOf(header);
  if (start === -1) return null;
  const after = body.slice(start + header.length);
  // Stop at the next ### or ## header.
  const endMatch = /\n#{2,3}\s/.exec(after);
  const section = endMatch ? after.slice(0, endMatch.index) : after;
  return countListItems(section);
}
