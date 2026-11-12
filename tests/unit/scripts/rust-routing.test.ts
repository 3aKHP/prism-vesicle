import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { requirePinnedToolVersion, requireRustWorkspace, rustWorkspaceInputs, verifyRustWorkspace } from "../../../scripts/check/rust-workspace.ts";

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
    expect(() => requirePinnedToolVersion("rustc", "rustc 1.99.0 (fixture 2026-09-28)", "1.90.0")).toThrow("does not match pinned");
    expect(() => requirePinnedToolVersion("cargo", "cargo 1.90.0-nightly (fixture)", "1.90.0")).toThrow("does not match pinned");
    expect(() => requirePinnedToolVersion("rustc", "rustc 1.90.0 (fixture)\n", "1.90.0")).not.toThrow();
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
});
