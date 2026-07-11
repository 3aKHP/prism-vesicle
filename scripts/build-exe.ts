import solidPlugin from "@opentui/solid/bun-plugin";
import { mkdir, rename, unlink } from "node:fs/promises";

// Bun 1.3's JS build API ignores `outfile` for compiled executables and emits
// the entry basename with a target-appropriate extension (`.exe` for Windows
// targets, none for Linux). Rename the emitted name to the package artifact
// name after each build instead of relying on `outfile`.
//
// From WSL we produce BOTH binaries:
//   - windows: cross-compiled PE (the dogfood `.exe` shipped to Windows users)
//   - linux:   host-native ELF (self-dogfood on the dev machine)
//
// Cross-compiling to Windows needs the `@opentui/core-win32-x64` native package
// present so the bundler can resolve OpenTUI's platform-conditional import.
// Bun's installer skips os-gated natives on a Linux host, so we fetch that one
// package on demand, version-matched to the installed `@opentui/core`.
//
// Usage:
//   bun run build:exe           # both PE and ELF
//   bun run build:exe windows   # PE only
//   bun run build:exe linux     # ELF only

type Target = { id: string; artifact: string; emitted: string };

const TARGETS: Record<string, Target> = {
  windows: { id: "bun-windows-x64", artifact: "prism-vesicle.exe", emitted: "main.exe" },
  linux: { id: "bun-linux-x64", artifact: "prism-vesicle", emitted: "main" },
};

const WIN32_NATIVE_DIR = "node_modules/@opentui/core-win32-x64";
const WIN32_NATIVE_MARKER = `${WIN32_NATIVE_DIR}/opentui.dll`;

// Bun standalone Workers must be explicit compile entrypoints. Keep this wrapper
// at the repository root: Bun 1.3 cannot resolve nested bunfs Worker entries
// reliably, while the emitted root entry is available as a `.js` module.
export const TREE_SITTER_WORKER_ENTRYPOINT = "tree-sitter-worker.ts";
export const TREE_SITTER_WORKER_RUNTIME_NAME = "tree-sitter-worker.js";
export const STANDALONE_BUILD_DEFINES = {
  VESICLE_COMPILED_BINARY: "true",
} as const;

export function treeSitterWorkerPathForTarget(targetId: string): string {
  const bunfsRoot = targetId.includes("windows") ? "B:/~BUN/root/" : "/$bunfs/root/";
  return `${bunfsRoot}${TREE_SITTER_WORKER_RUNTIME_NAME}`;
}

async function readInstalledCoreVersion(): Promise<string> {
  const pkg = await Bun.file("node_modules/@opentui/core/package.json").json();
  if (!pkg.version) {
    throw new Error("Could not read @opentui/core version from node_modules.");
  }
  return pkg.version as string;
}

async function ensureWin32Native(version: string): Promise<void> {
  if (await Bun.file(WIN32_NATIVE_MARKER).exists()) return;

  console.log(
    `Fetching @opentui/core-win32-x64@${version} (Bun's installer skips os-gated natives on Linux)...`,
  );
  const pack = Bun.spawn(
    ["npm", "pack", `@opentui/core-win32-x64@${version}`, "--pack-destination", "."],
    { stdout: "pipe", stderr: "inherit" },
  );
  const out = (await new Response(pack.stdout).text()).trim();
  const code = await pack.exited;
  if (code !== 0) throw new Error(`npm pack failed (exit ${code}). Is npm on PATH?`);

  const tarball = out
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .pop();
  if (!tarball) throw new Error("npm pack did not report a tarball filename.");

  await mkdir(WIN32_NATIVE_DIR, { recursive: true });
  const extract = Bun.spawn(
    ["tar", "-xzf", tarball, "-C", WIN32_NATIVE_DIR, "--strip-components", "1"],
    { stderr: "inherit" },
  );
  const extractCode = await extract.exited;
  await unlink(tarball).catch(() => undefined);
  if (extractCode !== 0) throw new Error(`tar extract failed (exit ${extractCode}).`);

  if (!(await Bun.file(WIN32_NATIVE_MARKER).exists())) {
    throw new Error(`Expected ${WIN32_NATIVE_MARKER} after extract; Windows cross-compile would fail.`);
  }
}

async function buildTarget(target: Target): Promise<void> {
  await Promise.all([
    Bun.file(target.artifact).delete().catch(() => undefined),
    Bun.file(target.emitted).delete().catch(() => undefined),
  ]);

  const result = await Bun.build({
    entrypoints: ["src/cli/main.ts", TREE_SITTER_WORKER_ENTRYPOINT],
    target: target.id as Bun.BuildConfig["target"],
    plugins: [solidPlugin],
    define: {
      ...STANDALONE_BUILD_DEFINES,
      OTUI_TREE_SITTER_WORKER_PATH: JSON.stringify(treeSitterWorkerPathForTarget(target.id)),
      VESICLE_TREE_SITTER_WORKER_PATH: JSON.stringify(treeSitterWorkerPathForTarget(target.id)),
    },
    compile: { autoloadBunfig: false },
  } as Bun.BuildConfig);

  if (!result.success) {
    for (const log of result.logs) console.error(log);
    throw new Error(`Build failed for target ${target.id}.`);
  }

  await rename(target.emitted, target.artifact);
  console.log(`Compiled ${target.artifact} (${target.id})`);
}

async function main(): Promise<void> {
  const arg = process.argv.slice(2).find((a) => a in TARGETS);
  const selected = arg ? [arg] : ["windows", "linux"];

  if (selected.includes("windows")) {
    await ensureWin32Native(await readInstalledCoreVersion());
  }

  for (const key of selected) {
    await buildTarget(TARGETS[key]);
  }
}

if (import.meta.main) await main();
