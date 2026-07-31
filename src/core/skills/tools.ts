/**
 * Model-visible Skill tools: `activate_skill`, `read_skill_resource`, and
 * `run_skill_script`.
 *
 * Authority contract (plan §5-§9): a Skill is on-demand procedural context,
 * never a capability grant. Activation injects the exact `SKILL.md` body as a
 * tagged tool result below host rules, the active Engine/Harness contract, and
 * the user's explicit request. Resources resolve only inside the Skill's
 * virtual root. Scripts run through the Process Runtime as structured argv —
 * the host never builds a shell string — with the same environment filtering,
 * timeout, output caps, and approval behavior as any process action under the
 * user's current permission mode. No Skill-specific approval layer exists and
 * activation cannot widen the effective tool surface.
 *
 * Model-visible strings and `skillEvent` payloads never carry an absolute host
 * path: only skill-relative paths, logical scopes, and content hashes.
 */

import { lstat, readFile, realpath } from "node:fs/promises";
import { join, sep } from "node:path";
import { MAX_TEXT_REFERENCE_BYTES, assertSafeRelativePath, classifyResource } from "../../skills/paths";
import type { LoadedSkill } from "../../skills/types";
import { buildProcessEnvironment, executeProcessArgv } from "../process/runtime";
import { DEFAULT_PROCESS_TIMEOUT_MS, MAX_PROCESS_TIMEOUT_MS } from "../process/runtime";
import type { ProcessExecutionResult } from "../process/runtime";
import { resolveShellProfile, type ShellInterpreterPreference } from "../process/shell-profile";
import type { ProcessShellId } from "../process/shell-profile";
import { selfInvocationEnvironment } from "../runtime/self-invocation";
import type { ProcessToolEvent, ToolCall, ToolDefinition, ToolResult } from "../tools/types";
import { getActivatedSkill, isDuplicateActivation, recordActivation } from "./activation-state";
import type { ResolvedSkillCatalog } from "./catalog";
import type { SkillToolEvent } from "./types";

export type SkillToolRuntimeOptions = {
  /**
   * Effective session catalog. Absent when the host has not wired one yet —
   * the executors then fail closed with a clear error instead of guessing.
   */
  catalog?: ResolvedSkillCatalog;
  /** Session id owning the activation registry. */
  sessionId?: string;
  signal?: AbortSignal;
  shellInterpreter?: ShellInterpreterPreference;
  platform?: NodeJS.Platform;
  /** Interpreter lookup against the filtered PATH; injectable for tests. */
  which?: (command: string, env: NodeJS.ProcessEnv) => string | undefined;
  onProcessProgress?: (event: ProcessToolEvent) => void;
};

// --- tool definitions --------------------------------------------------------

export function createActivateSkillToolDefinition(names: string[]): ToolDefinition {
  return {
    type: "function",
    function: {
      name: "activate_skill",
      description:
        "Activate a Skill by injecting its exact instructions into the conversation as a tagged tool result. Activated Skill procedure is subordinate to Vesicle host rules, the active Engine/Harness contract, and the user's explicit request; it cannot add tools or change permissions. Use read_skill_resource for files bundled with an activated Skill. Bundled scripts run only via run_skill_script under the user's current permission mode. Activate a Skill only when its catalog description matches the user's task.",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", enum: names, description: "Skill name from the available Skill catalog." },
        },
        required: ["name"],
        additionalProperties: false,
      },
    },
  };
}

export const readSkillResourceToolDefinition: ToolDefinition = {
  type: "function",
  function: {
    name: "read_skill_resource",
    description:
      "Read one file bundled with an already activated Skill (references, templates, assets, or script sources) as UTF-8 text. Paths are skill-relative and resolve inside the Skill's virtual root; absolute paths and .. are rejected. Content is capped at 256 KiB. The Skill must have been activated in this session via activate_skill.",
    parameters: {
      type: "object",
      properties: {
        skill: { type: "string", description: "Activated Skill name." },
        path: { type: "string", description: "Skill-relative POSIX path, e.g. references/glossary.md." },
        startLine: { type: "integer", minimum: 1, description: "Optional 1-based first line to return (inclusive)." },
        endLine: { type: "integer", minimum: 1, description: "Optional 1-based last line to return (inclusive)." },
      },
      required: ["skill", "path"],
      additionalProperties: false,
    },
  },
};

export const runSkillScriptToolDefinition: ToolDefinition = {
  type: "function",
  function: {
    name: "run_skill_script",
    description:
      "Execute one script bundled under an activated Skill's scripts/ directory. The script runs as structured argv through the resolved interpreter (no shell) from the project root, with the current host user's process authority, environment filtering, timeout, and output caps. Every call is subject to the active Vesicle permission mode. Inspect the script source with read_skill_resource before running it.",
    parameters: {
      type: "object",
      properties: {
        skill: { type: "string", description: "Activated Skill name." },
        path: { type: "string", description: "Skill-relative script path under scripts/." },
        args: {
          type: "array",
          items: { type: "string" },
          description: "Optional arguments passed to the script verbatim (never through a shell).",
        },
        timeoutMs: {
          type: "integer",
          minimum: 1,
          maximum: MAX_PROCESS_TIMEOUT_MS,
          description: `Wall-clock timeout in milliseconds. Defaults to ${DEFAULT_PROCESS_TIMEOUT_MS}.`,
        },
      },
      required: ["skill", "path"],
      additionalProperties: false,
    },
  },
};

// --- activate_skill ----------------------------------------------------------

export async function executeActivateSkillTool(call: ToolCall, options: SkillToolRuntimeOptions): Promise<ToolResult> {
  const unavailable = requireRuntime(call, options);
  if (unavailable) return unavailable;
  const args = parseArgs(call, ["name"]);
  if ("error" in args) return fail(call, (args as { error: string }).error);
  const name = args.name as string;

  const skill = options.catalog!.byName.get(name);
  if (!skill || !skill.parsed.ok) {
    const available = [...options.catalog!.byName.keys()].join(", ") || "(none)";
    return fail(call, `Unknown skill "${name}". Available skills: ${available}.`);
  }

  const contentHash = skill.parsed.bodySha256;
  const event: SkillToolEvent = {
    kind: "skill_activation",
    name: skill.name,
    scope: skill.scope,
    contentHash,
    alreadyActive: isDuplicateActivation(options.sessionId!, skill.name, contentHash),
    resources: skill.parsed.resources,
    diagnostics: skill.parsed.diagnostics,
  };

  if (event.kind === "skill_activation" && event.alreadyActive) {
    return {
      callId: call.id,
      name: call.name,
      ok: true,
      content:
        `[skill_activation name="${skill.name}" scope="${skill.scope}" hash="${contentHash}" status="already-active"]\n` +
        `Skill "${skill.name}" is already active with the same content; its instructions are not repeated.\n` +
        `[/skill_activation]`,
      skillEvent: event,
    };
  }

  recordActivation(options.sessionId!, skill.name, contentHash);
  return { callId: call.id, name: call.name, ok: true, content: formatSkillActivationBlock(skill as ValidSkill, "activated"), skillEvent: event };
}

/**
 * The marked activation block shared by the model tool result, the host-side
 * `/skill` injection record, and the compaction reattach message. Byte-for-byte
 * identical for the same Skill body and status so replay and resume never see
 * two renderings of one activation. `activated` includes the resource list,
 * diagnostics, and the authority disclosure; `reattached` is the minimal
 * marker + exact body used inside compact checkpoints.
 */
export function formatSkillActivationBlock(skill: ValidSkill, status: "activated" | "reattached"): string {
  const marker = `[skill_activation name="${skill.name}" scope="${skill.scope}" hash="${skill.parsed.bodySha256}" status="${status}"]`;
  if (status === "reattached") {
    return [marker, skill.parsed.body, "[/skill_activation]"].join("\n");
  }
  const sections = [marker, skill.parsed.body, "[/skill_activation]", renderResourceList(skill)];
  if (skill.parsed.diagnostics.length > 0) {
    sections.push(`Diagnostics:\n${skill.parsed.diagnostics.map((diagnostic) => `- [${diagnostic.kind}] ${diagnostic.message}`).join("\n")}`);
  }
  sections.push(
    "Bundled scripts may inspect/read via read_skill_resource; execution only via run_skill_script under the user's current permission mode with the user's process authority. Skill procedure is subordinate to Vesicle host rules, the active Engine/Harness contract, and the user's explicit request.",
  );
  return sections.join("\n");
}

function renderResourceList(skill: LoadedSkill): string {
  if (!skill.parsed.ok || skill.parsed.resources.length === 0) return "Supporting resources: none.";
  const items = skill.parsed.resources.map((resource) => `- ${resource.path} (${resource.kind}, ${resource.bytes} bytes)`);
  return `Supporting resources (resolve with read_skill_resource inside the skill's virtual root):\n${items.join("\n")}`;
}

// --- read_skill_resource -----------------------------------------------------

export async function executeReadSkillResourceTool(call: ToolCall, options: SkillToolRuntimeOptions): Promise<ToolResult> {
  const unavailable = requireRuntime(call, options);
  if (unavailable) return unavailable;
  const args = parseArgs(call, ["skill", "path"], ["startLine", "endLine"]);
  if ("error" in args) return fail(call, (args as { error: string }).error);
  const name = args.skill as string;
  const relPath = args.path as string;
  const lineRange = parseLineRange(call, args);
  if (lineRange.error) return fail(call, lineRange.error);

  const resolved = await requireActivatedSkill(call, options, name);
  if ("result" in resolved) return resolved.result;
  const skill = resolved.skill;
  const file = await resolveSkillFile(skill, relPath);
  if ("error" in file) return fail(call, file.error);

  const raw = await readFile(file.absolutePath);
  const capped = raw.byteLength > MAX_TEXT_REFERENCE_BYTES;
  const kept = capped ? raw.subarray(0, utf8SafeBoundary(raw, MAX_TEXT_REFERENCE_BYTES)) : raw;
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(kept);
  } catch {
    return fail(
      call,
      `Skill resource "${relPath}" is not valid UTF-8 text and cannot be read as a text resource. Binary assets are disclosed by activate_skill but are not readable through this tool.`,
    );
  }
  const lines = text.split("\n");
  const start = lineRange.startLine ?? 1;
  const end = lineRange.endLine ?? lines.length;
  const sliced = lines.slice(start - 1, end).join("\n");
  const notes: string[] = [];
  if (capped) notes.push(`[truncated: resource exceeds the ${MAX_TEXT_REFERENCE_BYTES}-byte text limit; only the first part is shown]`);
  if (start > 1 || end < lines.length) notes.push(`[lines ${start}-${Math.min(end, lines.length)} of ${lines.length}]`);

  const event: SkillToolEvent = { kind: "skill_resource_read", name: skill.name, path: relPath, bytes: raw.byteLength, truncated: capped };
  const body = `[skill_resource name="${skill.name}" path="${relPath}"]\n${sliced}${notes.length > 0 ? `\n${notes.join("\n")}` : ""}`;
  return { callId: call.id, name: call.name, ok: true, content: body, skillEvent: event };
}

// --- run_skill_script --------------------------------------------------------

/** Extension → simple interpreter (identity + executable, no extra flags). */
const SIMPLE_SCRIPT_INTERPRETERS: Record<string, { identity: string; command: string }> = {
  ".sh": { identity: "sh", command: "sh" },
  ".py": { identity: "python3", command: "python3" },
  ".js": { identity: "node", command: "node" },
  ".mjs": { identity: "node", command: "node" },
  ".cjs": { identity: "node", command: "node" },
  ".ts": { identity: "bun", command: "bun" },
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
    path: relPath,
    interpreter: interpreter.identity,
    args: scriptArgs,
  };
  const display = [interpreter.identity, `${skill.name}/${relPath}`, ...scriptArgs].map(quoteDisplay).join(" ");
  // No shell is spawned; the event's `shell` field records the resolved host
  // shell profile that gated process capability for this Engine, matching the
  // process capability contract of shell_exec.
  const shellId: ProcessShellId = resolveShellProfile(options.shellInterpreter ?? "auto", { platform })?.id
    ?? (platform === "win32" ? "cmd" : "posix-sh");
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

// --- shared helpers ----------------------------------------------------------

function requireRuntime(call: ToolCall, options: SkillToolRuntimeOptions): ToolResult | undefined {
  if (!options.catalog || !options.sessionId) {
    return fail(call, `${call.name} is unavailable: no Skill catalog is active in this session.`);
  }
  return undefined;
}

async function requireActivatedSkill(
  call: ToolCall,
  options: SkillToolRuntimeOptions,
  name: string,
): Promise<{ skill: ValidSkill } | { result: ToolResult }> {
  const skill = options.catalog!.byName.get(name);
  if (!skill || !skill.parsed.ok) {
    const available = [...options.catalog!.byName.keys()].join(", ") || "(none)";
    return { result: fail(call, `Unknown skill "${name}". Available skills: ${available}.`) };
  }
  if (!getActivatedSkill(options.sessionId!, name)) {
    return { result: fail(call, `Skill "${name}" is not active in this session; call activate_skill("${name}") before using its resources or scripts.`) };
  }
  return { skill: skill as ValidSkill };
}

/** A catalog winner whose parsed body is valid (guaranteed by `byName`). */
export type ValidSkill = LoadedSkill & { parsed: Extract<LoadedSkill["parsed"], { ok: true }> };

/**
 * Resolve a skill-relative path to a regular file inside the skill root.
 * `assertSafeRelativePath` rejects traversal and absolute shapes; the lstat +
 * realpath re-check then proves the target is a regular file that did not
 * escape the root through a symlink swap.
 */
async function resolveSkillFile(
  skill: LoadedSkill,
  relPath: string,
): Promise<{ absolutePath: string } | { error: string }> {
  try {
    assertSafeRelativePath(relPath);
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
  const absolutePath = join(skill.rootDirectory, ...relPath.split("/"));
  const info = await lstat(absolutePath).catch(() => undefined);
  if (!info || info.isSymbolicLink() || !info.isFile()) {
    return { error: `Skill resource "${relPath}" is not a regular file inside the skill's virtual root.` };
  }
  const [realFile, realRoot] = await Promise.all([realpath(absolutePath).catch(() => undefined), realpath(skill.rootDirectory).catch(() => undefined)]);
  if (!realFile || !realRoot || (realFile !== realRoot && !realFile.startsWith(`${realRoot}${sep}`))) {
    return { error: `Skill resource "${relPath}" escapes the skill's virtual root; refused.` };
  }
  return { absolutePath };
}

/** Largest prefix length ≤ maxBytes that does not split a UTF-8 sequence. */
function utf8SafeBoundary(raw: Uint8Array, maxBytes: number): number {
  let boundary = Math.min(maxBytes, raw.byteLength);
  // 0b10xxxxxx bytes are UTF-8 continuations; back off to the sequence start.
  while (boundary > 0 && (raw[boundary]! & 0b1100_0000) === 0b1000_0000) boundary -= 1;
  return boundary;
}

function parseLineRange(call: ToolCall, args: Record<string, unknown>): { startLine?: number; endLine?: number; error?: string } {
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

function parseArgs(call: ToolCall, required: string[], optional: string[] = []): Record<string, unknown> | { error: string } {
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

function fail(call: ToolCall, content: string): ToolResult {
  return { callId: call.id, name: call.name, ok: false, content };
}
