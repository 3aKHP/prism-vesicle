// run_skill_script executor: executes a bundled script through the Process
// Runtime as structured argv (no shell). Interpreter resolution, environment
// filtering, timeout, output caps, and progress events all go through the same
// process-hardening policy as any host process action.

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { buildProcessEnvironment, executeProcessArgv } from "../../process/runtime";
import { DEFAULT_PROCESS_TIMEOUT_MS, MAX_PROCESS_TIMEOUT_MS } from "../../process/runtime";
import type { ProcessExecutionResult } from "../../process/runtime";
import { resolveShellProfile } from "../../process/shell-profile";
import type { ProcessShellId } from "../../process/shell-profile";
import { selfInvocationEnvironment } from "../../runtime/self-invocation";
import { assertSafeRelativePath, classifyResource } from "../../../skills/paths";
import type { ProcessToolEvent, ToolCall, ToolResult } from "../../tools/types";
import type { SkillToolEvent } from "../types";
import { requireRuntime, requireActivatedSkill, resolveSkillFile, fail } from "./activated-skill";
import type { SkillToolRuntimeOptions } from "./activated-skill";
import { parseArgs } from "./arguments";

/** Extension → simple interpreter (identity + executable, no extra flags). */
const SIMPLE_SCRIPT_INTERPRETERS: Record<string, { identity: string; command: string }> = {
  ".sh": { identity: "sh", command: "sh" },
  ".py": { identity: "python3", command: "python3" },
  ".js": { identity: "node", command: "node" },
  ".mjs": { identity: "node", command: "node" },
  ".cjs": { identity: "node", command: "node" },
  ".ts": { identity: "bun", command: "bun" },
};
const INTERPRETER_SHELL_IDS: Partial<Record<string, ProcessShellId>> = {
  pwsh: "powershell-7",
  "powershell-5.1": "windows-powershell-5.1",
};

const POWERSHELL_FLAGS = ["-NoLogo", "-NoProfile", "-NonInteractive", "-File"];

/** Resolved interpreter: logical identity for events + full argv prefix. */
type ResolvedInterpreter = {
  identity: string;
  argvPrefix: string[];
};

type WhichFn = (command: string, env: NodeJS.ProcessEnv) => string | undefined;

/**
 * Resolve a script extension to an interpreter descriptor. Simple extensions
 * look up the command and verify it on PATH. `.ps1` prefers PowerShell 7 then
 * Windows PowerShell 5.1 on Windows, and `pwsh` only on other platforms. When
 * unavailable, returns a bounded message listing what was tried so the model
 * gets an actionable failure and no process event is emitted.
 */
function resolveScriptInterpreter(
  extension: string,
  relPath: string,
  platform: NodeJS.Platform,
  which: WhichFn,
  env: NodeJS.ProcessEnv,
): { ok: true; interpreter: ResolvedInterpreter } | { ok: false; message: string } {
  const simple = SIMPLE_SCRIPT_INTERPRETERS[extension];
  if (simple) {
    if (!which(simple.command, env)) {
      return { ok: false, message: `Interpreter "${simple.command}" required by "${relPath}" was not found on the process PATH; install it or ask the user how to proceed. The script was not executed.` };
    }
    return { ok: true, interpreter: { identity: simple.identity, argvPrefix: [simple.command] } };
  }

  if (extension === ".ps1") {
    if (platform === "win32") {
      const resolved = resolveShellProfile("auto", { platform, env, which });
      if (resolved) {
        const identity = resolved.id === "powershell-7" ? "pwsh" : "powershell-5.1";
        return { ok: true, interpreter: { identity, argvPrefix: [resolved.executablePath, ...POWERSHELL_FLAGS] } };
      }
      return { ok: false, message: `PowerShell 7 and Windows PowerShell 5.1 were not found; install one to run "${relPath}". The script was not executed.` };
    }
    // Non-Windows: pwsh only. Never pretend Windows PowerShell 5.1 exists.
    if (which("pwsh", env)) {
      return { ok: true, interpreter: { identity: "pwsh", argvPrefix: ["pwsh", ...POWERSHELL_FLAGS] } };
    }
    return { ok: false, message: `PowerShell ("pwsh") was not found on the process PATH; install it to run "${relPath}". The script was not executed.` };
  }

  const known = [".ps1", ...Object.keys(SIMPLE_SCRIPT_INTERPRETERS)];
  return { ok: false, message: `No interpreter is known for "${extension || relPath}"; supported script extensions: ${known.join(", ")}.` };
}

export async function executeRunSkillScriptTool(
  rootDir: string,
  call: ToolCall,
  options: SkillToolRuntimeOptions,
): Promise<ToolResult> {
  const unavailable = requireRuntime(call, options);
  if (unavailable) return unavailable;
  const args = parseArgs(call, ["skill", "path"], ["args", "timeoutMs"]);
  if ("error" in args) return fail(call, (args as { error: string }).error);
  const name = args.skill as string;
  const relPath = args.path as string;

  if (args.args !== undefined && (!Array.isArray(args.args) || args.args.some((value) => typeof value !== "string" || value.includes("\0")))) {
    return fail(call, "run_skill_script args must be an array of strings without NUL bytes.");
  }
  const scriptArgs = (args.args as string[] | undefined) ?? [];
  const timeoutMs = args.timeoutMs ?? DEFAULT_PROCESS_TIMEOUT_MS;
  if (!Number.isInteger(timeoutMs) || (timeoutMs as number) < 1 || (timeoutMs as number) > MAX_PROCESS_TIMEOUT_MS) {
    return fail(call, `run_skill_script timeoutMs must be an integer from 1 to ${MAX_PROCESS_TIMEOUT_MS}.`);
  }

  const resolved = await requireActivatedSkill(call, options, name);
  if ("result" in resolved) return resolved.result;
  const skill = resolved.skill;

  try {
    assertSafeRelativePath(relPath);
  } catch (error) {
    return fail(call, error instanceof Error ? error.message : String(error));
  }
  if (classifyResource(relPath) !== "script") {
    return fail(call, `Skill path "${relPath}" is not a bundled script; only files under scripts/ can be executed. Read it with read_skill_resource instead.`);
  }
  const file = await resolveSkillFile(skill, relPath);
  if ("error" in file) return fail(call, file.error);
  const expectedResourceHash = skill.parsed.resources.find((resource) => resource.path === relPath)?.sha256;
  if (!expectedResourceHash) return fail(call, `Skill script "${relPath}" has no catalog content hash; refresh the Skill catalog before executing it.`);
  let resourceHash: string;
  try {
    resourceHash = createHash("sha256").update(await readFile(file.absolutePath)).digest("hex");
  } catch (error) {
    return fail(call, `Unable to verify Skill script "${relPath}" before execution: ${error instanceof Error ? error.message : String(error)}.`);
  }
  if (resourceHash !== expectedResourceHash) {
    return fail(call, `Skill script "${relPath}" changed after catalog discovery; refresh the Skill catalog before executing it. The script was not executed.`);
  }

  const extension = extensionOf(relPath);
  const platform = options.platform ?? process.platform;
  const filteredEnv = buildProcessEnvironment(undefined);
  const which = options.which ?? defaultWhich;
  const interpreterResult = resolveScriptInterpreter(extension, relPath, platform, which, filteredEnv);
  if (!interpreterResult.ok) {
    return fail(call, interpreterResult.message);
  }
  const interpreter = interpreterResult.interpreter;

  const provenance: SkillToolEvent = {
    kind: "skill_script_exec",
    name: skill.name,
    contentHash: skill.parsed.bodySha256,
    resourceHash,
    path: relPath,
    interpreter: interpreter.identity,
    args: scriptArgs,
  };
  const display = [interpreter.identity, `${skill.name}/${relPath}`, ...scriptArgs].map(quoteDisplay).join(" ");
  // No shell is spawned. The legacy process-event field records the selected
  // interpreter family when representable, without consulting shell_exec's
  // independently configured shell profile.
  const shellId: ProcessShellId = INTERPRETER_SHELL_IDS[interpreter.identity] ?? "posix-sh";
  const progressEvent = (progress: { durationMs: number; stdoutTail: string; stderrTail: string; stdoutBytes: number; stderrBytes: number; stdoutTruncated: boolean; stderrTruncated: boolean }): ProcessToolEvent => ({
    kind: "process_exec",
    executionMode: "foreground",
    status: "running",
    command: display,
    cwd: ".",
    shell: shellId,
    durationMs: progress.durationMs,
    timedOut: false,
    aborted: false,
    stdoutBytes: progress.stdoutBytes,
    stderrBytes: progress.stderrBytes,
    stdoutTruncated: progress.stdoutTruncated,
    stderrTruncated: progress.stderrTruncated,
    stdoutTail: progress.stdoutTail,
    stderrTail: progress.stderrTail,
  });

  const fullArgv = [...interpreter.argvPrefix, file.absolutePath, ...scriptArgs];
  let result: ProcessExecutionResult;
  try {
    result = await executeProcessArgv(rootDir, fullArgv, {
      timeoutMs: timeoutMs as number,
      signal: options.signal,
      env: filteredEnv,
      platform,
      additionalEnv: selfInvocationEnvironment(),
      onProgress: options.onProcessProgress ? (progress) => options.onProcessProgress!(progressEvent(progress)) : undefined,
    });
  } catch (error) {
    return fail(call, `Unable to start interpreter "${interpreter.identity}": ${error instanceof Error ? error.message : String(error)}`);
  }

  const processEvent: ProcessToolEvent = {
    kind: "process_exec",
    executionMode: "foreground",
    status: result.timedOut ? "timed_out" : result.aborted ? "cancelled" : result.exitCode === 0 ? "completed" : "failed",
    command: display,
    cwd: ".",
    shell: shellId,
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
    `[skill_script name="${skill.name}" path="${relPath}" interpreter="${interpreter.identity}"]`,
    result.stdout ? `stdout:\n${result.stdout}` : "stdout: (empty)",
    result.stderr ? `stderr:\n${result.stderr}` : "stderr: (empty)",
  ];
  if (result.stdoutTruncated) sections[1] += "\n[stdout truncated]";
  if (result.stderrTruncated) sections[2] += "\n[stderr truncated]";
  const outcome = result.timedOut
    ? `Script timed out after ${timeoutMs} ms and was stopped.`
    : result.aborted
      ? "Script was cancelled."
      : `Exit code: ${result.exitCode ?? "unknown"} (${result.durationMs} ms).`;
  const ok = !result.timedOut && !result.aborted && result.exitCode === 0;
  return {
    callId: call.id,
    name: call.name,
    ok,
    content: `${sections.join("\n\n")}\n\n${outcome}`,
    processEvent,
    skillEvent: provenance,
  };
}

function extensionOf(relPath: string): string {
  const base = relPath.split("/").pop() ?? "";
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(dot).toLowerCase() : "";
}

/** Display-only quoting for the durable event command string; never executed. */
function quoteDisplay(token: string): string {
  return /[\s"'\\]/.test(token) ? `"${token.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"` : token;
}

function defaultWhich(command: string, env: NodeJS.ProcessEnv): string | undefined {
  const path = env.PATH ?? env.Path;
  return Bun.which(command, path ? { PATH: path } : undefined) ?? undefined;
}
