import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import packageJson from "../package.json";

export {};

const skipTui = process.platform === "win32" || process.argv.includes("--skip-tui");
const packageDir = await mkdtemp(join(tmpdir(), "prism-vesicle-pack-"));
const globalPrefix = await mkdtemp(join(tmpdir(), "prism-vesicle-global-"));
const localProject = await mkdtemp(join(tmpdir(), "prism-vesicle-local-"));
const invocationProject = await mkdtemp(join(tmpdir(), "prism-vesicle-project-"));
const explicitProject = await mkdtemp(join(tmpdir(), "prism-vesicle-explicit-"));
const configDir = await mkdtemp(join(tmpdir(), "prism-vesicle-config-"));

try {
  await writeProviderConfig(configDir);
  await runInherited(["npm", "pack", "--pack-destination", packageDir], process.cwd());
  const tarballName = (await readdir(packageDir)).find((entry) => entry.endsWith(".tgz"));
  if (!tarballName) throw new Error("npm pack did not create a tarball.");
  const tarball = join(packageDir, tarballName);

  const globalInstall = await runCaptured(["npm", "install", "-g", "--prefix", globalPrefix, tarball], invocationProject);
  assertCleanInstall("global-prefix install", globalInstall);
  const globalTree = await runCaptured(["npm", "ls", "-g", "--prefix", globalPrefix, "--all"], invocationProject);
  assertCleanTree("global-prefix dependency tree", globalTree);
  const globalExecutable = npmExecutable(globalPrefix, true);
  await assertInstalledCli(globalExecutable, invocationProject, configDir);

  await writeFile(join(localProject, "package.json"), '{"name":"vesicle-clean-consumer","version":"1.0.0","private":true}\n');
  const localInstall = await runCaptured(["npm", "install", tarball], localProject);
  assertCleanInstall("local lockfile install", localInstall);
  const localTree = await runCaptured(["npm", "ls", "--all"], localProject);
  assertCleanTree("local lockfile dependency tree", localTree);
  const audit = await runCaptured(["npm", "audit", "--omit=dev", "--audit-level=low"], localProject);
  if (audit.exitCode !== 0 || !/found 0 vulnerabilities/i.test(audit.output)) {
    throw new Error(`local consumer audit failed:\n${audit.output.slice(-4000)}`);
  }
  const localExecutable = npmExecutable(join(localProject, "node_modules"), false);
  await assertInstalledCli(localExecutable, localProject, configDir);

  await runInherited(
    [globalExecutable, "assets", "materialize", "assets/prompts/engines/etl.md", "--global"],
    invocationProject,
    configDir,
  );
  await runInherited([globalExecutable, "assets", "status"], invocationProject, configDir);
  await runInherited([globalExecutable, "assets", "init"], invocationProject, configDir);
  await runInherited([globalExecutable, "prompt", "shape", "--engine", "etl"], invocationProject, configDir);

  if (!skipTui) {
    await assertTuiStartup(globalExecutable, invocationProject, [], configDir, "global-prefix bare startup");
    await assertTuiStartup(
      globalExecutable,
      invocationProject,
      [explicitProject],
      configDir,
      "explicit project child startup",
      explicitProject,
    );
  }

  console.log(
    `npm package consumer smoke passed (${skipTui ? "global/local install and runtime diagnostics" : "global/local install, audit, and PTY TUI startup"}).`,
  );
} finally {
  await Promise.all(
    [packageDir, globalPrefix, localProject, invocationProject, explicitProject, configDir].map((directory) =>
      rm(directory, { recursive: true, force: true })
    ),
  );
}

type CapturedRun = { exitCode: number; output: string };

async function runCaptured(command: string[], cwd: string, configDirectory?: string): Promise<CapturedRun> {
  const child = Bun.spawn(spawnCommand(command), {
    cwd,
    env: runtimeEnv(configDirectory),
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { exitCode, output: `${stdout}${stderr}` };
}

async function runInherited(command: string[], cwd: string, configDirectory?: string): Promise<void> {
  const child = Bun.spawn(spawnCommand(command), {
    cwd,
    env: runtimeEnv(configDirectory),
    stdin: "ignore",
    stdout: "inherit",
    stderr: "inherit",
  });
  const exitCode = await child.exited;
  if (exitCode !== 0) throw new Error(`${command.join(" ")} failed (exit ${exitCode}).`);
}

function runtimeEnv(configDirectory?: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    ...(configDirectory
      ? {
        VESICLE_CONFIG_DIR: configDirectory,
        VESICLE_PROVIDERS_FILE: join(configDirectory, "providers.yaml"),
      }
      : {}),
  };
}

function assertCleanInstall(label: string, result: CapturedRun): void {
  if (result.exitCode !== 0) throw new Error(`${label} failed:\n${result.output.slice(-4000)}`);
  if (/npm warn|ERESOLVE|deprecated|peer dependency/i.test(result.output)) {
    throw new Error(`${label} emitted a warning:\n${result.output.slice(-4000)}`);
  }
}

function assertCleanTree(label: string, result: CapturedRun): void {
  if (result.exitCode !== 0 || /invalid|extraneous|ELSPROBLEMS/i.test(result.output)) {
    throw new Error(`${label} is not clean:\n${result.output.slice(-6000)}`);
  }
  const forbidden = [
    "@opentui/solid",
    "@opentui/keymap",
    "solid-js",
    "@babel/core",
    "babel-plugin-module-resolver",
    "glob@",
  ].filter((dependency) => result.output.includes(dependency));
  if (forbidden.length > 0) {
    throw new Error(`${label} contains compiler-only dependencies: ${forbidden.join(", ")}`);
  }
}

async function assertInstalledCli(executable: string, cwd: string, configDirectory: string): Promise<void> {
  for (const flag of ["--version", "-v"]) {
    const result = await runCaptured([executable, flag], cwd, configDirectory);
    if (result.exitCode !== 0 || result.output.trim() !== packageJson.version) {
      throw new Error(`${flag} printed "${result.output.trim()}", expected ${packageJson.version}.`);
    }
  }
  await runInherited([executable, "prompt", "shape", "--engine", "etl"], cwd, configDirectory);
  await runInherited([executable, "debug", "markdown-runtime"], cwd, configDirectory);
}

async function assertTuiStartup(
  executable: string,
  cwd: string,
  args: string[],
  configDirectory: string,
  label: string,
  expectedProject = cwd,
): Promise<void> {
  const shellCommand = [executable, ...args].map(shellQuote).join(" ");
  const child = Bun.spawn(["script", "-qefc", shellCommand, "/dev/null"], {
    cwd,
    env: {
      ...runtimeEnv(configDirectory),
      TERM: "xterm-256color",
      COLUMNS: "100",
      LINES: "30",
      VESICLE_DEBUG_LOG: "1",
      VESICLE_REDUCED_MOTION: "1",
    },
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  let exited = false;
  const exitPromise = child.exited.then((exitCode) => {
    exited = true;
    return exitCode;
  });
  const stdoutPromise = new Response(child.stdout).text();
  const stderrPromise = new Response(child.stderr).text();

  await Bun.sleep(2500);
  if (exited) {
    const [exitCode, stdout, stderr] = await Promise.all([exitPromise, stdoutPromise, stderrPromise]);
    throw new Error(`${label} exited before interaction (${exitCode}):\n${`${stdout}${stderr}`.slice(-6000)}`);
  }

  child.stdin.write("\x11");
  child.stdin.flush();
  const exitCode = await Promise.race([exitPromise, Bun.sleep(10000).then(() => undefined)]);
  if (exitCode === undefined) {
    child.kill();
    throw new Error(`${label} did not terminate after Ctrl+Q.`);
  }
  child.stdin.end();
  const [stdout, stderr] = await Promise.all([stdoutPromise, stderrPromise]);
  const output = `${stdout}${stderr}`;
  if (exitCode !== 0) throw new Error(`${label} exited ${exitCode}:\n${output.slice(-6000)}`);
  if (/react\/jsx-dev-runtime|Cannot find module|ModuleNotFound|Bun v\d|native library|parser worker/i.test(output)) {
    throw new Error(`${label} reported a runtime failure:\n${output.slice(-6000)}`);
  }

  const debugLog = join(expectedProject, ".vesicle", "logs", "tui-debug.log");
  const debug = await readFile(debugLog, "utf8").catch(() => "");
  if (!debug.includes(`"cwd":"${expectedProject}"`)) {
    throw new Error(`${label} did not prove the expected project cwd in ${debugLog}.`);
  }
  if (/uncaughtException|unhandledRejection|markdown diagnostics failed|tree-sitter .* (?:error|threw)/i.test(debug)) {
    throw new Error(`${label} debug log contains a runtime failure:\n${debug.slice(-6000)}`);
  }
}

function npmExecutable(root: string, global: boolean): string {
  if (process.platform === "win32") {
    return global ? join(root, "vesicle.cmd") : join(root, ".bin", "vesicle.cmd");
  }
  return join(root, global ? "bin" : ".bin", "vesicle");
}

function spawnCommand(command: string[]): string[] {
  const executable = command[0] ?? "";
  if (process.platform !== "win32" || (executable !== "npm" && !executable.toLowerCase().endsWith(".cmd"))) {
    return command;
  }
  return [
    process.env.ComSpec ?? "cmd.exe",
    "/d",
    "/s",
    "/c",
    command.map(quoteWindowsCommandArgument).join(" "),
  ];
}

function quoteWindowsCommandArgument(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

async function writeProviderConfig(directory: string): Promise<void> {
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "providers.yaml"), [
    "default:",
    "  provider: smoke",
    "  model: smoke-model",
    "providers:",
    "  smoke:",
    "    protocol: openai-chat-compatible",
    "    baseUrl: http://127.0.0.1:9/v1",
    "    apiKeyEnv: VESICLE_SMOKE_UNUSED_KEY",
    "    models:",
    "      - smoke-model",
    "",
  ].join("\n"));
}
