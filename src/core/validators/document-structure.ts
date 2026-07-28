import type { ValidationResult } from "./types";

/** Internal document primitives for artifact validators; not part of the validators facade. */
const LSYSTEM_TAGS = ["L1", "L2", "L3-A", "L3-B", "L4", "L4-A", "L4-B", "L5"];

export type YamlMapping = Record<string, unknown>;

export function findLeakedLSystemTags(content: string): string[] {
  const found: string[] = [];
  for (const tag of LSYSTEM_TAGS) {
    const escaped = tag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const pattern = new RegExp(`(^|[^A-Za-z0-9-])${escaped}([^A-Za-z0-9-]|$)`);
    if (pattern.test(content)) found.push(tag);
  }
  return found;
}

export function splitFrontmatter(content: string): { yaml: string | null; body: string } {
  const source = content.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const trimmed = source.replace(/^\s+/, "");
  if (!trimmed.startsWith("---")) return { yaml: null, body: source };
  const end = trimmed.indexOf("\n---", 3);
  if (end === -1) return { yaml: null, body: source };
  return {
    yaml: trimmed.slice(3, end).trim(),
    body: trimmed.slice(end + 4).replace(/^\s+/, ""),
  };
}

export function parseYamlMapping(yaml: string): { value?: YamlMapping; error?: string } {
  try {
    const value: unknown = Bun.YAML.parse(yaml);
    if (!isYamlMapping(value)) return { error: "frontmatter root must be a YAML mapping." };
    return { value };
  } catch {
    return { error: "frontmatter contains invalid YAML syntax." };
  }
}

export function duplicateTopLevelYamlKeys(yaml: string): string[] {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const line of yaml.split("\n")) {
    const match = /^([A-Za-z_][A-Za-z0-9_]*):/.exec(line);
    if (!match) continue;
    if (seen.has(match[1])) duplicates.add(match[1]);
    seen.add(match[1]);
  }
  return [...duplicates];
}

export function isYamlMapping(value: unknown): value is YamlMapping {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

export function hasNonEmptyLabeledListItem(block: string, label: string): boolean {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^\\s*[-*]\\s+(?:\\*\\*)?${escaped}:(?:\\*\\*)?\\s*\\S`, "im").test(block);
}

export function makeValidationResult(errors: string[], warnings: string[] = []): ValidationResult {
  return { ok: errors.length === 0, errors, warnings };
}

export function sliceSection(body: string, startHeader: string, endHeader: string): string | null {
  const start = body.indexOf(startHeader);
  if (start === -1) return null;
  const end = body.indexOf(endHeader, start + startHeader.length);
  return end === -1 ? body.slice(start) : body.slice(start, end);
}

export function countListItems(block: string): number {
  const matches = block.match(/^\s*[-*]\s+/gm);
  return matches ? matches.length : 0;
}

export function countListItemsUnder(body: string, header: string): number | null {
  const start = body.indexOf(header);
  if (start === -1) return null;
  const after = body.slice(start + header.length);
  const endMatch = /\n#{2,3}\s/.exec(after);
  const section = endMatch ? after.slice(0, endMatch.index) : after;
  return countListItems(section);
}
