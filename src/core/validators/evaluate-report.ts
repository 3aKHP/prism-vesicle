import type { ValidationResult } from "./index";
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
  if (!/\*\*Overall Verdict:\*\*\s*(PASS|CONDITIONAL|FAIL)/i.test(content)) {
    errors.push('Evaluate: missing "**Overall Verdict:**" line with PASS / CONDITIONAL / FAIL.');
  }
  for (const section of REPORT_SECTIONS) {
    if (!content.includes(section)) errors.push(`Evaluate: missing report section "${section}".`);
  }
  return makeValidationResult(errors);
}
