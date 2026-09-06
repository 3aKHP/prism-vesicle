import { existsSync } from "node:fs";
import { win32 } from "node:path";

export const shellInterpreterPreferences = [
  "auto",
  "posix-sh",
  "bash",
  "zsh",
  "fish",
  "nushell",
  "powershell-7",
  "windows-powershell-5.1",
  "cmd",
  "git-bash",
] as const;

export type ShellInterpreterPreference = (typeof shellInterpreterPreferences)[number];
export type ProcessShellId = Exclude<ShellInterpreterPreference, "auto">;
type WindowsShellInterpreter = Exclude<ShellInterpreterPreference, "auto" | "posix-sh" | "bash" | "zsh" | "fish" | "nushell">;

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
    if (preference === "auto" || preference === "posix-sh") return profile("posix-sh", "/bin/sh");
    if (preference !== "bash" && preference !== "zsh" && preference !== "fish" && preference !== "nushell") return undefined;
    const env = options.env ?? process.env;
    const which = options.which ?? defaultWhich;
    const exists = options.exists ?? existsSync;
    const home = env.HOME;
    const candidates: Record<"bash" | "zsh" | "fish" | "nushell", string[]> = {
      bash: [which("bash", env), "/bin/bash", "/usr/bin/bash"].filter((path): path is string => Boolean(path)),
      zsh: [which("zsh", env), "/bin/zsh", "/usr/bin/zsh"].filter((path): path is string => Boolean(path)),
      fish: [which("fish", env), "/usr/bin/fish", "/bin/fish"].filter((path): path is string => Boolean(path)),
      nushell: [which("nu", env), "/usr/bin/nu", "/usr/local/bin/nu", home ? `${home}/.cargo/bin/nu` : ""].filter((path): path is string => Boolean(path)),
    };
    const executablePath = candidates[preference].find((path) => exists(path));
    return executablePath ? profile(preference, executablePath) : undefined;
  }
  if (preference === "posix-sh") return undefined;

  const env = options.env ?? process.env;
  const which = options.which ?? defaultWhich;
  const exists = options.exists ?? existsSync;
  if (preference === "nushell") {
    const userProfile = env.USERPROFILE ?? env.HOME;
    const candidates = [which("nu.exe", env), userProfile ? win32.join(userProfile, ".cargo", "bin", "nu.exe") : undefined];
    const executablePath = candidates.find((candidate): candidate is string => Boolean(candidate && exists(candidate)));
    return executablePath ? profile("nushell", executablePath) : undefined;
  }
  if (preference === "bash" || preference === "zsh" || preference === "fish") return undefined;
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

export function buildShellInvocation(profileValue: ResolvedShellProfile, command: string): string[] {
  if ((profileValue.id as string) === "powershell") {
    return [profileValue.executablePath, "-NoLogo", "-NoProfile", "-NonInteractive", "-Command", command];
  }
  if (profileValue.id === "bash") return [profileValue.executablePath, "--noprofile", "--norc", "-c", command];
  if (profileValue.id === "zsh") return [profileValue.executablePath, "-f", "-c", command];
  if (profileValue.id === "fish") return [profileValue.executablePath, "--no-config", "-c", command];
  if (profileValue.id === "nushell") return [profileValue.executablePath, "-n", "-c", command];
  if (profileValue.id === "powershell-7" || profileValue.id === "windows-powershell-5.1") {
    return [profileValue.executablePath, "-NoLogo", "-NoProfile", "-NonInteractive", "-Command", command];
  }
  if (profileValue.id === "cmd") return [profileValue.executablePath, "/D", "/S", "/C", `chcp 65001>nul & ${command}`];
  if (profileValue.id === "git-bash") return [profileValue.executablePath, "--noprofile", "--norc", "-c", command];
  return [profileValue.executablePath, "-c", command];
}

export async function probeNushellProfile(profileValue: ResolvedShellProfile, cwd = process.cwd()): Promise<{ ok: true } | { ok: false; error: string }> {
  if (profileValue.id !== "nushell") return { ok: true };
  let child: Bun.Subprocess | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    child = Bun.spawn(buildShellInvocation(profileValue, "print ''"), {
      cwd,
      env: filteredProbeEnvironment(),
      stdin: "ignore",
      stdout: "ignore",
      stderr: "pipe",
      ...(process.platform === "win32" ? { windowsHide: true } : { detached: true }),
    });
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        child?.kill();
        reject(new Error("startup probe timed out after 5000 ms"));
      }, 5_000);
    });
    const stderrStream = child.stderr && typeof child.stderr !== "number" ? child.stderr : undefined;
    const result = await Promise.race([
      Promise.all([child.exited, stderrStream ? new Response(stderrStream).text() : Promise.resolve("")]),
      timeout,
    ]);
    const [exitCode, stderr] = result;
    if (exitCode === 0) return { ok: true };
    return { ok: false, error: stderr.trim().slice(0, 240) || `exit code ${exitCode}` };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function filteredProbeEnvironment(): Record<string, string> {
  const keys = ["PATH", "PATHEXT", "SystemRoot", "WINDIR", "COMSPEC", "HOME", "USERPROFILE", "APPDATA", "XDG_CONFIG_HOME", "TEMP", "TMP", "LANG", "LC_ALL", "TERM"];
  return Object.fromEntries(keys.flatMap((key) => process.env[key] === undefined ? [] : [[key, process.env[key]!]]));
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
  if (id === "bash") {
    return { id, executablePath, displayName: "Bash", modelGuidance: "Use Bash syntax. The shell runs without user profiles; use $NAME for variables, && and || for conditional chaining, and quote paths containing spaces." };
  }
  if (id === "zsh") {
    return { id, executablePath, displayName: "Zsh", modelGuidance: "Use Zsh/POSIX command syntax. The shell runs without user startup files; quote paths containing spaces and use && or || for dependent command chaining." };
  }
  if (id === "fish") {
    return { id, executablePath, displayName: "Fish", modelGuidance: "Use Fish syntax. Variables use $NAME, command substitution uses parentheses, and the shell runs without user configuration." };
  }
  if (id === "nushell") {
    return { id, executablePath, displayName: "Nushell", modelGuidance: "Use Nushell syntax. Pipelines pass structured values, variables use $name, conditions use Nushell expressions, and the shell runs without user configuration." };
  }
  return {
    id,
    executablePath,
    displayName: "/bin/sh",
    modelGuidance: "Use portable POSIX /bin/sh syntax.",
  };
}
