import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildProcessEnvironment,
  createProcessExecutionPlan,
  executeProcessPlan,
  MAX_PROCESS_STREAM_BYTES,
} from "../../../src/core/process/runtime";
import { ProcessManager } from "../../../src/core/process/manager";
import {
  executeShellExecTool,
  executeShellOutputTool,
  executeShellStopTool,
  executionPlanHash,
  parseShellExecPlan,
} from "../../../src/core/tools/shell";

describe("process runtime", () => {
  test("builds a child environment from an allowlist", () => {
    expect(buildProcessEnvironment({
      PATH: "/bin",
      HOME: "/home/test",
      PROVIDER_API_KEY: "secret",
      TAVILY_API_KEY: "secret",
    })).toEqual({ PATH: "/bin", HOME: "/home/test" });
  });

  test("validates and hashes the exact execution plan", () => {
    const call = { id: "call-1", name: "shell_exec", arguments: JSON.stringify({ command: "  pwd  ", timeoutMs: 500 }) };
    const plan = parseShellExecPlan(call);
    expect(plan.command).toBe("pwd");
    expect(plan.cwd).toBe(".");
    if (process.platform === "win32") expect(plan.executablePath).toMatch(/pwsh\.exe$|powershell\.exe$/i);
    else expect(plan.executablePath).toBe("/bin/sh");
    expect(plan.runtimePolicyVersion).toBe(2);
    expect(plan.runInBackground).toBe(false);
    expect(executionPlanHash(plan)).toHaveLength(64);
    expect(executionPlanHash(createProcessExecutionPlan("pwd", 500, process.platform, true))).not.toBe(executionPlanHash(plan));
    expect(executionPlanHash({ ...plan, shell: "cmd", executablePath: "C:\\Windows\\System32\\cmd.exe" }))
      .not.toBe(executionPlanHash(plan));
    expect(() => createProcessExecutionPlan("", 100)).toThrow("non-empty");
    expect(() => createProcessExecutionPlan("pwd", 600_001)).toThrow("must be an integer");
  });

  test("rejects an approved plan when the resolved interpreter changes", async () => {
    const root = await mkdtemp(join(tmpdir(), "vesicle-process-"));
    try {
      const call = { id: "call-plan-drift", name: "shell_exec", arguments: JSON.stringify({ command: "printf safe" }) };
      const approved = parseShellExecPlan(call);
      const result = await executeShellExecTool(root, call, {
        executionPlan: { ...approved, executablePath: `${approved.executablePath}.changed` },
      });
      expect(result.ok).toBe(false);
      expect(result.content).toContain("approved shell execution plan changed");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  for (const [shellInterpreter, command] of [
    ["powershell-7", "[Console]::Out.Write('中文')"],
    ["windows-powershell-5.1", "[Console]::Out.Write('中文')"],
    ["cmd", "echo 中文"],
    ["git-bash", "printf '中文'"],
  ] as const) {
    test.skipIf(process.platform !== "win32")(`runs Windows ${shellInterpreter} with UTF-8 output`, async () => {
      const root = await mkdtemp(join(tmpdir(), "vesicle-process-"));
      try {
        const result = await executeProcessPlan(
          root,
          createProcessExecutionPlan(command, 5_000, "win32", false, shellInterpreter),
        );
        expect(result.exitCode).toBe(0);
        expect(result.stdout).toContain("中文");
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    }, 20_000);
  }

  test.skipIf(process.platform !== "win32")("Windows auto executes through 5.1 when PowerShell 7 is absent", async () => {
    const root = await mkdtemp(join(tmpdir(), "vesicle-process-"));
    const previousPath = process.env.PATH;
    const previousProgramFiles = process.env.ProgramFiles;
    try {
      process.env.PATH = `${process.env.SystemRoot ?? "C:\\Windows"}\\System32`;
      process.env.ProgramFiles = join(root, "missing-program-files");
      expect(() => createProcessExecutionPlan("Write-Output blocked", 5_000, "win32", false, "powershell-7"))
        .toThrow("not available");
      const plan = createProcessExecutionPlan("[Console]::Out.Write('中文')", 5_000, "win32");
      expect(plan.shell).toBe("windows-powershell-5.1");
      const result = await executeProcessPlan(root, plan);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("中文");
    } finally {
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
      if (previousProgramFiles === undefined) delete process.env.ProgramFiles;
      else process.env.ProgramFiles = previousProgramFiles;
      await rm(root, { recursive: true, force: true });
    }
  }, 20_000);

  test("runs from the project root with separated output", async () => {
    const root = await mkdtemp(join(tmpdir(), "vesicle-process-"));
    try {
      const result = await executeProcessPlan(
        root,
        createProcessExecutionPlan(process.platform === "win32"
          ? "[Console]::Out.Write('out'); [Console]::Error.Write('err')"
          : "printf out; printf err >&2"),
        { env: { PATH: process.env.PATH } },
      );
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("out");
      expect(result.stderr).toBe("err");
      expect(result.timedOut).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("bounds captured output while draining the process", async () => {
    const root = await mkdtemp(join(tmpdir(), "vesicle-process-"));
    try {
      const result = await executeProcessPlan(
        root,
        createProcessExecutionPlan(process.platform === "win32"
          ? "[Console]::Out.Write('x' * 300000)"
          : "head -c 300000 /dev/zero | tr '\\0' x"),
        { env: { PATH: process.env.PATH } },
      );
      expect(result.stdoutBytes).toBe(300_000);
      expect(Buffer.byteLength(result.stdout)).toBe(MAX_PROCESS_STREAM_BYTES);
      expect(result.stdoutTruncated).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("times out a command and terminates its process group", async () => {
    const root = await mkdtemp(join(tmpdir(), "vesicle-process-"));
    try {
      const started = performance.now();
      const result = await executeProcessPlan(
        root,
        createProcessExecutionPlan(process.platform === "win32" ? "Start-Sleep -Seconds 5" : "sleep 5 & wait", 50),
        { env: { PATH: process.env.PATH } },
      );
      expect(result.timedOut).toBe(true);
      expect(performance.now() - started).toBeLessThan(2_000);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("emits elapsed progress for a quiet foreground command", async () => {
    const root = await mkdtemp(join(tmpdir(), "vesicle-process-"));
    try {
      const progress: number[] = [];
      const result = await executeProcessPlan(
        root,
        createProcessExecutionPlan(process.platform === "win32" ? "Start-Sleep -Milliseconds 1100" : "sleep 1.1", 5_000),
        { env: { PATH: process.env.PATH }, onProgress: (event) => progress.push(event.durationMs) },
      );
      expect(result.exitCode).toBe(0);
      expect(progress.some((durationMs) => durationMs >= 900)).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test.skipIf(process.platform === "win32")("keeps the deadline active when a background descendant inherits output pipes", async () => {
    const root = await mkdtemp(join(tmpdir(), "vesicle-process-"));
    try {
      const started = performance.now();
      const result = await executeProcessPlan(root, createProcessExecutionPlan("sleep 3 &", 100), {
        env: { PATH: process.env.PATH },
      });
      expect(result.timedOut).toBe(true);
      expect(performance.now() - started).toBeLessThan(1_000);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("returns structured shell tool metadata", async () => {
    const root = await mkdtemp(join(tmpdir(), "vesicle-process-"));
    try {
      const result = await executeShellExecTool(root, {
        id: "call-2",
        name: "shell_exec",
        arguments: JSON.stringify({ command: process.platform === "win32" ? "[Console]::Out.Write('hello')" : "printf hello" }),
      });
      expect(result.ok).toBe(true);
      expect(result.content).toContain("hello");
      expect(result.processEvent?.kind).toBe("process_exec");
      expect(result.processEvent?.status).toBe("completed");
      expect(result.processEvent?.stdoutTail).toBe("hello");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("runs a background shell, exposes output, and persists terminal state", async () => {
    const root = await mkdtemp(join(tmpdir(), "vesicle-process-"));
    const manager = new ProcessManager(root);
    try {
      const started = await executeShellExecTool(root, {
        id: "call-background",
        name: "shell_exec",
        arguments: JSON.stringify({
          command: process.platform === "win32" ? "Start-Sleep -Milliseconds 100; [Console]::Out.Write('background')" : "sleep 0.1; printf background",
          runInBackground: true,
        }),
      }, { processManager: manager, parentSessionId: "session-background" });
      expect(started.ok).toBe(true);
      expect(started.processEvent).toMatchObject({ executionMode: "background", status: "running" });
      const taskId = started.processEvent?.taskId;
      if (!taskId) throw new Error("expected background task id");

      const completed = await manager.wait(taskId, { timeoutMs: 5_000 });
      expect(completed.status).toBe("completed");
      expect(completed.stdout).toBe("background");

      const output = await executeShellOutputTool(root, {
        id: "call-output",
        name: "shell_output",
        arguments: JSON.stringify({ taskId }),
      }, { processManager: manager, parentSessionId: "session-background" });
      expect(output.ok).toBe(true);
      expect(output.content).toContain("background");
      expect(output.processEvent?.status).toBe("completed");

      const missingSession = await executeShellOutputTool(root, {
        id: "call-output-missing-session",
        name: "shell_output",
        arguments: JSON.stringify({ taskId }),
      }, { processManager: manager });
      expect(missingSession.ok).toBe(false);
      expect(missingSession.content).toContain("requires an active parent session");

      const crossSession = await executeShellOutputTool(root, {
        id: "call-output-other-session",
        name: "shell_output",
        arguments: JSON.stringify({ taskId }),
      }, { processManager: manager, parentSessionId: "other-session" });
      expect(crossSession.ok).toBe(false);
      expect(crossSession.content).toContain("does not belong to the active session");

      const statePath = join(root, ".vesicle", "processes", `${taskId}.json`);
      expect(await Bun.file(statePath).exists()).toBe(true);
      expect(await Bun.file(statePath).json()).toMatchObject({ taskId, status: "completed" });
    } finally {
      await manager.shutdown();
      await rm(root, { recursive: true, force: true });
    }
  });

  test("stops a running background shell", async () => {
    const root = await mkdtemp(join(tmpdir(), "vesicle-process-"));
    const manager = new ProcessManager(root);
    try {
      const started = await executeShellExecTool(root, {
        id: "call-background-stop",
        name: "shell_exec",
        arguments: JSON.stringify({
          command: process.platform === "win32" ? "Start-Sleep -Seconds 30" : "sleep 30",
          runInBackground: true,
        }),
      }, { processManager: manager, parentSessionId: "session-background" });
      const taskId = started.processEvent?.taskId;
      if (!taskId) throw new Error("expected background task id");
      const missingSession = await executeShellStopTool(root, {
        id: "call-stop-missing-session",
        name: "shell_stop",
        arguments: JSON.stringify({ taskId }),
      }, { processManager: manager });
      expect(missingSession.ok).toBe(false);
      expect(missingSession.content).toContain("requires an active parent session");

      const stopped = await executeShellStopTool(root, {
        id: "call-stop",
        name: "shell_stop",
        arguments: JSON.stringify({ taskId }),
      }, { processManager: manager, parentSessionId: "session-background" });
      expect(stopped.ok).toBe(true);
      expect(stopped.processEvent?.status).toBe("cancelled");
    } finally {
      await manager.shutdown();
      await rm(root, { recursive: true, force: true });
    }
  });

  test("ignores persisted process state whose task id does not match its file", async () => {
    const root = await mkdtemp(join(tmpdir(), "vesicle-process-"));
    const storeDir = join(root, ".vesicle", "processes");
    await mkdir(storeDir, { recursive: true });
    await writeFile(join(storeDir, "shell-1.json"), JSON.stringify({
      taskId: "../../escape",
      parentSessionId: "session-background",
      parentToolCallId: "call-background",
      plan: createProcessExecutionPlan("printf ignored", 1_000, process.platform, true),
      status: "running",
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      durationMs: 0,
      stdout: "",
      stderr: "",
      stdoutTail: "",
      stderrTail: "",
      stdoutBytes: 0,
      stderrBytes: 0,
      stdoutTruncated: false,
      stderrTruncated: false,
      notified: false,
    }), "utf8");
    const manager = new ProcessManager(root);
    try {
      expect(await manager.list()).toEqual([]);
      expect(await Bun.file(join(root, ".vesicle", "escape.json")).exists()).toBe(false);
    } finally {
      await manager.shutdown();
      await rm(root, { recursive: true, force: true });
    }
  });
});
