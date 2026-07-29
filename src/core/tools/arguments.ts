import { createHash } from "node:crypto";
import type { ToolCall } from "./types";

const diagnosticPrefixLimit = 256;

export type MalformedToolArguments = {
  toolCallId: string;
  name: string;
  reason: "invalid-json" | "not-object";
  originalLength: number;
  sha256: string;
  prefix: string;
};

export type ValidatedToolCalls = {
  /** All calls in provider order, with malformed arguments made replay-safe. */
  replayable: ToolCall[];
  /** Only calls whose arguments are valid JSON objects and may be executed. */
  executable: ToolCall[];
  malformed: MalformedToolArguments[];
};

/**
 * Validate the normalized provider response before any tool is persisted or
 * executed. Tool protocols require an object, not merely any JSON value.
 */
export function validateToolCallArguments(calls: ToolCall[]): ValidatedToolCalls {
  const replayable: ToolCall[] = [];
  const executable: ToolCall[] = [];
  const malformed: MalformedToolArguments[] = [];

  for (const call of calls) {
    const reason = malformedReason(call.arguments);
    if (!reason) {
      const copy = { ...call };
      replayable.push(copy);
      executable.push(copy);
      continue;
    }

    replayable.push({ ...call, arguments: "{}" });
    malformed.push({
      toolCallId: call.id,
      name: call.name,
      reason,
      originalLength: Buffer.byteLength(call.arguments, "utf8"),
      sha256: createHash("sha256").update(call.arguments).digest("hex"),
      prefix: call.arguments.slice(0, diagnosticPrefixLimit),
    });
  }

  return { replayable, executable, malformed };
}

/** Make legacy persisted tool calls safe for structured provider replay. */
export function replayableToolArguments(value: string): string {
  return malformedReason(value) ? "{}" : value;
}

function malformedReason(value: string): MalformedToolArguments["reason"] | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value || "{}");
  } catch {
    return "invalid-json";
  }
  return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? undefined : "not-object";
}
