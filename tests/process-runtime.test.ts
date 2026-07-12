import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildProcessEnvironment,
  createProcessExecutionPlan,
  executeProcessPlan,
  MAX_PROCESS_STREAM_BYTES,
} from "../src/core/process/runtime";
import { executeShellExecTool, executionPlanHash, parseShellExecPlan } from "../src/core/tools/shell";

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
    expect(executionPlanHash(plan)).toHaveLength(64);
    expect(() => createProcessExecutionPlan("", 100)).toThrow("non-empty");
    expect(() => createProcessExecutionPlan("pwd", 600_001)).toThrow("must be an integer");
  });

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

  test("keeps the deadline active when a background descendant inherits output pipes", async () => {
    if (process.platform === "win32") return;
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
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
