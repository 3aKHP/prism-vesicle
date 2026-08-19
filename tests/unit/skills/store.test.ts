import { describe, expect, test } from "bun:test";
import { chmod, lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  computeBundleHash,
  installSnapshot,
  installSnapshotCreateOnly,
  listSkillVersions,
  readActiveIndex,
  readProvenance,
  rollbackSkill,
  setSkillEnabled,
  skillStoreDirectory,
  uninstallSkill,
} from "../../../src/skills";
import { SkillStoreError } from "../../../src/skills/store";

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

  test("reinstalling identical content repairs a missing active index", async () => {
    await withEnv(async (env, scratch) => {
      const source = await makeSource(scratch, "repair-index", "same");
      const first = await installSnapshot({ sourceDirectory: source, env });
      await rm(join(skillStoreDirectory(env), "index.json"));

      await installSnapshot({ sourceDirectory: source, env });

      const entry = (await readActiveIndex(env)).entries.find((item) => item.name === "repair-index");
      expect(entry).toEqual({
        name: "repair-index",
        version: first.version,
        enabled: true,
        installedAt: first.installedAt,
      });
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

  test("reinstalling a retained version preserves active-index state", async () => {
    await withEnv(async (env, scratch) => {
      const source = await makeSource(scratch, "retained", "v1");
      await installSnapshot({ sourceDirectory: source, version: "v1", env });
      await writeFile(join(source, "references", "glossary.md"), "v2", "utf8");
      await installSnapshot({ sourceDirectory: source, version: "v2", env });
      await setSkillEnabled("retained", false, env);
      await rollbackSkill("retained", env);
      const rolledBack = (await readActiveIndex(env)).entries.find((item) => item.name === "retained")!;

      await installSnapshot({ sourceDirectory: source, version: "v2", env });

      const reactivated = (await readActiveIndex(env)).entries.find((item) => item.name === "retained");
      expect(reactivated).toEqual({ ...rolledBack, version: "v2" });
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

  test.skipIf(process.platform === "win32")("uninstall reports removal failure and keeps the index entry for retry", async () => {
    await withEnv(async (env, scratch) => {
      const source = await makeSource(scratch, "retryable", "body");
      await installSnapshot({ sourceDirectory: source, env });
      const familyRoot = join(skillStoreDirectory(env), "retryable");
      await chmod(familyRoot, 0o500);
      try {
        await expect(uninstallSkill("retryable", env)).rejects.toThrow();
        expect((await readActiveIndex(env)).entries.some((entry) => entry.name === "retryable")).toBe(true);
      } finally {
        await chmod(familyRoot, 0o700);
      }
      await uninstallSkill("retryable", env);
      expect((await readActiveIndex(env)).entries.some((entry) => entry.name === "retryable")).toBe(false);
    });
  });

  test("cross-process index updates wait for the owner and recover after it exits", async () => {
    await withEnv(async (env, scratch) => {
      const storeRoot = skillStoreDirectory(env);
      await mkdir(storeRoot, { recursive: true });
      const source = await makeSource(scratch, "after-crash", "body");
      const ready = join(scratch, "lock-ready");
      const databasePath = join(storeRoot, "index-lock.sqlite");
      const storeModule = join(import.meta.dir, "../../../src/skills/store.ts");
      const holderScript = [
        'import { Database } from "bun:sqlite";',
        'import { writeFile } from "node:fs/promises";',
        `const database = new Database(${JSON.stringify(databasePath)}, { create: true });`,
        'database.exec("BEGIN IMMEDIATE");',
        `await writeFile(${JSON.stringify(ready)}, "ready");`,
        "await Bun.sleep(60_000);",
      ].join("\n");
      const workerScript = [
        `import { installSnapshot } from ${JSON.stringify(storeModule)};`,
        `await installSnapshot({ sourceDirectory: ${JSON.stringify(source)}, env: { ...process.env, VESICLE_CONFIG_DIR: ${JSON.stringify(env.VESICLE_CONFIG_DIR)} } });`,
      ].join("\n");
      const holder = Bun.spawn({ cmd: [process.execPath, "-e", holderScript], stdout: "pipe", stderr: "pipe" });
      let holderExited = false;
      const holderExit = holder.exited.then((exitCode) => {
        holderExited = true;
        return exitCode;
      });
      try {
        for (let attempt = 0; attempt < 200; attempt++) {
          if (await lstat(ready).catch(() => undefined)) break;
          await Bun.sleep(10);
        }
        expect(await lstat(ready).catch(() => undefined)).toBeDefined();

        const worker = Bun.spawn({ cmd: [process.execPath, "-e", workerScript], stdout: "pipe", stderr: "pipe" });
        const workerStdout = new Response(worker.stdout).text();
        const workerStderr = new Response(worker.stderr).text();
        let workerExited = false;
        const workerExit = worker.exited.then((exitCode) => {
          workerExited = true;
          return exitCode;
        });
        await Bun.sleep(100);
        if (holderExited) {
          // The holder holds the SQLite write lock, so its death is the only way the
          // worker can finish early. A dead holder is environmental (e.g. a runner
          // OOM-kill), not a store defect, and must not be misread as a locking failure.
          throw new Error(
            `Lock holder died while it should have been sleeping: exit ${await holderExit}; `
              + `worker ${workerExited ? `already exited with ${await workerExit}` : "still running"}`,
          );
        }
        if (workerExited) {
          throw new Error(`Index worker exited before the holder: ${await workerExit}\n${await workerStdout}\n${await workerStderr}`);
        }
        // The index write happens inside the cross-process lock, so while the holder
        // lives the install cannot have landed: this proves the worker was genuinely
        // blocked on the lock, not merely slow to boot.
        expect((await readActiveIndex(env)).entries.some((entry) => entry.name === "after-crash")).toBe(false);
        holder.kill("SIGKILL");
        const [exitCode, stderr] = await Promise.all([workerExit, workerStderr]);
        expect(stderr).toBe("");
        expect(exitCode).toBe(0);
        expect((await readActiveIndex(env)).entries.some((entry) => entry.name === "after-crash")).toBe(true);
      } finally {
        holder.kill("SIGKILL");
        await holder.exited;
      }
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

  test("setSkillEnabled toggles the enabled flag and round-trips through the index", async () => {
    await withEnv(async (env, scratch) => {
      const source = await makeSource(scratch, "toggle-me", "body");
      await installSnapshot({ sourceDirectory: source, env });
      let index = await readActiveIndex(env);
      expect(index.entries.find((e) => e.name === "toggle-me")?.enabled).toBe(true);

      await setSkillEnabled("toggle-me", false, env);
      index = await readActiveIndex(env);
      expect(index.entries.find((e) => e.name === "toggle-me")?.enabled).toBe(false);

      await setSkillEnabled("toggle-me", true, env);
      index = await readActiveIndex(env);
      expect(index.entries.find((e) => e.name === "toggle-me")?.enabled).toBe(true);
    });
  });

  test("setSkillEnabled throws for a non-installed skill", async () => {
    await withEnv(async (env) => {
      await expect(setSkillEnabled("ghost", false, env)).rejects.toThrow(/No installed skill named "ghost"/);
    });
  });
});

describe("skill store: create-only publication", () => {
  test("installs a fresh name and publishes provenance + active index", async () => {
    await withEnv(async (env, scratch) => {
      const source = await makeSource(scratch, "fresh", "body");
      const provenance = await installSnapshotCreateOnly({ sourceDirectory: source, env });
      expect(provenance.name).toBe("fresh");
      expect(provenance.version).toMatch(/^sha-/);
      const index = await readActiveIndex(env);
      expect(index.entries.some((entry) => entry.name === "fresh")).toBe(true);
    });
  });

  test("rejects an already-installed name even with identical content", async () => {
    await withEnv(async (env, scratch) => {
      const source = await makeSource(scratch, "taken", "same body");
      await installSnapshot({ sourceDirectory: source, env });
      // installSnapshot is idempotent, but create-only must refuse the identical bytes.
      await expect(installSnapshotCreateOnly({ sourceDirectory: source, env })).rejects.toThrow(/already installed/);
      await expect(installSnapshotCreateOnly({ sourceDirectory: source, env })).rejects.toBeInstanceOf(SkillStoreError);
    });
  });

  test("repairs an exact publication that crashed after provenance but before the active index", async () => {
    await withEnv(async (env, scratch) => {
      const source = await makeSource(scratch, "retained", "body");
      const published = await installSnapshotCreateOnly({ sourceDirectory: source, env });
      // Drop the active index entry but keep the retained version + provenance.
      const storeRoot = skillStoreDirectory(env);
      const index = await readActiveIndex(env);
      await import("node:fs/promises").then(({ writeFile }) =>
        writeFile(join(storeRoot, "index.json"), JSON.stringify({ ...index, entries: [] }, null, 2)));
      const recovered = await installSnapshotCreateOnly({ sourceDirectory: source, env });
      expect(recovered).toEqual(published);
      expect((await readActiveIndex(env)).entries.find((entry) => entry.name === "retained")?.version).toBe(published.version);
    });
  });

  test("refuses provenance recovery when retained bytes conflict with the submitted draft", async () => {
    await withEnv(async (env, scratch) => {
      const source = await makeSource(scratch, "retained-conflict", "body");
      await installSnapshot({ sourceDirectory: source, env });
      const storeRoot = skillStoreDirectory(env);
      const index = await readActiveIndex(env);
      await writeFile(join(storeRoot, "index.json"), JSON.stringify({ ...index, entries: [] }, null, 2));
      await writeFile(join(source, "SKILL.md"), `---\nname: retained-conflict\ndescription: "demo: retained-conflict"\n---\nchanged\n`, "utf8");

      await expect(installSnapshotCreateOnly({ sourceDirectory: source, env })).rejects.toMatchObject({ code: "target-exists" });
      expect((await readActiveIndex(env)).entries).toHaveLength(0);
    });
  });

  test("refuses a linked Store family instead of following it during create-only publication", async () => {
    if (!symlinkSupported) return;
    await withEnv(async (env, scratch) => {
      const source = await makeSource(scratch, "linked-family", "body");
      const outside = join(scratch, "outside-family");
      await mkdir(outside);
      const storeRoot = skillStoreDirectory(env);
      await mkdir(storeRoot, { recursive: true });
      await symlink(outside, join(storeRoot, "linked-family"));

      await expect(installSnapshotCreateOnly({ sourceDirectory: source, env })).rejects.toMatchObject({ code: "target-exists" });
      expect(await import("node:fs/promises").then(({ readdir }) => readdir(outside))).toEqual([]);
    });
  });

  test("two concurrent create-only attempts for the same name produce one winner", async () => {
    await withEnv(async (env, scratch) => {
      const sourceA = await makeSource(scratch, "race", "a body");
      const sourceB = await makeSource(join(scratch, "other"), "race", "b body");
      const results = await Promise.allSettled([
        installSnapshotCreateOnly({ sourceDirectory: sourceA, env }),
        installSnapshotCreateOnly({ sourceDirectory: sourceB, env }),
      ]);
      const fulfilled = results.filter((result) => result.status === "fulfilled");
      const rejected = results.filter((result) => result.status === "rejected");
      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      expect(rejected[0]!.reason).toBeInstanceOf(SkillStoreError);
      // Exactly one active index entry, no staging residue.
      const index = await readActiveIndex(env);
      expect(index.entries.filter((entry) => entry.name === "race")).toHaveLength(1);
      const familyRoot = join(skillStoreDirectory(env), "race");
      const entries = await import("node:fs/promises").then(({ readdir }) => readdir(familyRoot));
      expect(entries.filter((name) => name.startsWith(".staging-"))).toHaveLength(0);
    });
  });

  test("orphan recovery completes an exact-hash version dir without provenance", async () => {
    await withEnv(async (env, scratch) => {
      const source = await makeSource(scratch, "orphan", "body");
      // Install to create the version dir, then remove provenance + index to
      // simulate a crash between final rename and provenance/index publication.
      await installSnapshot({ sourceDirectory: source, env });
      const index = await readActiveIndex(env);
      const storeRoot = skillStoreDirectory(env);
      const familyRoot = join(storeRoot, "orphan");
      const version = index.entries.find((entry) => entry.name === "orphan")!.version;
      await import("node:fs/promises").then(({ rm, writeFile }) =>
        Promise.all([
          rm(join(familyRoot, `${version}.provenance.json`)),
          writeFile(join(storeRoot, "index.json"), JSON.stringify({ ...index, entries: [] }, null, 2)),
        ]));
      const provenance = await installSnapshotCreateOnly({ sourceDirectory: source, env });
      expect(provenance.version).toBe(version);
      const finalIndex = await readActiveIndex(env);
      expect(finalIndex.entries.some((entry) => entry.name === "orphan")).toBe(true);
    });
  });
});
