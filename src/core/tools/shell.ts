import { createHash } from "node:crypto";
import {
  createProcessExecutionPlan,
  executeProcessPlan,
} from "../process/runtime";
import type { ProcessExecutionProgress, ProcessExecutionResult } from "../process/runtime";
import { getProcessManager, type BackgroundProcessState, type ProcessManager } from "../process/manager";
import type { ProcessExecutionPlan } from "../permissions";
import {
  resolveShellProfile,
  type ResolvedShellProfile,
  type ShellInterpreterPreference,
} from "../process/shell-profile";
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
        runInBackground: {
          type: "boolean",
          description: "Run the command in the background and return a task id immediately. Vesicle will surface progress and completion without requiring polling.",
        },
      },
      required: ["command"],
      additionalProperties: false,
    },
  },
};

export function createShellExecToolDefinition(
  shell: ResolvedShellProfile | undefined = resolveShellProfile(),
): ToolDefinition {
  const shellDetail = shell
    ? ` Commands run with ${shell.displayName}. ${shell.modelGuidance}`
    : " No configured host shell is currently available.";
  return {
    ...shellExecToolDefinition,
    function: {
      ...shellExecToolDefinition.function,
      description: `${shellExecToolDefinition.function.description}${shellDetail}`,
    },
  };
}

export const shellOutputToolDefinition: ToolDefinition = {
  type: "function",
  function: {
    name: "shell_output",
    description: "Read the current output and status of a background shell task. Vesicle also notifies the conversation when a task completes, so polling is unnecessary.",
    parameters: {
      type: "object",
      properties: {
        taskId: { type: "string", description: "Background shell task id returned by shell_exec." },
        wait: { type: "boolean", description: "Wait for completion before returning. Defaults to false." },
        timeoutMs: { type: "integer", minimum: 1, maximum: 120_000, description: "Maximum wait when wait is true. Defaults to 30000." },
      },
      required: ["taskId"],
      additionalProperties: false,
    },
  },
};

export const shellStopToolDefinition: ToolDefinition = {
  type: "function",
  function: {
    name: "shell_stop",
    description: "Stop a running background shell task by id.",
    parameters: {
      type: "object",
      properties: {
        taskId: { type: "string", description: "Background shell task id returned by shell_exec." },
      },
      required: ["taskId"],
      additionalProperties: false,
    },
  },
};

export function parseShellExecPlan(
  call: ToolCall,
  shellInterpreter: ShellInterpreterPreference = "auto",
): ProcessExecutionPlan {
  if (call.name !== "shell_exec") throw new Error(`Expected shell_exec, received ${call.name}.`);
  let args: { command?: unknown; timeoutMs?: unknown; runInBackground?: unknown };
  try {
    args = JSON.parse(call.arguments || "{}");
  } catch {
    throw new Error("shell_exec arguments must be valid JSON.");
  }
  if (typeof args.command !== "string") throw new Error("shell_exec requires a string command.");
  if (args.timeoutMs !== undefined && typeof args.timeoutMs !== "number") {
    throw new Error("shell_exec timeoutMs must be a number.");
  }
  if (args.runInBackground !== undefined && typeof args.runInBackground !== "boolean") {
    throw new Error("shell_exec runInBackground must be a boolean.");
  }
  return createProcessExecutionPlan(
    args.command,
    args.timeoutMs,
    process.platform,
    args.runInBackground === true,
    shellInterpreter,
  );
}

export function executionPlanHash(plan: ProcessExecutionPlan): string {
  return createHash("sha256").update(JSON.stringify(plan)).digest("hex");
}

export async function executeShellExecTool(
  rootDir: string,
  call: ToolCall,
  options: {
    signal?: AbortSignal;
    processManager?: ProcessManager;
    parentSessionId?: string;
    onProgress?: (event: ProcessToolEvent) => void;
    shellInterpreter?: ShellInterpreterPreference;
    executionPlan?: ProcessExecutionPlan;
  } = {},
): Promise<ToolResult> {
  let plan: ProcessExecutionPlan;
  try {
    const currentPlan = parseShellExecPlan(call, options.shellInterpreter);
    if (options.executionPlan && executionPlanHash(options.executionPlan) !== executionPlanHash(currentPlan)) {
      return fail(call, "The approved shell execution plan changed before execution; the command was not run.");
    }
    plan = options.executionPlan ?? currentPlan;
  } catch (error) {
    return fail(call, error instanceof Error ? error.message : String(error));
  }
  if (plan.runInBackground) {
    if (!options.parentSessionId) return fail(call, "Background shell execution requires an active parent session.");
    try {
      const manager = options.processManager ?? getProcessManager(rootDir);
      const task = await manager.start(plan, {
        parentSessionId: options.parentSessionId,
        parentToolCallId: call.id,
      });
      const event = processEventFromTask(task);
      return {
        callId: call.id,
        name: call.name,
        ok: true,
        content: `Background shell task ${task.taskId} started. Vesicle will notify the conversation when it completes. Use shell_output for current output or shell_stop to stop it.`,
        processEvent: event,
      };
    } catch (error) {
      return fail(call, `Unable to start the configured background shell: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  let result: ProcessExecutionResult;
  try {
    result = await executeProcessPlan(rootDir, plan, {
      signal: options.signal,
      onProgress: (progress) => options.onProgress?.(processEventFromProgress(plan, progress)),
    });
  } catch (error) {
    return fail(call, `Unable to start the configured host shell: ${error instanceof Error ? error.message : String(error)}`);
  }
  const event: ProcessToolEvent = {
    kind: "process_exec",
    executionMode: "foreground",
    status: result.timedOut ? "timed_out" : result.aborted ? "cancelled" : result.exitCode === 0 ? "completed" : "failed",
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
    stdoutTail: result.stdoutTail,
    stderrTail: result.stderrTail,
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

export async function executeShellOutputTool(
  rootDir: string,
  call: ToolCall,
  options: { signal?: AbortSignal; processManager?: ProcessManager; parentSessionId?: string } = {},
): Promise<ToolResult> {
  const args = parseControlArgs(call, true);
  if ("error" in args) return fail(call, args.error);
  try {
    const manager = options.processManager ?? getProcessManager(rootDir);
    const current = await manager.get(args.taskId);
    if (!current) return fail(call, `Unknown background shell task: ${args.taskId}.`);
    if (!options.parentSessionId) return fail(call, "Background shell output requires an active parent session.");
    if (current.parentSessionId !== options.parentSessionId) {
      return fail(call, `Background shell task ${args.taskId} does not belong to the active session.`);
    }
    const task = args.wait
      ? await manager.wait(args.taskId, { timeoutMs: args.timeoutMs, signal: options.signal })
      : current;
    return {
      callId: call.id,
      name: call.name,
      ok: true,
      content: renderTaskOutput(task),
      processEvent: processEventFromTask(task),
    };
  } catch (error) {
    return fail(call, error instanceof Error ? error.message : String(error));
  }
}

export async function executeShellStopTool(
  rootDir: string,
  call: ToolCall,
  options: { processManager?: ProcessManager; parentSessionId?: string } = {},
): Promise<ToolResult> {
  const args = parseControlArgs(call, false);
  if ("error" in args) return fail(call, args.error);
  try {
    const manager = options.processManager ?? getProcessManager(rootDir);
    const current = await manager.get(args.taskId);
    if (!current) return fail(call, `Unknown background shell task: ${args.taskId}.`);
    if (!options.parentSessionId) return fail(call, "Stopping a background shell requires an active parent session.");
    if (current.parentSessionId !== options.parentSessionId) {
      return fail(call, `Background shell task ${args.taskId} does not belong to the active session.`);
    }
    const task = await manager.stop(args.taskId);
    return {
      callId: call.id,
      name: call.name,
      ok: true,
      content: `Background shell task ${task.taskId} is ${task.status}.`,
      processEvent: processEventFromTask(task),
    };
  } catch (error) {
    return fail(call, error instanceof Error ? error.message : String(error));
  }
}

function parseControlArgs(call: ToolCall, allowWait: boolean):
  | { taskId: string; wait: boolean; timeoutMs: number }
  | { error: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(call.arguments || "{}");
  } catch {
    return { error: `${call.name} arguments must be valid JSON.` };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { error: `${call.name} arguments must be an object.` };
  const args = parsed as Record<string, unknown>;
  if (typeof args.taskId !== "string" || !args.taskId.trim()) return { error: `${call.name} requires a taskId.` };
  if (!allowWait && (args.wait !== undefined || args.timeoutMs !== undefined)) return { error: `${call.name} does not accept wait options.` };
  if (args.wait !== undefined && typeof args.wait !== "boolean") return { error: `${call.name} wait must be a boolean.` };
  if (args.timeoutMs !== undefined && (!Number.isInteger(args.timeoutMs) || (args.timeoutMs as number) < 1 || (args.timeoutMs as number) > 120_000)) {
    return { error: `${call.name} timeoutMs must be an integer from 1 to 120000.` };
  }
  return { taskId: args.taskId.trim(), wait: args.wait === true, timeoutMs: (args.timeoutMs as number | undefined) ?? 30_000 };
}

function processEventFromProgress(plan: ProcessExecutionPlan, progress: ProcessExecutionProgress): ProcessToolEvent {
  return {
    kind: "process_exec",
    executionMode: "foreground",
    status: "running",
    command: plan.command,
    cwd: plan.cwd,
    shell: plan.shell,
    durationMs: progress.durationMs,
    timedOut: false,
    aborted: false,
    stdoutBytes: progress.stdoutBytes,
    stderrBytes: progress.stderrBytes,
    stdoutTruncated: progress.stdoutTruncated,
    stderrTruncated: progress.stderrTruncated,
    stdoutTail: progress.stdoutTail,
    stderrTail: progress.stderrTail,
  };
}

export function processEventFromTask(task: BackgroundProcessState): ProcessToolEvent {
  return {
    kind: "process_exec",
    taskId: task.taskId,
    executionMode: "background",
    status: task.status,
    command: task.plan.command,
    cwd: task.plan.cwd,
    shell: task.plan.shell,
    exitCode: task.exitCode,
    durationMs: task.durationMs,
    timedOut: task.status === "timed_out",
    aborted: task.status === "cancelled" || task.status === "interrupted",
    stdoutBytes: task.stdoutBytes,
    stderrBytes: task.stderrBytes,
    stdoutTruncated: task.stdoutTruncated,
    stderrTruncated: task.stderrTruncated,
    stdoutTail: task.stdoutTail,
    stderrTail: task.stderrTail,
  };
}

function renderTaskOutput(task: BackgroundProcessState): string {
  const sections = [
    task.stdout ? `stdout:\n${task.stdout}` : task.stdoutTail ? `stdout (tail):\n${task.stdoutTail}` : "stdout: (empty)",
    task.stderr ? `stderr:\n${task.stderr}` : task.stderrTail ? `stderr (tail):\n${task.stderrTail}` : "stderr: (empty)",
  ];
  if (task.stdoutTruncated) sections[0] += "\n[stdout truncated]";
  if (task.stderrTruncated) sections[1] += "\n[stderr truncated]";
  return `${sections.join("\n\n")}\n\nTask ${task.taskId}: ${task.status}${task.exitCode !== undefined ? ` (exit ${task.exitCode})` : ""}.`;
}

function fail(call: ToolCall, content: string): ToolResult {
  return { callId: call.id, name: call.name, ok: false, content };
}
