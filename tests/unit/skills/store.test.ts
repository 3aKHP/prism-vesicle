import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  computeBundleHash,
  installSnapshot,
  readActiveIndex,
  readProvenance,
  skillStoreDirectory,
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
      const index = await readActiveIndex(env);
      expect(index.entries.filter((e) => e.name === "idem")).toHaveLength(1);
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
});
