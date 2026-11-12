import { appendFile } from "node:fs/promises";
import { relative, resolve } from "node:path";

/** Rust inputs at any depth must not silently fall outside the CI lane. */
export function rustWorkspaceInputs(files: string[]): string[] {
  return files.filter((path) => /(?:\.rs$|(?:^|\/)(?:Cargo\.(?:toml|lock)|rust-toolchain(?:\.toml)?)$|(?:^|\/)\.cargo\/)/.test(path));
}

export function requireRustWorkspace(files: string[]): boolean {
  if (!rustWorkspaceInputs(files).length) return false;
  for (const required of ["Cargo.toml", "Cargo.lock", "rust-toolchain.toml"]) {
    if (!files.includes(required)) throw new Error(`Rust inputs require tracked root ${required}; update the CI contract explicitly for another workspace layout.`);
  }
  return true;
}

export function requirePinnedCompiler(version: string, pin: string): void {
  if (!version.startsWith(`rustc ${pin} (`)) {
    throw new Error(`Effective rustc does not match pinned ${pin}: ${version.trim()}. Remove conflicting toolchain overrides.`);
  }
}

async function command(root: string, args: string[], capture = false): Promise<string> {
  const child = Bun.spawn(args, { cwd: root, stdout: capture ? "pipe" : "inherit", stderr: "inherit" });
  const output = capture ? await new Response(child.stdout).text() : "";
  if (await child.exited !== 0) throw new Error(`Rust verification failed: ${args.join(" ")}`);
  return output;
}

export async function verifyRustWorkspace(root: string, detectOnly = false, installToolchain = false): Promise<boolean> {
  const files = (await command(root, ["git", "ls-files", "-z"], true)).split("\0").filter(Boolean);
  if (!requireRustWorkspace(files)) return false;
  const toolchain = Bun.TOML.parse(await Bun.file(resolve(root, "rust-toolchain.toml")).text());
  const settings = "toolchain" in toolchain ? toolchain.toolchain : undefined;
  if (!settings || typeof settings !== "object" || !("channel" in settings) || typeof settings.channel !== "string" || !/^\d+\.\d+\.\d+$/.test(settings.channel)) {
    throw new Error("rust-toolchain.toml must pin an exact stable version (major.minor.patch).");
  }
  const components = "components" in settings ? settings.components : undefined;
  if (!Array.isArray(components) || !["rustfmt", "clippy"].every((name) => components.includes(name))) {
    throw new Error("rust-toolchain.toml must request rustfmt and clippy components.");
  }
  if (detectOnly) return true;
  if (installToolchain) await command(root, ["rustup", "toolchain", "install", settings.channel, "--profile", "minimal", "--component", "rustfmt", "--component", "clippy"]);
  // Select the distribution explicitly, overriding directory/environment state.
  // Cargo has its own component version: e.g. Rust 1.56.1 ships Cargo 1.56.0.
  const pinned = ["rustup", "run", settings.channel];
  requirePinnedCompiler(await command(root, [...pinned, "rustc", "--version"], true), settings.channel);
  const cargo = [...pinned, "cargo"];
  // --workspace would otherwise silently ignore a second, unlisted crate.
  const metadata: unknown = JSON.parse(await command(root, [...cargo, "metadata", "--no-deps", "--locked", "--format-version", "1"], true));
  if (!metadata || typeof metadata !== "object" || !("packages" in metadata) || !Array.isArray(metadata.packages) || !("workspace_members" in metadata) || !Array.isArray(metadata.workspace_members)) {
    throw new Error("Cargo metadata omitted workspace membership.");
  }
  const members = new Set(metadata.workspace_members);
  const manifests = new Set(["Cargo.toml"]);
  for (const pkg of metadata.packages) {
    if (!pkg || typeof pkg.id !== "string" || typeof pkg.manifest_path !== "string") throw new Error("Malformed Cargo package metadata.");
    if (members.has(pkg.id)) manifests.add(relative(root, pkg.manifest_path).replaceAll("\\", "/"));
  }
  for (const file of files.filter((path) => path.endsWith("/Cargo.toml"))) {
    if (!manifests.has(file)) throw new Error(`Tracked manifest outside the verified workspace: ${file}`);
  }
  await command(root, [...cargo, "fmt", "--all", "--", "--check"]);
  await command(root, [...cargo, "clippy", "--workspace", "--all-targets", "--locked", "--", "-D", "warnings"]);
  await command(root, [...cargo, "test", "--workspace", "--all-targets", "--locked"]);
  return true;
}

if (import.meta.main) {
  const detectOnly = process.argv.includes("--detect");
  try {
    const enabled = await verifyRustWorkspace(process.cwd(), detectOnly, process.argv.includes("--install-toolchain"));
    if (detectOnly && process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, `enabled=${enabled}\n`);
    console.log(enabled ? (detectOnly ? "Rust workspace detected; execution required." : "Rust workspace verification passed.") : "SKIP: no tracked Rust workspace inputs; no Cargo validation performed.");
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
