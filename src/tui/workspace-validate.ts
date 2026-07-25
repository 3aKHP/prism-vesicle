import { ARTIFACT_VALIDATOR_NAMES } from "../core/artifacts/workbench";
import { validateContent } from "../core/validators/registry";

/**
 * In-page validation orchestration for the Workspace page (Scope B / #62,
 * milestone B4 §5.2). The shared `ARTIFACT_VALIDATOR_NAMES` list keeps this on
 * the exact same validators as the turn-finalizer auto-check and `/validate`.
 *
 * `ValidationResult` is a string bucket with no line numbers (changing that
 * would touch four validators plus session record formats), so finding→line
 * resolution is a post-hoc anchor scan over the finding text: pull a `## …`
 * section header or a quoted frontmatter key out of the message, `indexOf` it
 * in the buffer, and count newlines. Findings with no resolvable anchor (e.g.
 * "missing field …") fall back to the end of the frontmatter and are flagged
 * `anchored: false` so the panel can mark them `(no anchor)`.
 */

export type ValidationSeverity = "error" | "warning";

export type LocatedFinding = {
  severity: ValidationSeverity;
  validator: string;
  text: string;
  /** 0-indexed line for `gotoLine`, or null when no anchor resolved. */
  line: number | null;
  anchored: boolean;
};

export type ValidationState =
  | { state: "pending" }
  | { state: "no-match" }
  | { state: "result"; ok: boolean; findings: LocatedFinding[] };

export const pendingValidation: ValidationState = { state: "pending" };

/** Run the shared artifact validators over content, locating each finding. */
export function runValidation(content: string): ValidationState {
  const result = validateContent([...ARTIFACT_VALIDATOR_NAMES], content);
  if (!result) return { state: "no-match" };
  const findings: LocatedFinding[] = [];
  for (const entry of result.results) {
    for (const text of entry.result.errors) findings.push(located(content, "error", entry.name, text));
    for (const text of entry.result.warnings) findings.push(located(content, "warning", entry.name, text));
  }
  return { state: "result", ok: result.ok, findings };
}

function located(content: string, severity: ValidationSeverity, validator: string, text: string): LocatedFinding {
  const { line, anchored } = locateFinding(content, text);
  return { severity, validator, text, line, anchored };
}

/**
 * Resolve a finding message to a buffer line. Candidates are extracted from
 * the message text (section headers and quoted frontmatter keys) and tried in
 * order; the first that appears in the buffer wins. Findings about something
 * MISSING (no anchor present in the text) fall back to the frontmatter's
 * closing fence — usually where the gap needs filling.
 */
export function locateFinding(content: string, text: string): { line: number | null; anchored: boolean } {
  for (const anchor of extractAnchors(text)) {
    const idx = content.indexOf(anchor);
    if (idx >= 0) return { line: lineAt(content, idx), anchored: true };
  }
  return { line: frontmatterEndLine(content), anchored: false };
}

/** Candidate anchors mentioned in a finding message, most-specific first. */
export function extractAnchors(text: string): string[] {
  const anchors: string[] = [];
  for (const match of text.matchAll(/#{2,}\s+[^.,;)\n]+/g)) {
    const header = match[0].trim();
    if (header) anchors.push(header);
  }
  for (const match of text.matchAll(/"([a-z_][a-z0-9_]*)"/gi)) {
    anchors.push(`${match[1]}:`);
  }
  return anchors;
}

function lineAt(content: string, offset: number): number {
  let line = 0;
  for (let i = 0; i < offset; i += 1) {
    if (content.charCodeAt(i) === 10) line += 1;
  }
  return line;
}

function frontmatterEndLine(content: string): number {
  const trimmed = content.trimStart();
  if (!trimmed.startsWith("---")) return 0;
  const lines = trimmed.split(/\r?\n/);
  for (let i = 1; i < lines.length; i += 1) {
    if (lines[i].trim() === "---") return i;
  }
  return 0;
}

/** Status-line summary text for the current validation state. */
export function validationSummary(state: ValidationState): string {
  switch (state.state) {
    case "pending":
      return "";
    case "no-match":
      return "no validator matched";
    case "result": {
      const errors = state.findings.filter((f) => f.severity === "error").length;
      const warnings = state.findings.filter((f) => f.severity === "warning").length;
      if (state.ok && warnings === 0) return "✓ validators passed";
      const parts: string[] = [];
      if (errors > 0) parts.push(`✗ ${errors}`);
      if (warnings > 0) parts.push(`⚠ ${warnings}`);
      return `${parts.join(" · ")} · v view`;
    }
  }
}

/**
 * Severity rank for status-line colour, -1 when validation contributes nothing
 * (pending/no-match). The component folds this into the overall status tone.
 * 0 = passed (emerald), 1 = warnings only (amber), 2 = errors (red).
 */
export function validationSeverity(state: ValidationState): number {
  if (state.state !== "result") return -1;
  if (!state.ok) return 2;
  if (state.findings.some((f) => f.severity === "warning")) return 1;
  return 0;
}
