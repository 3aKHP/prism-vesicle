import { existsSync } from "node:fs";
import { win32 } from "node:path";

export const shellInterpreterPreferences = [
  "auto",
  "posix-sh",
  "powershell-7",
  "windows-powershell-5.1",
  "cmd",
  "git-bash",
] as const;

export type ShellInterpreterPreference = (typeof shellInterpreterPreferences)[number];
export type ProcessShellId = Exclude<ShellInterpreterPreference, "auto">;
type WindowsShellInterpreter = Exclude<ShellInterpreterPreference, "auto" | "posix-sh">;

export type ResolvedShellProfile = {
  id: ProcessShellId;
  executablePath: string;
  displayName: string;
  modelGuidance: string;
};

type ShellResolutionOptions = {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  which?: (command: string, env: NodeJS.ProcessEnv) => string | undefined;
  exists?: (path: string) => boolean;
};

export function resolveShellProfile(
  preference: ShellInterpreterPreference = "auto",
  options: ShellResolutionOptions = {},
): ResolvedShellProfile | undefined {
  const platform = options.platform ?? process.platform;
  if (platform !== "win32") {
    if (preference !== "auto" && preference !== "posix-sh") return undefined;
    return profile("posix-sh", "/bin/sh");
  }
  if (preference === "posix-sh") return undefined;

  const env = options.env ?? process.env;
  const which = options.which ?? defaultWhich;
  const exists = options.exists ?? existsSync;
  const resolve = (candidate: WindowsShellInterpreter) =>
    resolveWindowsShell(candidate, env, which, exists);

  if (preference === "auto") return resolve("powershell-7") ?? resolve("windows-powershell-5.1");
  return resolve(preference);
}

export function shellProfileForPlan(id: ProcessShellId, executablePath: string): ResolvedShellProfile {
  return profile(id, executablePath);
}

export function shellDisplayName(id: ProcessShellId | "powershell"): string {
  if (id === "powershell") return "PowerShell 7 (legacy)";
  return profile(id, "").displayName;
}

function resolveWindowsShell(
  id: WindowsShellInterpreter,
  env: NodeJS.ProcessEnv,
  which: (command: string, env: NodeJS.ProcessEnv) => string | undefined,
  exists: (path: string) => boolean,
): ResolvedShellProfile | undefined {
  const systemRoot = env.SystemRoot ?? env.SYSTEMROOT ?? env.WINDIR ?? "C:\\Windows";
  const programFiles = env.ProgramFiles ?? env.PROGRAMFILES ?? "C:\\Program Files";
  const candidates = id === "powershell-7"
    ? [win32.join(programFiles, "PowerShell", "7", "pwsh.exe"), which("pwsh.exe", env)]
    : id === "windows-powershell-5.1"
      ? [win32.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"), which("powershell.exe", env)]
      : id === "cmd"
        ? [win32.join(systemRoot, "System32", "cmd.exe"), env.ComSpec ?? env.COMSPEC, which("cmd.exe", env)]
        : gitBashCandidates(programFiles, env, which);
  const executablePath = candidates.find((candidate): candidate is string => Boolean(
    candidate
    && exists(candidate)
    && (id !== "git-bash" || isGitForWindowsBash(candidate, exists)),
  ));
  return executablePath ? profile(id, executablePath) : undefined;
}

function gitBashCandidates(
  programFiles: string,
  env: NodeJS.ProcessEnv,
  which: (command: string, env: NodeJS.ProcessEnv) => string | undefined,
): Array<string | undefined> {
  const git = which("git.exe", env);
  return [
    win32.join(programFiles, "Git", "bin", "bash.exe"),
    git ? win32.resolve(win32.dirname(git), "..", "bin", "bash.exe") : undefined,
    which("bash.exe", env),
  ];
}

function isGitForWindowsBash(path: string, exists: (path: string) => boolean): boolean {
  const binDir = win32.dirname(win32.normalize(path));
  if (win32.basename(binDir).toLowerCase() !== "bin") return false;
  const parent = win32.dirname(binDir);
  const installRoot = win32.basename(parent).toLowerCase() === "usr"
    ? win32.dirname(parent)
    : parent;
  return exists(win32.join(installRoot, "cmd", "git.exe"));
}

function defaultWhich(command: string, env: NodeJS.ProcessEnv): string | undefined {
  const path = env.PATH ?? env.Path;
  return Bun.which(command, path ? { PATH: path } : undefined) ?? undefined;
}

function profile(id: ProcessShellId, executablePath: string): ResolvedShellProfile {
  if (id === "powershell-7") {
    return {
      id,
      executablePath,
      displayName: "PowerShell 7",
      modelGuidance: "Use PowerShell 7 syntax. Pipeline chain operators such as && and || are available.",
    };
  }
  if (id === "windows-powershell-5.1") {
    return {
      id,
      executablePath,
      displayName: "Windows PowerShell 5.1",
      modelGuidance: "Use Windows PowerShell 5.1 syntax. Do not use && or ||; use PowerShell conditionals such as `cmd1; if ($?) { cmd2 }` for dependent commands.",
    };
  }
  if (id === "cmd") {
    return {
      id,
      executablePath,
      displayName: "Command Prompt",
      modelGuidance: "Use cmd.exe syntax. Use && and || for conditional command chaining, %NAME% for environment variables, and quote paths containing spaces.",
    };
  }
  if (id === "git-bash") {
    return {
      id,
      executablePath,
      displayName: "Git Bash",
      modelGuidance: "Use Bash/POSIX command syntax. The shell runs without user profiles; quote paths containing spaces and account for Git for Windows path conversion.",
    };
  }
  return {
    id,
    executablePath,
    displayName: "/bin/sh",
    modelGuidance: "Use portable POSIX /bin/sh syntax.",
  };
}
