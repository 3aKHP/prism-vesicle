import type { BackgroundProcessState } from "../../../../src/core/process/manager";

export function backgroundProcess(taskId: string, parentSessionId = "session-1"): BackgroundProcessState {
  return {
    taskId,
    parentSessionId,
    parentToolCallId: `call-${taskId}`,
    plan: {
      command: "bun test",
      cwd: ".",
      shell: "posix-sh",
      executablePath: "/bin/sh",
      runtimePolicyVersion: 2,
      timeoutMs: 120_000,
      envPolicyVersion: 1,
      runInBackground: true,
    },
    status: "running",
    startedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    durationMs: 2_000,
    stdout: "",
    stderr: "",
    stdoutTail: "",
    stderrTail: "",
    stdoutBytes: 0,
    stderrBytes: 0,
    stdoutTruncated: false,
    stderrTruncated: false,
    notified: false,
  };
}
