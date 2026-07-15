import { describe, expect, test } from "bun:test";
import { buildProcessCommand, createProcessExecutionPlan } from "../src/core/process/runtime";
import {
  resolveShellProfile,
  shellProfileForPlan,
} from "../src/core/process/shell-profile";
import { createShellExecToolDefinition } from "../src/core/tools/shell";
import { resolveBuiltInTools } from "../src/core/agent-loop/tool-surface";
import type { EngineProfile } from "../src/core/engine/profile";

const windowsEnv = {
  ProgramFiles: "C:\\Program Files",
  SystemRoot: "C:\\Windows",
  ComSpec: "C:\\Windows\\System32\\cmd.exe",
};

describe("shell profiles", () => {
  test("auto stays in the PowerShell family and prefers PowerShell 7", () => {
    const existing = new Set([
      "C:\\Program Files\\PowerShell\\7\\pwsh.exe",
      "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
    ]);
    const resolved = resolveShellProfile("auto", {
      platform: "win32",
      env: windowsEnv,
      which: () => undefined,
      exists: (path) => existing.has(path),
    });
    expect(resolved).toMatchObject({ id: "powershell-7", displayName: "PowerShell 7" });
  });

  test("auto falls back to Windows PowerShell 5.1 but never to cmd or Git Bash", () => {
    const powershell = "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";
    const fallback = resolveShellProfile("auto", {
      platform: "win32",
      env: windowsEnv,
      which: () => undefined,
      exists: (path) => path === powershell,
    });
    expect(fallback).toMatchObject({ id: "windows-powershell-5.1", executablePath: powershell });

    const none = resolveShellProfile("auto", {
      platform: "win32",
      env: windowsEnv,
      which: (command) => command === "cmd.exe" ? windowsEnv.ComSpec : undefined,
      exists: (path) => path === windowsEnv.ComSpec,
    });
    expect(none).toBeUndefined();
  });

  test("explicit interpreters resolve only their own executable", () => {
    const git = "C:\\Program Files\\Git\\cmd\\git.exe";
    const bash = "C:\\Program Files\\Git\\bin\\bash.exe";
    const exists = new Set([windowsEnv.ComSpec, git, bash]);
    const which = (command: string) => command === "git.exe" ? git : undefined;
    expect(resolveShellProfile("cmd", {
      platform: "win32",
      env: windowsEnv,
      which,
      exists: (path) => exists.has(path),
    })?.id).toBe("cmd");
    expect(resolveShellProfile("git-bash", {
      platform: "win32",
      env: windowsEnv,
      which,
      exists: (path) => exists.has(path),
    })).toMatchObject({ id: "git-bash", executablePath: bash });
    expect(resolveShellProfile("powershell-7", {
      platform: "win32",
      env: windowsEnv,
      which,
      exists: (path) => exists.has(path),
    })).toBeUndefined();
  });

  test("non-Windows auto remains portable /bin/sh", () => {
    expect(resolveShellProfile("auto", { platform: "linux" })).toMatchObject({
      id: "posix-sh",
      executablePath: "/bin/sh",
    });
    expect(resolveShellProfile("posix-sh", { platform: "linux" })).toMatchObject({
      id: "posix-sh",
      executablePath: "/bin/sh",
    });
    expect(resolveShellProfile("git-bash", { platform: "linux" })).toBeUndefined();
    expect(resolveShellProfile("posix-sh", {
      platform: "win32",
      env: windowsEnv,
      which: () => undefined,
      exists: () => false,
    })).toBeUndefined();
  });

  test("builds deterministic non-interactive commands for every profile", () => {
    const base = createProcessExecutionPlan("echo ready", 1_000, "linux");
    expect(buildProcessCommand(base)).toEqual(["/bin/sh", "-c", "echo ready"]);

    const powershell = { ...base, shell: "windows-powershell-5.1" as const, executablePath: "powershell.exe" };
    expect(buildProcessCommand(powershell)).toEqual([
      "powershell.exe",
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      expect.stringContaining("[Console]::OutputEncoding"),
    ]);
    expect(buildProcessCommand({ ...base, shell: "cmd", executablePath: "cmd.exe" })).toEqual([
      "cmd.exe", "/D", "/S", "/C", "chcp 65001>nul & echo ready",
    ]);
    expect(buildProcessCommand({ ...base, shell: "git-bash", executablePath: "bash.exe" })).toEqual([
      "bash.exe", "--noprofile", "--norc", "-c", "echo ready",
    ]);
  });

  test("tool guidance names the resolved command dialect", () => {
    const definition = createShellExecToolDefinition(shellProfileForPlan(
      "windows-powershell-5.1",
      "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
    ));
    expect(definition.function.description).toContain("Windows PowerShell 5.1");
    expect(definition.function.description).toContain("Do not use && or ||");
  });

  test("Linux exposes /bin/sh for auto or posix-sh and rejects Windows-only profiles", () => {
    if (process.platform === "win32") return;
    const engine = {
      id: "etl",
      displayName: "test",
      protocolVersion: "test",
      systemPrompt: ["test"],
      defaultTools: ["shell_exec", "shell_output", "shell_stop"],
      validators: [],
      stopGates: [],
      stateRoots: [],
      asset: { path: "test", source: "bundled" },
    } satisfies EngineProfile;
    const automatic = resolveBuiltInTools(engine, false, true, "auto");
    const explicit = resolveBuiltInTools(engine, false, true, "posix-sh");
    expect(automatic.map((tool) => tool.function.name)).toContain("shell_exec");
    expect(automatic.find((tool) => tool.function.name === "shell_exec")?.function.description).toContain("/bin/sh");
    expect(explicit.map((tool) => tool.function.name)).toContain("shell_exec");
    const unavailable = resolveBuiltInTools(engine, false, true, "powershell-7").map((tool) => tool.function.name);
    expect(unavailable).not.toContain("shell_exec");
    expect(unavailable).toContain("shell_output");
    expect(unavailable).toContain("shell_stop");
  });
});
