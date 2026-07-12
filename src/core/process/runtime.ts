import { basename } from "node:path";
import type { ProcessExecutionPlan } from "../permissions";

export const PROCESS_ENV_POLICY_VERSION = 1;
export const DEFAULT_PROCESS_TIMEOUT_MS = 120_000;
export const MAX_PROCESS_TIMEOUT_MS = 600_000;
export const MAX_PROCESS_STREAM_BYTES = 256 * 1024;

const inheritedEnvironmentKeys = [
  "PATH",
  "PATHEXT",
  "SystemRoot",
  "WINDIR",
  "COMSPEC",
  "HOME",
  "USERPROFILE",
  "TEMP",
  "TMP",
  "LANG",
  "LC_ALL",
  "TERM",
] as const;

export type ProcessExecutionResult = {
  exitCode?: number;
  durationMs: number;
  timedOut: boolean;
  aborted: boolean;
  stdout: string;
  stderr: string;
  stdoutBytes: number;
  stderrBytes: number;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
};

export function createProcessExecutionPlan(
  command: string,
  timeoutMs = DEFAULT_PROCESS_TIMEOUT_MS,
  platform: NodeJS.Platform = process.platform,
): ProcessExecutionPlan {
  const normalizedCommand = command.trim();
  if (!normalizedCommand) throw new Error("shell_exec requires a non-empty command.");
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_PROCESS_TIMEOUT_MS) {
    throw new Error(`shell_exec timeoutMs must be an integer from 1 to ${MAX_PROCESS_TIMEOUT_MS}.`);
  }
  return {
    command: normalizedCommand,
    cwd: ".",
    shell: platform === "win32" ? "powershell" : "posix-sh",
    timeoutMs,
    envPolicyVersion: PROCESS_ENV_POLICY_VERSION,
  };
}

export function buildProcessEnvironment(source: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of inheritedEnvironmentKeys) {
    const value = source[key];
    if (value !== undefined) env[key] = value;
  }
  return env;
}

export async function executeProcessPlan(
  rootDir: string,
  plan: ProcessExecutionPlan,
  options: {
    signal?: AbortSignal;
    env?: NodeJS.ProcessEnv;
    platform?: NodeJS.Platform;
  } = {},
): Promise<ProcessExecutionResult> {
  const platform = options.platform ?? process.platform;
  const command = platform === "win32"
    ? ["pwsh.exe", "-NoLogo", "-NoProfile", "-NonInteractive", "-Command", plan.command]
    : ["/bin/sh", "-c", plan.command];
  const started = performance.now();
  const child = Bun.spawn(command, {
    cwd: rootDir,
    env: buildProcessEnvironment(options.env),
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    ...(platform === "win32" ? {} : { detached: true }),
  });

  const stdoutPromise = captureStream(child.stdout);
  const stderrPromise = captureStream(child.stderr);
  let timedOut = false;
  let aborted = false;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let termination: Promise<void> | undefined;

  const stop = (reason: "timeout" | "abort") => {
    if (reason === "timeout") timedOut = true;
    else aborted = true;
    termination ??= terminateProcessTree(child.pid, platform);
  };
  const abortListener = () => stop("abort");
  if (options.signal?.aborted) abortListener();
  else options.signal?.addEventListener("abort", abortListener, { once: true });

  timeout = setTimeout(() => stop("timeout"), plan.timeoutMs);
  let exitCode: number | undefined;
  let stdout: Awaited<ReturnType<typeof captureStream>>;
  let stderr: Awaited<ReturnType<typeof captureStream>>;
  try {
    [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      stdoutPromise,
      stderrPromise,
    ]);
  } finally {
    clearTimeout(timeout);
    options.signal?.removeEventListener("abort", abortListener);
  }
  // A shell can exit after launching a background descendant. Always clean
  // the original process tree before returning, even when its inherited pipes
  // closed quickly and the command otherwise appeared successful.
  termination ??= terminateProcessTree(child.pid, platform);
  await termination;
  return {
    exitCode,
    durationMs: Math.max(0, Math.round(performance.now() - started)),
    timedOut,
    aborted,
    stdout: stdout!.text,
    stderr: stderr!.text,
    stdoutBytes: stdout!.bytes,
    stderrBytes: stderr!.bytes,
    stdoutTruncated: stdout!.truncated,
    stderrTruncated: stderr!.truncated,
  };
}

async function captureStream(stream: ReadableStream<Uint8Array> | null): Promise<{
  text: string;
  bytes: number;
  truncated: boolean;
}> {
  if (!stream) return { text: "", bytes: 0, truncated: false };
  const reader = stream.getReader();
  const kept: Uint8Array[] = [];
  let keptBytes = 0;
  let bytes = 0;
  while (true) {
    const next = await reader.read();
    if (next.done) break;
    bytes += next.value.byteLength;
    if (keptBytes >= MAX_PROCESS_STREAM_BYTES) continue;
    const remaining = MAX_PROCESS_STREAM_BYTES - keptBytes;
    const chunk = next.value.byteLength <= remaining ? next.value : next.value.slice(0, remaining);
    kept.push(chunk);
    keptBytes += chunk.byteLength;
  }
  const combined = new Uint8Array(keptBytes);
  let offset = 0;
  for (const chunk of kept) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return {
    text: new TextDecoder("utf-8", { fatal: false }).decode(combined),
    bytes,
    truncated: bytes > keptBytes,
  };
}

async function terminateProcessTree(pid: number, platform: NodeJS.Platform): Promise<void> {
  if (platform === "win32") {
    const taskkill = Bun.spawn(["taskkill.exe", "/PID", String(pid), "/T", "/F"], {
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
      env: buildProcessEnvironment(),
    });
    await taskkill.exited.catch(() => undefined);
    return;
  }
  try {
    process.kill(-pid, "SIGTERM");
  } catch {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      return;
    }
  }
  await Bun.sleep(250);
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // The process tree exited during the grace period.
    }
  }
}

export function processShellDisplay(plan: ProcessExecutionPlan): string {
  return plan.shell === "powershell" ? "PowerShell 7" : basename("/bin/sh");
}
