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
  stdoutTail: string;
  stderrTail: string;
  stdoutBytes: number;
  stderrBytes: number;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
};

export type ProcessExecutionProgress = {
  durationMs: number;
  stdoutTail: string;
  stderrTail: string;
  stdoutBytes: number;
  stderrBytes: number;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
};

export type ProcessExecutionHandle = {
  pid: number;
  result: Promise<ProcessExecutionResult>;
  cancel(): void;
};

export function createProcessExecutionPlan(
  command: string,
  timeoutMs = DEFAULT_PROCESS_TIMEOUT_MS,
  platform: NodeJS.Platform = process.platform,
  runInBackground = false,
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
    runInBackground,
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
    onProgress?: (progress: ProcessExecutionProgress) => void;
  } = {},
): Promise<ProcessExecutionResult> {
  return startProcessPlan(rootDir, plan, options).result;
}

export function startProcessPlan(
  rootDir: string,
  plan: ProcessExecutionPlan,
  options: {
    signal?: AbortSignal;
    env?: NodeJS.ProcessEnv;
    platform?: NodeJS.Platform;
    onProgress?: (progress: ProcessExecutionProgress) => void;
  } = {},
): ProcessExecutionHandle {
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

  const stdoutState = createCaptureState();
  const stderrState = createCaptureState();
  let lastProgressAt = 0;
  const emitProgress = (force = false) => {
    if (!options.onProgress) return;
    const now = performance.now();
    if (!force && now - lastProgressAt < 100) return;
    lastProgressAt = now;
    try {
      options.onProgress({
        durationMs: Math.max(0, Math.round(now - started)),
        stdoutTail: stdoutState.tail,
        stderrTail: stderrState.tail,
        stdoutBytes: stdoutState.bytes,
        stderrBytes: stderrState.bytes,
        stdoutTruncated: stdoutState.bytes > stdoutState.keptBytes,
        stderrTruncated: stderrState.bytes > stderrState.keptBytes,
      });
    } catch {
      // Host display callbacks must never change process lifetime semantics.
    }
  };
  const stdoutPromise = captureStream(child.stdout, stdoutState, emitProgress);
  const stderrPromise = captureStream(child.stderr, stderrState, emitProgress);
  const progressTimer = options.onProgress ? setInterval(() => emitProgress(true), 1_000) : undefined;
  progressTimer?.unref?.();
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
  const result = (async (): Promise<ProcessExecutionResult> => {
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
      if (progressTimer) clearInterval(progressTimer);
      options.signal?.removeEventListener("abort", abortListener);
    }
    // A shell can exit after launching a background descendant. Always clean
    // the original process tree before returning, even when its inherited pipes
    // closed quickly and the command otherwise appeared successful.
    termination ??= terminateProcessTree(child.pid, platform);
    await termination;
    emitProgress(true);
    return {
      exitCode,
      durationMs: Math.max(0, Math.round(performance.now() - started)),
      timedOut,
      aborted,
      stdout: stdout.text,
      stderr: stderr.text,
      stdoutTail: stdoutState.tail,
      stderrTail: stderrState.tail,
      stdoutBytes: stdout.bytes,
      stderrBytes: stderr.bytes,
      stdoutTruncated: stdout.truncated,
      stderrTruncated: stderr.truncated,
    };
  })();
  return {
    pid: child.pid,
    result,
    cancel: () => stop("abort"),
  };
}

type CaptureState = {
  kept: Uint8Array[];
  keptBytes: number;
  bytes: number;
  tail: string;
  decoder: TextDecoder;
};

function createCaptureState(): CaptureState {
  return { kept: [], keptBytes: 0, bytes: 0, tail: "", decoder: new TextDecoder("utf-8", { fatal: false }) };
}

async function captureStream(
  stream: ReadableStream<Uint8Array> | null,
  state: CaptureState,
  onChunk: () => void,
): Promise<{
  text: string;
  bytes: number;
  truncated: boolean;
}> {
  if (!stream) return { text: "", bytes: 0, truncated: false };
  const reader = stream.getReader();
  while (true) {
    const next = await reader.read();
    if (next.done) break;
    state.bytes += next.value.byteLength;
    state.tail = `${state.tail}${state.decoder.decode(next.value, { stream: true })}`.slice(-8_192);
    if (state.keptBytes < MAX_PROCESS_STREAM_BYTES) {
      const remaining = MAX_PROCESS_STREAM_BYTES - state.keptBytes;
      const chunk = next.value.byteLength <= remaining ? next.value : next.value.slice(0, remaining);
      state.kept.push(chunk);
      state.keptBytes += chunk.byteLength;
    }
    onChunk();
  }
  state.tail = `${state.tail}${state.decoder.decode()}`.slice(-8_192);
  const combined = new Uint8Array(state.keptBytes);
  let offset = 0;
  for (const chunk of state.kept) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return {
    text: new TextDecoder("utf-8", { fatal: false }).decode(combined),
    bytes: state.bytes,
    truncated: state.bytes > state.keptBytes,
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
