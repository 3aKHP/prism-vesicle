import { copyFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Absolute path to the CLI entrypoint, resolved from this support module. */
export const CLI_MAIN = join(import.meta.dir, "..", "..", "..", "src", "cli", "main.ts");

/** Secret-free canonical provider registry; used to seed an isolated config dir. */
const EXAMPLE_PROVIDERS = join(import.meta.dir, "..", "..", "..", "docs", "examples", "providers.yaml");

/**
 * Drop the canonical providers.yaml into an isolated config dir so commands
 * that read the provider registry (e.g. doctor) work without a host config.
 * Secrets stay absent — the example has none.
 */
export async function seedProvidersConfig(configDir: string): Promise<void> {
  await copyFile(EXAMPLE_PROVIDERS, join(configDir, "providers.yaml"));
}

/**
 * Environment variables carried into the spawned CLI. We intentionally do NOT
 * spread process.env: the journey must be hermetic, so real API keys and a
 * host VESICLE_PROVIDERS_FILE (which would override VESICLE_CONFIG_DIR) never
 * leak in. Only the vars the runtime, the shell resolver, and the OS need.
 */
const PASSTHROUGH_ENV = [
  "PATH",
  "HOME",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TZ",
  "APPDATA",
  "LOCALAPPDATA",
  "USERPROFILE",
  "SystemRoot",
  "COMSPEC",
  "TEMP",
  "TMP",
];

function buildChildEnv(configDir: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of PASSTHROUGH_ENV) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  env.VESICLE_CONFIG_DIR = configDir;
  return env;
}

export type CliRunOptions = {
  cwd: string;
  configDir: string;
  /** Extra argv after the command path (e.g. ["--dangerously-skip-permissions"]). */
  extra?: string[];
};

export type CliRunResult = {
  exitCode: number | null;
  stdout: string;
  stderr: string;
};

/**
 * Spawn the source CLI as a real subprocess: `bun src/cli/main.ts <args>` with
 * an isolated config dir and cwd. Returns captured stdout/stderr and exit code.
 * A 30s abort guard keeps a runaway command from hanging the suite.
 */
export async function runCli(args: string[], options: CliRunOptions): Promise<CliRunResult> {
  const argv = [process.execPath, CLI_MAIN, ...(options.extra ?? []), ...args];
  const child = Bun.spawn(argv, {
    cwd: options.cwd,
    stdout: "pipe",
    stderr: "pipe",
    env: buildChildEnv(options.configDir),
    signal: AbortSignal.timeout(30_000),
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { exitCode, stdout, stderr };
}

/** Create an isolated temp project dir; removed after the callback returns. */
export async function withTempProject<T>(
  prefix: string,
  fn: (projectDir: string, configDir: string) => Promise<T>,
): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  const projectDir = join(root, "project");
  const configDir = join(root, "config");
  await mkdir(projectDir, { recursive: true });
  await mkdir(configDir, { recursive: true });
  try {
    return await fn(projectDir, configDir);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
