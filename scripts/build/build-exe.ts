import solidPlugin from "@3akhp/opentui-solid/bun-plugin";
import { mkdir, rm, rename, unlink } from "node:fs/promises";
import packageJson from "../../package.json";
import { numericFileVersion } from "./windows-version";

// Bun 1.3's JS build API ignores `outfile` for compiled executables and emits
// the entry basename with a target-appropriate extension (`.exe` for Windows
// targets, none for Linux). Rename the emitted name to the package artifact
// name after each build instead of relying on `outfile`.
//
// From WSL we produce BOTH binaries:
//   - windows: explicitly non-release cross-compiled PE for build diagnostics
//   - linux:   host-native ELF (self-dogfood on the dev machine)
//
// Cross-compiling to Windows needs the `@3akhp/opentui-core-win32-x64` native package
// present so the bundler can resolve OpenTUI's platform-conditional import.
// Bun's installer skips os-gated natives on a Linux host, so we fetch that one
// package on demand, version-matched to the installed `@3akhp/opentui-core`.
//
// Usage:
//   bun run build:exe           # both PE and ELF
//   bun run build:exe windows   # PE only
//   bun run build:exe linux     # ELF only

type Target = { id: string; artifact: string; emitted: string };

export const WINDOWS_RELEASE_ARTIFACT = "prism-vesicle.exe";
export const WINDOWS_CROSS_ARTIFACT = "prism-vesicle-cross-windows-x64.exe";
export function windowsArtifactForHost(platform: NodeJS.Platform): string {
  return platform === "win32" ? WINDOWS_RELEASE_ARTIFACT : WINDOWS_CROSS_ARTIFACT;
}
const TARGETS: Record<string, Target> = {
  windows: { id: "bun-windows-x64", artifact: windowsArtifactForHost(process.platform), emitted: "main.exe" },
  linux: { id: "bun-linux-x64", artifact: "prism-vesicle", emitted: "main" },
};

const WIN32_NATIVE_DIR = "node_modules/@3akhp/opentui-core-win32-x64";
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
  const pkg = await Bun.file("node_modules/@3akhp/opentui-core/package.json").json();
  if (!pkg.version) {
    throw new Error("Could not read @3akhp/opentui-core version from node_modules.");
  }
  return pkg.version as string;
}

async function readFetchedWin32Version(): Promise<string | undefined> {
  try {
    const pkg = await Bun.file(`${WIN32_NATIVE_DIR}/package.json`).json();
    return typeof pkg.version === "string" ? pkg.version : undefined;
  } catch {
    return undefined;
  }
}

async function ensureWin32Native(version: string): Promise<void> {
  // Bun's installer never manages this os-gated directory on a Linux host,
  // so a previously fetched copy survives dependency version bumps; refetch
  // whenever the marker or the fetched version disagrees with the core.
  if ((await readFetchedWin32Version()) === version && (await Bun.file(WIN32_NATIVE_MARKER).exists())) return;
  await rm(WIN32_NATIVE_DIR, { recursive: true, force: true });

  console.log(
    `Fetching @3akhp/opentui-core-win32-x64@${version} (Bun's installer skips os-gated natives on Linux)...`,
  );
  const pack = Bun.spawn(
    ["npm", "pack", `@3akhp/opentui-core-win32-x64@${version}`, "--pack-destination", "."],
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

  const isNativeWindowsBuild = target.id.includes("windows") && process.platform === "win32";
  const compile: Bun.BuildConfig["compile"] = {
    autoloadBunfig: false,
    ...(isNativeWindowsBuild
      ? {
        windows: {
          icon: "brand/windows/prism-vesicle.ico",
          title: "Prism Vesicle",
          publisher: "3aKHP",
          version: numericFileVersion(packageJson.version),
          description: packageJson.description,
          copyright: "Copyright (c) 2026 3aKHP",
        },
      }
      : {}),
  };
  const result = await Bun.build({
    entrypoints: ["src/cli/main.ts", TREE_SITTER_WORKER_ENTRYPOINT],
    target: target.id as Bun.BuildConfig["target"],
    plugins: [solidPlugin],
    define: {
      ...STANDALONE_BUILD_DEFINES,
      OTUI_TREE_SITTER_WORKER_PATH: JSON.stringify(treeSitterWorkerPathForTarget(target.id)),
      VESICLE_TREE_SITTER_WORKER_PATH: JSON.stringify(treeSitterWorkerPathForTarget(target.id)),
    },
    compile,
  } as Bun.BuildConfig);

  if (!result.success) {
    for (const log of result.logs) console.error(log);
    throw new Error(`Build failed for target ${target.id}.`);
  }

  await rename(target.emitted, target.artifact);
  console.log(`Compiled ${target.artifact} (${target.id}${isNativeWindowsBuild ? ", branded native Windows" : target.id.includes("windows") ? ", cross-build without Windows resources" : ""})`);
}

async function main(): Promise<void> {
  const arg = process.argv.slice(2).find((a) => a in TARGETS);
  const selected = arg ? [arg] : ["windows", "linux"];

  if (selected.includes("windows")) {
    // A stale artifact from the other host class must never be mistaken for the
    // output of this build (especially by installer staging on WSL).
    const incompatibleArtifact = process.platform === "win32" ? WINDOWS_CROSS_ARTIFACT : WINDOWS_RELEASE_ARTIFACT;
    await Bun.file(incompatibleArtifact).delete().catch(() => undefined);
    const { buildWindowsIcons } = await import("./build-windows-icon");
    await buildWindowsIcons(true);
    await ensureWin32Native(await readInstalledCoreVersion());
  }

  for (const key of selected) {
    await buildTarget(TARGETS[key]);
  }
}

if (import.meta.main) await main();
