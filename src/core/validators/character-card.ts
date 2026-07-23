import type { ValidationResult } from "./index";
import {
  countListItems,
  countListItemsUnder,
  findLeakedLSystemTags,
  makeValidationResult,
  sliceSection,
  splitFrontmatter,
} from "./document-structure";

const REQUIRED_SECTIONS = [
  "## Visual Cortex",
  "## Biography",
  "## Cognitive Stack",
  "## Instinct Protocol",
  "## Persona Topology",
  "## Narrative Engine",
  "## World Context",
];
const YAML_ALLOWED_FIELDS = new Set(["name", "archetype", "age_gender", "inventory"]);

export function validateCharacterCard(content: string): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const { yaml, body } = splitFrontmatter(content);
  if (!yaml) {
    errors.push("Module A: YAML frontmatter is missing or malformed (expected leading --- block).");
    return makeValidationResult(errors, warnings);
  }

  const seenFields = new Set<string>();
  for (const line of yaml.split("\n")) {
    const match = /^([A-Za-z_][A-Za-z0-9_]*):/.exec(line);
    if (match) seenFields.add(match[1]);
  }
  for (const field of seenFields) {
    if (!YAML_ALLOWED_FIELDS.has(field)) {
      errors.push(`Module A: YAML frontmatter field "${field}" is not allowed. Permitted fields: ${[...YAML_ALLOWED_FIELDS].join(", ")}.`);
    }
  }
  for (const required of YAML_ALLOWED_FIELDS) {
    if (!seenFields.has(required)) warnings.push(`Module A: recommended YAML field "${required}" is missing.`);
  }

  for (const section of REQUIRED_SECTIONS.filter((section) => !body.includes(section))) {
    errors.push(`Module A: missing mandatory section ${section}.`);
  }
  if (body.includes("## Persona Topology")) {
    for (const sub of ["### Invariant Axes", "### Variant Axes", "### Boundary Conditions"]) {
      if (!body.includes(sub)) errors.push(`Module A: Persona Topology is missing subsection ${sub}.`);
    }
    const invariantCount = countListItemsUnder(body, "### Invariant Axes");
    if (invariantCount !== null && invariantCount < 2) {
      errors.push(`Module A: Invariant Axes must have at least two entries, found ${invariantCount}.`);
    }
    const variantBlock = sliceSection(body, "### Variant Axes", "### Boundary Conditions");
    const variantCount = variantBlock ? countListItems(variantBlock) : 0;
    if (variantCount < 3) errors.push(`Module A: Variant Axes must have at least three entries, found ${variantCount}.`);
    if (variantBlock) {
      const positivePattern = /\b(softens?|soften|opens?|opening|warms?|warmth|becomes accessible|becomes reachable|gentler|tender|relaxes?|humor surfaces|genuine connection)\b|(变得可达|变得可触及|软化|开放|松弛|幽默浮现|真诚连接|亲近)/i;
      if (!positivePattern.test(variantBlock)) {
        warnings.push("Module A: no Variant Axis describes a positive (opening/softening) shift direction. At least one is recommended.");
      }
    }
  }
  if (body.includes("### Boundary Conditions")
    && !/hard limit/i.test(body)
    && !/硬限制|硬边界|绝不会|绝不做/i.test(body)) {
    warnings.push('Module A: Boundary Conditions should state a "Hard limit" the character will never cross.');
  }
  for (const tag of findLeakedLSystemTags(content)) {
    errors.push(`Module A: L-System tag "${tag}" leaked into output. These are production-layer only.`);
  }
  return makeValidationResult(errors, warnings);
}
