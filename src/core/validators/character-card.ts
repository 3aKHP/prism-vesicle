import type { ValidationResult } from "./types";
import { artifactLanguagePolicyWarnings } from "./artifact-language-policy";
import {
  countListItems,
  countListItemsUnder,
  duplicateTopLevelYamlKeys,
  findLeakedLSystemTags,
  hasNonEmptyLabeledListItem,
  isNonEmptyString,
  makeValidationResult,
  parseYamlMapping,
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
  const warnings = artifactLanguagePolicyWarnings("Module A", content);
  const { yaml, body } = splitFrontmatter(content);
  if (!yaml) {
    errors.push("Module A: YAML frontmatter is missing or malformed (expected leading --- block).");
    return makeValidationResult(errors, warnings);
  }

  const parsed = parseYamlMapping(yaml);
  if (!parsed.value) {
    errors.push(`Module A: YAML ${parsed.error}`);
    return makeValidationResult(errors, warnings);
  }
  for (const field of Object.keys(parsed.value)) {
    if (!YAML_ALLOWED_FIELDS.has(field)) {
      errors.push(`Module A: YAML frontmatter field "${field}" is not allowed. Permitted fields: ${[...YAML_ALLOWED_FIELDS].join(", ")}.`);
    }
  }
  for (const field of duplicateTopLevelYamlKeys(yaml)) {
    errors.push(`Module A: YAML frontmatter field "${field}" is duplicated.`);
  }
  for (const required of YAML_ALLOWED_FIELDS) {
    if (!(required in parsed.value)) errors.push(`Module A: required YAML field "${required}" is missing.`);
    else if (!isNonEmptyString(parsed.value[required])) errors.push(`Module A: YAML field "${required}" must be a non-empty string.`);
  }

  validateOrderedSections(body, REQUIRED_SECTIONS, "section", errors);
  const personaBlock = sliceSection(body, "## Persona Topology", "## Narrative Engine");
  if (personaBlock) {
    const subsections = ["### Invariant Axes", "### Variant Axes", "### Boundary Conditions"];
    validateOrderedSections(personaBlock, subsections, "Persona Topology subsection", errors);
    const invariantCount = countListItemsUnder(personaBlock, "### Invariant Axes");
    if (invariantCount !== null && invariantCount < 2) {
      errors.push(`Module A: Invariant Axes must have at least two entries, found ${invariantCount}.`);
    }
    const variantBlock = sliceSection(personaBlock, "### Variant Axes", "### Boundary Conditions");
    const variantCount = variantBlock ? countListItems(variantBlock) : 0;
    if (variantCount < 3) errors.push(`Module A: Variant Axes must have at least three entries, found ${variantCount}.`);
  }
  const boundaryBlock = sliceSection(body, "### Boundary Conditions", "## Narrative Engine");
  if (boundaryBlock && !hasNonEmptyLabeledListItem(boundaryBlock, "Hard limit")) {
    errors.push('Module A: Boundary Conditions must contain a non-empty "Hard limit:" list item.');
  }
  for (const tag of findLeakedLSystemTags(content)) {
    errors.push(`Module A: L-System tag "${tag}" leaked into output. These are production-layer only.`);
  }
  return makeValidationResult(errors, warnings);
}

function validateOrderedSections(
  content: string,
  headings: readonly string[],
  label: string,
  errors: string[],
): void {
  let previous = -1;
  for (let index = 0; index < headings.length; index++) {
    const heading = headings[index]!;
    const escaped = heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const matches = [...content.matchAll(new RegExp(`^${escaped}\\s*$`, "gm"))];
    if (matches.length === 0) {
      errors.push(label === "section"
        ? `Module A: missing mandatory section ${heading}.`
        : `Module A: Persona Topology is missing subsection ${heading}.`);
      continue;
    }
    if (matches.length > 1) {
      errors.push(`Module A: ${label} ${heading} must appear exactly once.`);
      continue;
    }
    const position = matches[0]!.index;
    if (position <= previous) errors.push(`Module A: ${label} ${heading} is out of order.`);
    previous = position;
    const contentStart = position + matches[0]![0].length;
    const nextHeading = headings[index + 1];
    const contentEnd = nextHeading ? content.indexOf(nextHeading, contentStart) : content.length;
    if (contentEnd < 0 || !content.slice(contentStart, contentEnd).trim()) {
      errors.push(`Module A: ${label} ${heading} is empty.`);
    }
  }
}
