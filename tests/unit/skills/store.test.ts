import { describe, expect, test } from "bun:test";
import { lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  computeBundleHash,
  installSnapshot,
  listSkillVersions,
  readActiveIndex,
  readProvenance,
  rollbackSkill,
  skillStoreDirectory,
  uninstallSkill,
} from "../../../src/skills";

const symlinkSupported = await (async (): Promise<boolean> => {
  const dir = await mkdtemp(join(tmpdir(), "vesicle-store-symlink-probe-"));
  try {
    const target = join(dir, "target");
    await writeFile(target, "x", "utf8");
    await symlink(target, join(dir, "link"));
    return true;
  } catch {
    return false;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
})();

async function withEnv<T>(work: (env: NodeJS.ProcessEnv, scratch: string) => Promise<T>): Promise<T> {
  const scratch = await mkdtemp(join(tmpdir(), "vesicle-skill-store-"));
  const env = { ...process.env, VESICLE_CONFIG_DIR: join(scratch, "config") };
  try {
    return await work(env, scratch);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

async function makeSource(parent: string, name: string, body: string): Promise<string> {
  const root = join(parent, name);
  await mkdir(root, { recursive: true });
  await mkdir(join(root, "references"), { recursive: true });
  await writeFile(join(root, "SKILL.md"), `---
name: ${name}
description: "demo: ${name}"
---
${body}
`, "utf8");
  await writeFile(join(root, "references", "glossary.md"), "gloss", "utf8");
  return root;
}

describe("skill store: immutable snapshots", () => {
  test("installing a snapshot never leaves a live dependency on its source path", async () => {
    await withEnv(async (env, scratch) => {
      const source = await makeSource(scratch, "independent", "original body");
      const provenance = await installSnapshot({ sourceDirectory: source, env });
      const storedBody = await readFile(join(skillStoreDirectory(env), "independent", provenance.version, "SKILL.md"), "utf8");
      expect(storedBody).toContain("original body");

      // Mutate the source after install. The stored snapshot must not change.
      await writeFile(join(source, "SKILL.md"), `---
name: independent
description: "demo: independent"
---
mutated body
`, "utf8");
      const storedBodyAfter = await readFile(join(skillStoreDirectory(env), "independent", provenance.version, "SKILL.md"), "utf8");
      expect(storedBodyAfter).toBe(storedBody);
    });
  });

  test("reinstalling identical content is idempotent by bundle hash", async () => {
    await withEnv(async (env, scratch) => {
      const source = await makeSource(scratch, "idem", "same");
      const first = await installSnapshot({ sourceDirectory: source, env });
      const second = await installSnapshot({ sourceDirectory: source, env });
      expect(second.version).toBe(first.version);
      expect(second.bundleSha256).toBe(first.bundleSha256);
      // A pure no-op: the active index keeps the original install time.
      expect(second.installedAt).toBe(first.installedAt);
      const index = await readActiveIndex(env);
      expect(index.entries.filter((e) => e.name === "idem")).toHaveLength(1);
      expect(index.entries[0]!.installedAt).toBe(first.installedAt);
    });
  });

  test("same version label with different content is a hard conflict", async () => {
    await withEnv(async (env, scratch) => {
      const sourceA = await makeSource(scratch, "conflict", "a");
      await installSnapshot({ sourceDirectory: sourceA, version: "v1", env });
      const sourceB = await makeSource(join(scratch, "b"), "conflict", "b");
      await expect(installSnapshot({ sourceDirectory: sourceB, version: "v1", env })).rejects.toThrow(/already exists with different content/);
    });
  });

  test("the active index and provenance sidecar round-trip", async () => {
    await withEnv(async (env, scratch) => {
      const source = await makeSource(scratch, "rt", "round trip");
      const provenance = await installSnapshot({ sourceDirectory: source, env });
      const index = await readActiveIndex(env);
      const entry = index.entries.find((e) => e.name === "rt");
      expect(entry?.version).toBe(provenance.version);
      expect(entry?.enabled).toBe(true);
      const sidecar = await readProvenance("rt", provenance.version, env);
      expect(sidecar?.bundleSha256).toBe(provenance.bundleSha256);
      expect(sidecar?.contentSha256).toBe(provenance.contentSha256);
      expect(sidecar?.fileInventory.map((f) => f.path)).toContain("SKILL.md");
      expect(sidecar?.fileInventory.map((f) => f.path)).toContain("references/glossary.md");
    });
  });

  test("bundle hash is deterministic over the same inventory", () => {
    const inventory = [
      { path: "references/b.md", sha256: "b", bytes: 1 },
      { path: "SKILL.md", sha256: "s", bytes: 2 },
      { path: "references/a.md", sha256: "a", bytes: 1 },
    ];
    expect(computeBundleHash(inventory)).toBe(computeBundleHash([...inventory].reverse()));
  });

  test("a symbolic link inside the source bundle is refused", async () => {
    if (!symlinkSupported) return;
    await withEnv(async (env, scratch) => {
      const source = await makeSource(scratch, "symlinked", "body");
      const target = join(scratch, "outside.txt");
      await writeFile(target, "secret", "utf8");
      await symlink(target, join(source, "references", "link.md"));
      await expect(installSnapshot({ sourceDirectory: source, env })).rejects.toThrow(/symbolic link/i);
    });
  });

  test("rejects name/version that are not single path segments", async () => {
    await withEnv(async (env, scratch) => {
      const source = await makeSource(scratch, "seg", "body");
      await expect(installSnapshot({ sourceDirectory: source, version: "../escape", env })).rejects.toThrow(/single path segment/);
      await expect(installSnapshot({ sourceDirectory: source, version: "a/b", env })).rejects.toThrow(/single path segment/);
      await expect(readProvenance("../x", "v1", env)).rejects.toThrow(/single path segment/);
      await expect(readProvenance("ok", "v/1", env)).rejects.toThrow(/single path segment/);
    });
  });

  test("concurrent installs of different skills both land in the index", async () => {
    await withEnv(async (env, scratch) => {
      const sourceA = await makeSource(scratch, "concurrent-a", "a");
      const sourceB = await makeSource(join(scratch, "other"), "concurrent-b", "b");
      await Promise.all([
        installSnapshot({ sourceDirectory: sourceA, env }),
        installSnapshot({ sourceDirectory: sourceB, env }),
      ]);
      const index = await readActiveIndex(env);
      const names = index.entries.map((entry) => entry.name).sort();
      expect(names).toEqual(["concurrent-a", "concurrent-b"]);
    });
  });

  test("a POSIX filename with a backslash is rejected before install", async () => {
    if (process.platform === "win32") return; // backslash is a separator on Windows
    await withEnv(async (env, scratch) => {
      const source = await makeSource(scratch, "bs", "body");
      // POSIX allows a literal backslash in a filename; Phase 2's path guard
      // would refuse it, so the store must not accept an unreadable inventory.
      await writeFile(join(source, "references", "bad\\name.md"), "x", "utf8");
      await expect(installSnapshot({ sourceDirectory: source, env })).rejects.toThrow(/cannot be stored/);
    });
  });
});

describe("skill store: lifecycle", () => {
  test("listSkillVersions returns installed versions oldest-first", async () => {
    await withEnv(async (env, scratch) => {
      const source = await makeSource(scratch, "versions", "a");
      await installSnapshot({ sourceDirectory: source, version: "v1", env });
      await writeFile(join(source, "SKILL.md"), `---
name: versions
description: "demo: versions"
---
b
`, "utf8");
      await installSnapshot({ sourceDirectory: source, version: "v2", env });
      expect(await listSkillVersions("versions", env)).toEqual(["v1", "v2"]);
    });
  });

  test("rollback restores the previous active version", async () => {
    await withEnv(async (env, scratch) => {
      const source = await makeSource(scratch, "rolling", "v1 body");
      await installSnapshot({ sourceDirectory: source, version: "v1", env });
      await writeFile(join(source, "SKILL.md"), `---
name: rolling
description: "demo: rolling"
---
v2 body
`, "utf8");
      await installSnapshot({ sourceDirectory: source, version: "v2", env });
      expect((await readActiveIndex(env)).entries.find((entry) => entry.name === "rolling")?.version).toBe("v2");
      const target = await rollbackSkill("rolling", env);
      expect(target).toBe("v1");
      expect((await readActiveIndex(env)).entries.find((entry) => entry.name === "rolling")?.version).toBe("v1");
    });
  });

  test("rollback fails when there is no previous version", async () => {
    await withEnv(async (env, scratch) => {
      const source = await makeSource(scratch, "solo", "body");
      await installSnapshot({ sourceDirectory: source, env });
      await expect(rollbackSkill("solo", env)).rejects.toThrow(/No previous version/);
    });
  });

  test("uninstall removes the index entry and the version family", async () => {
    await withEnv(async (env, scratch) => {
      const source = await makeSource(scratch, "removable", "body");
      await installSnapshot({ sourceDirectory: source, env });
      expect((await readActiveIndex(env)).entries.some((entry) => entry.name === "removable")).toBe(true);
      await uninstallSkill("removable", env);
      expect((await readActiveIndex(env)).entries.some((entry) => entry.name === "removable")).toBe(false);
      expect(await lstat(join(skillStoreDirectory(env), "removable")).catch(() => undefined)).toBeUndefined();
    });
  });

  test("the index lock is released after an install completes", async () => {
    await withEnv(async (env, scratch) => {
      const source = await makeSource(scratch, "locked", "body");
      await installSnapshot({ sourceDirectory: source, env });
      expect(await lstat(join(skillStoreDirectory(env), "index.lock")).catch(() => undefined)).toBeUndefined();
    });
  });

  test("a stale lock left by a dead process is reclaimed", async () => {
    await withEnv(async (env, scratch) => {
      const storeRoot = skillStoreDirectory(env);
      await mkdir(storeRoot, { recursive: true });
      await writeFile(join(storeRoot, "index.lock"), "999999999", "utf8");
      const source = await makeSource(scratch, "stale", "body");
      await installSnapshot({ sourceDirectory: source, env });
      expect((await readActiveIndex(env)).entries.some((entry) => entry.name === "stale")).toBe(true);
    });
  });

  test("an empty index.lock left by a crashed write is reclaimed", async () => {
    await withEnv(async (env, scratch) => {
      const storeRoot = skillStoreDirectory(env);
      await mkdir(storeRoot, { recursive: true });
      await writeFile(join(storeRoot, "index.lock"), "", "utf8");
      const source = await makeSource(scratch, "crashedlock", "body");
      await installSnapshot({ sourceDirectory: source, env });
      expect((await readActiveIndex(env)).entries.some((entry) => entry.name === "crashedlock")).toBe(true);
      expect(await lstat(join(storeRoot, "index.lock")).catch(() => undefined)).toBeUndefined();
    });
  });

  test("a malformed index.lock is reclaimed rather than bricking the store", async () => {
    await withEnv(async (env, scratch) => {
      const storeRoot = skillStoreDirectory(env);
      await mkdir(storeRoot, { recursive: true });
      await writeFile(join(storeRoot, "index.lock"), "not-a-pid", "utf8");
      const source = await makeSource(scratch, "malformed", "body");
      await installSnapshot({ sourceDirectory: source, env });
      expect((await readActiveIndex(env)).entries.some((entry) => entry.name === "malformed")).toBe(true);
    });
  });

  test("listSkillVersions skips interrupted staging dirs and orphan version dirs", async () => {
    await withEnv(async (env, scratch) => {
      const source = await makeSource(scratch, "listed", "body");
      await installSnapshot({ sourceDirectory: source, version: "v1", env });
      const familyRoot = join(skillStoreDirectory(env), "listed");
      await mkdir(join(familyRoot, ".staging-v2-deadbeef"), { recursive: true });
      await mkdir(join(familyRoot, "v3"), { recursive: true });
      expect(await listSkillVersions("listed", env)).toEqual(["v1"]);
    });
  });

  test("a failed install leaves the active version unchanged", async () => {
    await withEnv(async (env, scratch) => {
      const source = await makeSource(scratch, "safe", "v1 body");
      await installSnapshot({ sourceDirectory: source, version: "v1", env });
      const conflictSource = await makeSource(join(scratch, "other"), "safe", "different body");
      await expect(installSnapshot({ sourceDirectory: conflictSource, version: "v1", env })).rejects.toThrow(/already exists with different content/);
      const index = await readActiveIndex(env);
      expect(index.entries.find((entry) => entry.name === "safe")?.version).toBe("v1");
      expect(index.entries).toHaveLength(1);
    });
  });
});
