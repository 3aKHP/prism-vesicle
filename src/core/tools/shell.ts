import { createHash } from "node:crypto";
import {
  createProcessExecutionPlan,
  executeProcessPlan,
} from "../process/runtime";
import type { ProcessExecutionResult } from "../process/runtime";
import type { ProcessExecutionPlan } from "../permissions";
import type { ProcessToolEvent, ToolCall, ToolDefinition, ToolResult } from "./types";

export const shellExecToolDefinition: ToolDefinition = {
  type: "function",
  function: {
    name: "shell_exec",
    description: "Execute one non-interactive host shell command from the project root. This tool may access files outside the project and the network with the current host user's authority. Every call is subject to the active Vesicle permission mode.",
    parameters: {
      type: "object",
      properties: {
        command: { type: "string", description: "Complete shell command to execute." },
        timeoutMs: {
          type: "integer",
          minimum: 1,
          maximum: 600_000,
          description: "Wall-clock timeout in milliseconds. Defaults to 120000.",
        },
      },
      required: ["command"],
      additionalProperties: false,
    },
  },
};

export function parseShellExecPlan(call: ToolCall): ProcessExecutionPlan {
  if (call.name !== "shell_exec") throw new Error(`Expected shell_exec, received ${call.name}.`);
  let args: { command?: unknown; timeoutMs?: unknown };
  try {
    args = JSON.parse(call.arguments || "{}");
  } catch {
    throw new Error("shell_exec arguments must be valid JSON.");
  }
  if (typeof args.command !== "string") throw new Error("shell_exec requires a string command.");
  if (args.timeoutMs !== undefined && typeof args.timeoutMs !== "number") {
    throw new Error("shell_exec timeoutMs must be a number.");
  }
  return createProcessExecutionPlan(args.command, args.timeoutMs);
}

export function executionPlanHash(plan: ProcessExecutionPlan): string {
  return createHash("sha256").update(JSON.stringify(plan)).digest("hex");
}

export async function executeShellExecTool(
  rootDir: string,
  call: ToolCall,
  options: { signal?: AbortSignal } = {},
): Promise<ToolResult> {
  let plan: ProcessExecutionPlan;
  try {
    plan = parseShellExecPlan(call);
  } catch (error) {
    return fail(call, error instanceof Error ? error.message : String(error));
  }
  let result: ProcessExecutionResult;
  try {
    result = await executeProcessPlan(rootDir, plan, { signal: options.signal });
  } catch (error) {
    return fail(call, `Unable to start the configured host shell: ${error instanceof Error ? error.message : String(error)}`);
  }
  const event: ProcessToolEvent = {
    kind: "process_exec",
    command: plan.command,
    cwd: plan.cwd,
    shell: plan.shell,
    exitCode: result.exitCode,
    durationMs: result.durationMs,
    timedOut: result.timedOut,
    aborted: result.aborted,
    stdoutBytes: result.stdoutBytes,
    stderrBytes: result.stderrBytes,
    stdoutTruncated: result.stdoutTruncated,
    stderrTruncated: result.stderrTruncated,
  };
  const sections = [
    result.stdout ? `stdout:\n${result.stdout}` : "stdout: (empty)",
    result.stderr ? `stderr:\n${result.stderr}` : "stderr: (empty)",
  ];
  if (result.stdoutTruncated) sections[0] += "\n[stdout truncated]";
  if (result.stderrTruncated) sections[1] += "\n[stderr truncated]";
  const ok = !result.timedOut && !result.aborted && result.exitCode === 0;
  return {
    callId: call.id,
    name: call.name,
    ok,
    content: `${sections.join("\n\n")}\n\n${result.timedOut ? "Command timed out." : result.aborted ? "Command was cancelled." : `Exit code: ${result.exitCode ?? "unknown"}`}`,
    processEvent: event,
  };
}

function fail(call: ToolCall, content: string): ToolResult {
  return { callId: call.id, name: call.name, ok: false, content };
}
