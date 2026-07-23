import type { ValidationResult } from "./index";

const LSYSTEM_TAGS = ["L1", "L2", "L3-A", "L3-B", "L4-A", "L4-B", "L5"];

export function findLeakedLSystemTags(content: string): string[] {
  const found: string[] = [];
  for (const tag of LSYSTEM_TAGS) {
    const escaped = tag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const pattern = new RegExp(`(^|[^A-Za-z0-9])${escaped}([^A-Za-z0-9]|$)`);
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
