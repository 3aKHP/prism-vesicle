// Exact model-tool argument parsing: strict JSON parse, required-string check,
// unknown-key rejection, and line-range validation.

import type { ToolCall } from "../../tools/types";

export function parseArgs(call: ToolCall, required: string[], optional: string[] = []): Record<string, unknown> | { error: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(call.arguments || "{}");
  } catch {
    return { error: `${call.name} arguments must be valid JSON.` };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { error: `${call.name} arguments must be an object.` };
  const args = parsed as Record<string, unknown>;
  for (const key of required) {
    if (typeof args[key] !== "string" || (args[key] as string).length === 0) {
      return { error: `${call.name} requires a non-empty string "${key}".` };
    }
  }
  for (const key of Object.keys(args)) {
    if (!required.includes(key) && !optional.includes(key)) {
      return { error: `${call.name} does not accept argument "${key}".` };
    }
  }
  return args;
}

export function parseLineRange(call: ToolCall, args: Record<string, unknown>): { startLine?: number; endLine?: number; error?: string } {
  const range: { startLine?: number; endLine?: number; error?: string } = {};
  for (const key of ["startLine", "endLine"] as const) {
    const value = args[key];
    if (value === undefined) continue;
    if (!Number.isInteger(value) || (value as number) < 1) {
      return { error: `${call.name} ${key} must be an integer ≥ 1.` };
    }
    range[key] = value as number;
  }
  if (range.startLine !== undefined && range.endLine !== undefined && range.startLine > range.endLine) {
    return { error: `${call.name} startLine must be ≤ endLine.` };
  }
  return range;
}
