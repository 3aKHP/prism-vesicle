import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { requirePinnedCompiler, requireRustWorkspace, rustWorkspaceInputs, verifyRustWorkspace } from "../../../scripts/check/rust-workspace.ts";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function repository(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "vesicle-rust-routing-"));
  roots.push(root);
  git(root, "init", "-b", "fixture");
  git(root, "config", "user.email", "fixture@example.invalid");
  git(root, "config", "user.name", "Fixture");
  git(root, "config", "commit.gpgsign", "false");
  git(root, "config", "core.hooksPath", join(root, "absent-hooks"));
  await Bun.write(join(root, "README.md"), "fixture\n");
  git(root, "add", ".");
  git(root, "commit", "-m", "baseline");
  git(root, "branch", "baseline");
  return root;
}

function git(root: string, ...args: string[]): void {
  const result = Bun.spawnSync(["git", ...args], { cwd: root, stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error(result.stderr.toString());
}

function reviewGate(root: string, base = "baseline"): { trigger: boolean; reasons: string[] } {
  const result = Bun.spawnSync(["bash", resolve("scripts/check/deep-cr-trigger.sh"), base], { cwd: root, stdout: "pipe", stderr: "pipe" });
  expect(result.exitCode).toBe(0);
  return JSON.parse(result.stdout.toString());
}

describe.skipIf(process.platform === "win32")("review routing on real committed diffs", () => {
  test("tiny Rust changes in an unknown directory require deep review, including removal", async () => {
    const root = await repository();
    await Bun.write(join(root, "unexpected/new-domain/transport.rs"), "pub fn send() {}\n");
    git(root, "add", ".");
    git(root, "commit", "-m", "new domain");
    expect(reviewGate(root).trigger).toBe(true);
    git(root, "branch", "with-rust");
    git(root, "mv", "unexpected/new-domain/transport.rs", "unexpected/new-domain/notes.txt");
    git(root, "commit", "-m", "rename away");
    expect(reviewGate(root, "with-rust").trigger).toBe(true);
  });

  test("nested Cargo and toolchain changes cannot use the size exemption", async () => {
    for (const path of ["unknown/Cargo.toml", "unknown/Cargo.lock", "unknown/.cargo/config.toml", "rust-toolchain.toml"]) {
      const root = await repository();
      await Bun.write(join(root, path), "fixture\n");
      git(root, "add", ".");
      git(root, "commit", "-m", "build input");
      expect(reviewGate(root).trigger).toBe(true);
    }
  });

  test("Git-quoted paths cannot hide Rust inputs", async () => {
    for (const path of ['crates/a"b/src/lib.rs', "crates/a\tb/Cargo.toml", "crates/a\nb/.cargo/config.toml"]) {
      const root = await repository();
      await Bun.write(join(root, path), "fixture\n");
      git(root, "add", ".");
      git(root, "commit", "-m", "quoted input");
      expect(reviewGate(root).trigger).toBe(true);
    }
  });

  test("TS-only small changes retain Tier 1; unresolved base cannot grant an exemption", async () => {
    const root = await repository();
    await Bun.write(join(root, "src/providers/new.ts"), "export const value = 1;\n");
    git(root, "add", ".");
    git(root, "commit", "-m", "small TS change");
    expect(reviewGate(root).trigger).toBe(false);
    expect(reviewGate(root, "missing-base").trigger).toBe(true);
  });
});

describe("Rust CI applicability", () => {
  test("a successful command from another compiler cannot verify the declared pin", () => {
    expect(() => requirePinnedCompiler("rustc 1.99.0 (fixture 2026-09-28)", "1.90.0")).toThrow("does not match pinned");
    expect(() => requirePinnedCompiler("rustc 1.90.0-nightly (fixture)", "1.90.0")).toThrow("does not match pinned");
    expect(() => requirePinnedCompiler("rustc 1.90.0 (fixture)\n", "1.90.0")).not.toThrow();
  });
  test("source, dependency and build inputs require a pinned root workspace at any depth", () => {
    expect(requireRustWorkspace(["src/index.ts", "docs/rust.md"])).toBe(false);
    for (const path of ["future/lib.rs", "other/Cargo.toml", ".cargo/config", "other/rust-toolchain"]) {
      expect(rustWorkspaceInputs([path])).toEqual([path]);
      expect(() => requireRustWorkspace([path])).toThrow("tracked root Cargo.toml");
    }
    expect(() => requireRustWorkspace(["Cargo.toml", "rust-toolchain.toml"])).toThrow("Cargo.lock");
    expect(requireRustWorkspace(["Cargo.toml", "Cargo.lock", "rust-toolchain.toml"])).toBe(true);
  });

  test("actual detection reports absent Rust honestly and rejects unpinned toolchains", async () => {
    const root = await repository();
    expect(await verifyRustWorkspace(root, true)).toBe(false);
    await Bun.write(join(root, "Cargo.toml"), "[workspace]\nmembers = []\n");
    await Bun.write(join(root, "Cargo.lock"), "# synthetic detection fixture\n");
    await Bun.write(join(root, "rust-toolchain.toml"), '[toolchain]\nchannel = "stable"\n');
    git(root, "add", ".");
    await expect(verifyRustWorkspace(root, true)).rejects.toThrow("exact stable version");
    await Bun.write(join(root, "rust-toolchain.toml"), '[toolchain]\nchannel = "1.90.0"\n');
    await expect(verifyRustWorkspace(root, true)).rejects.toThrow("rustfmt and clippy");
    await Bun.write(join(root, "rust-toolchain.toml"), '[toolchain]\nchannel = "1.90.0"\ncomponents = ["rustfmt", "clippy"]\n');
    expect(await verifyRustWorkspace(root, true)).toBe(true);
  });

  test.skipIf(process.platform === "win32")("all execution phases select the pin despite inherited overrides and independent Cargo numbering", async () => {
    const root = await repository();
    await Bun.write(join(root, "Cargo.toml"), '[package]\nname="fixture"\nversion="0.0.0"\n');
    await Bun.write(join(root, "Cargo.lock"), "# command-routing fixture\n");
    await Bun.write(join(root, "rust-toolchain.toml"), '[toolchain]\nchannel="1.56.1"\ncomponents=["rustfmt","clippy"]\n');
    git(root, "add", ".");
    const bin = join(root, "bin");
    const log = join(root, "calls.jsonl");
    const metadata = { packages: [{ id: "fixture", manifest_path: join(root, "Cargo.toml") }], workspace_members: ["fixture"] };
    // This process fixture protects selection at the command boundary; it does
    // not stand in for real compilation. Direct cargo is deliberately poisoned.
    await Bun.write(join(bin, "cargo"), `#!${process.execPath}\nprocess.exit(99);\n`);
    await Bun.write(join(bin, "rustup"), `#!${process.execPath}
import { appendFileSync } from "node:fs";
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(log)}, JSON.stringify(args) + "\\n");
if (args[0] !== "run" || args[1] !== "1.56.1") process.exit(98);
if (args[2] === "rustc") console.log("rustc 1.56.1 (fixture)");
else if (args[3] === "--version") console.log("cargo 1.56.0 (4ed5d137b 2021-10-04)");
else if (args[3] === "metadata") console.log(${JSON.stringify(JSON.stringify(metadata))});
`);
    await chmod(join(bin, "cargo"), 0o755);
    await chmod(join(bin, "rustup"), 0o755);
    const child = Bun.spawn([process.execPath, resolve("scripts/check/rust-workspace.ts")], {
      cwd: root, env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, RUSTUP_TOOLCHAIN: "stable" },
      stdout: "pipe", stderr: "pipe",
    });
    const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect({ exit, stderr }).toEqual({ exit: 0, stderr: "" });
    expect(stdout).toContain("verification passed");
    const calls: string[][] = (await Bun.file(log).text()).trim().split("\n").map((line) => JSON.parse(line));
    expect(calls.every((args) => args[0] === "run" && args[1] === "1.56.1")).toBe(true);
    expect(calls.filter((args) => args[2] === "cargo").map((args) => args.slice(3))).toEqual([
      ["metadata", "--no-deps", "--locked", "--format-version", "1"],
      ["fmt", "--all", "--", "--check"],
      ["clippy", "--workspace", "--all-targets", "--locked", "--", "-D", "warnings"],
      ["test", "--workspace", "--all-targets", "--locked"],
    ]);
  });
});
