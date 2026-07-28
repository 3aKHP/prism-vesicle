import type { ValidationResult } from "./types";
import { makeValidationResult } from "./document-structure";

const REPORT_SECTIONS = [
  "## 1. Executive Summary",
  "## 2. Dimension Scores",
  "## 3. Detailed Findings",
  "## 4. Issue List",
  "## 5. Optimization Recommendations",
];

export function validateEvaluateReport(content: string): ValidationResult {
  const errors: string[] = [];
  const verdicts = [...content.matchAll(/^\*\*Overall Verdict:\*\*\s*(PASS|CONDITIONAL|FAIL)\s*$/gim)];
  if (verdicts.length !== 1) {
    errors.push('Evaluate: report must contain exactly one independent "**Overall Verdict:**" line with PASS / CONDITIONAL / FAIL.');
  }
  let previous = -1;
  for (let index = 0; index < REPORT_SECTIONS.length; index++) {
    const section = REPORT_SECTIONS[index]!;
    const escaped = section.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const matches = [...content.matchAll(new RegExp(`^${escaped}\\s*$`, "gm"))];
    if (matches.length !== 1) {
      errors.push(`Evaluate: report must contain exactly one section "${section}".`);
      continue;
    }
    const position = matches[0]!.index;
    if (position <= previous) errors.push(`Evaluate: report section "${section}" is out of order.`);
    previous = position;
    const contentStart = position + matches[0]![0].length;
    const next = REPORT_SECTIONS[index + 1];
    const contentEnd = next ? content.indexOf(next, contentStart) : content.length;
    if (contentEnd < 0 || !content.slice(contentStart, contentEnd).trim()) {
      errors.push(`Evaluate: report section "${section}" is empty.`);
    }
  }
  return makeValidationResult(errors);
}
