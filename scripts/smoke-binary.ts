/**
 * Standalone binary smoke (Phase 7 B): drive the compiled prism-vesicle
 * executable through happy-path and failure-path scenarios from an isolated
 * deployment dir (binary + assets beside it, the real release shape).
 *
 * Distinct from the CLI source journey (A), which runs `bun src/cli/main.ts`:
 * this proves the COMPILED artifact loads its embedded tree-sitter worker,
 * resolves runtime assets beside the executable, and fails closed when a
 * required asset is corrupt.
 *
 * Usage:
 *   bun run build:exe linux      # (or windows) -> ./prism-vesicle[.exe]
 *   bun run scripts/smoke-binary.ts
 *
 * Override the binary path with VESICLE_BIN. Exits non-zero if any scenario
 * fails. Does not run under `bun test`; invoke it explicitly (CI release lane).
 */
import { copyFile, cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export {};

// Resolve from this module's location so the script works regardless of the
// invocation cwd (e.g. `bun run smoke:binary` from anywhere, not just root).
const REPO_ROOT = join(import.meta.dir, "..");
const BINARY_PATH =
  process.env.VESICLE_BIN ??
  join(REPO_ROOT, process.platform === "win32" ? "prism-vesicle.exe" : "prism-vesicle");

type ScenarioResult = { name: string; ok: boolean; detail: string };
type SpawnResult = { exitCode: number | null; stdout: string; stderr: string };

// Hermetic env: carry only what the runtime, shell resolver, and OS need, and
// never a host VESICLE_PROVIDERS_FILE (it overrides VESICLE_CONFIG_DIR) or any
// real API key. Same surface as the CLI journey in tests/integration/cli.
const PASSTHROUGH_ENV = [
  "PATH",
  "HOME",
  "USERPROFILE",
  "APPDATA",
  "LOCALAPPDATA",
  "SystemRoot",
  "COMSPEC",
  "LANG",
  "LC_ALL",
  "TZ",
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

async function runBinary(
  binary: string,
  args: string[],
  cwd: string,
  configDir: string,
): Promise<SpawnResult> {
  const child = Bun.spawn([binary, ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    env: buildChildEnv(configDir),
    signal: AbortSignal.timeout(30_000),
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { exitCode, stdout, stderr };
}

async function main(): Promise<void> {
  if (!(await Bun.file(BINARY_PATH).exists())) {
    throw new Error(`Binary not found at ${BINARY_PATH}. Run \`bun run build:exe\` first.`);
  }
  // Stage the release shape: binary + assets + host-assets + manifest together,
  // so the executable resolves runtime assets beside itself (dirname(execPath)).
  const root = await mkdtemp(join(tmpdir(), "prism-vesicle-bin-smoke-"));
  const release = join(root, "release");
  const project = join(root, "project");
  const config = join(root, "config");
  const binary = join(release, `prism-vesicle${process.platform === "win32" ? ".exe" : ""}`);
  await mkdir(release, { recursive: true });
  await mkdir(project, { recursive: true });
  await mkdir(config, { recursive: true });
  await cp(BINARY_PATH, binary);
  await cp(join(REPO_ROOT, "assets"), join(release, "assets"), { recursive: true });
  await cp(join(REPO_ROOT, "host-assets"), join(release, "host-assets"), { recursive: true });
  await copyFile(join(REPO_ROOT, "harness-manifest.json"), join(release, "harness-manifest.json"));
  // doctor requires a provider registry; seed the secret-free canonical example.
  await copyFile(
    join(REPO_ROOT, "docs", "examples", "providers.yaml"),
    join(config, "providers.yaml"),
  );

  const results: ScenarioResult[] = [];
  const scenario = async (name: string, fn: () => Promise<void>): Promise<void> => {
    try {
      await fn();
      results.push({ name, ok: true, detail: "ok" });
    } catch (error) {
      results.push({ name, ok: false, detail: error instanceof Error ? error.message : String(error) });
    }
  };

  const assert = (condition: boolean, message: string): void => {
    if (!condition) throw new Error(message);
  };

  await scenario("debug markdown-runtime loads the embedded tree-sitter worker", async () => {
    const r = await runBinary(binary, ["debug", "markdown-runtime"], project, config);
    assert(r.exitCode === 0, `exit ${r.exitCode}; stderr=${r.stderr.slice(0, 200)}`);
    const parsed = JSON.parse(r.stdout.trim()) as { ok: boolean };
    assert(parsed.ok === true, `expected ok=true, got ${String(r.stdout.slice(0, 200))}`);
  });

  await scenario("assets status resolves runtime assets beside the executable", async () => {
    const r = await runBinary(binary, ["assets", "status"], project, config);
    assert(r.exitCode === 0, `exit ${r.exitCode}; stderr=${r.stderr.slice(0, 200)}`);
    assert(r.stdout.includes("Prism Vesicle Assets"), `missing header; stdout=${r.stdout.slice(0, 200)}`);
  });

  await scenario("doctor reports the invocation cwd and isolated config dir", async () => {
    const r = await runBinary(binary, ["doctor"], project, config);
    assert(r.exitCode === 0, `exit ${r.exitCode}; stderr=${r.stderr.slice(0, 200)}`);
    assert(r.stdout.includes("Prism Vesicle Doctor"), `missing header; stdout=${r.stdout.slice(0, 200)}`);
    assert(r.stdout.includes(`Project: ${project}`), `cwd not reported; got ${r.stdout.slice(0, 200)}`);
    assert(r.stdout.includes(config), `config dir not reported; got ${r.stdout.slice(0, 200)}`);
  });

  await scenario("fail-closed: a corrupt Harness manifest makes assets status exit non-zero", async () => {
    await writeFile(join(release, "harness-manifest.json"), "{ not a valid manifest }}}", "utf8");
    const r = await runBinary(binary, ["assets", "status"], project, config);
    assert(
      r.exitCode !== 0,
      `expected non-zero exit on corrupt manifest, got ${r.exitCode}; stdout=${r.stdout.slice(0, 200)}`,
    );
    // Fail-closed means it stops with a concise user-facing error and does not
    // silently proceed with corrupt data.
    assert(
      /manifest/i.test(r.stderr) || /manifest/i.test(r.stdout),
      `expected a manifest-related error; stderr=${r.stderr.slice(0, 200)}`,
    );
    assert(
      !r.stderr.includes("/$bunfs/") && !r.stderr.includes("src/cli/") && !r.stderr.includes("Bun v"),
      `expected a clean user-facing error without a runtime stack; stderr=${r.stderr.slice(0, 200)}`,
    );
  });

  await rm(root, { recursive: true, force: true });

  const failed = results.filter((r) => !r.ok);
  for (const r of results) {
    const tag = r.ok ? "PASS" : "FAIL";
    console.log(`[${tag}] ${r.name}${r.ok ? "" : ` — ${r.detail}`}`);
  }
  console.log(`\n${results.length - failed.length}/${results.length} binary smoke scenarios passed.`);
  if (failed.length > 0) {
    throw new Error(`${failed.length} binary smoke scenario(s) failed.`);
  }
  console.log("Standalone binary smoke passed.");
}

await main();
