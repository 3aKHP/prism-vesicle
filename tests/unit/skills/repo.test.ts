import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { detectSkillRepo } from "../../../src/skills";

const symlinkSupported = await (async (): Promise<boolean> => {
  const dir = await mkdtemp(join(tmpdir(), "vesicle-skill-repo-symlink-probe-"));
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

async function writeSkill(directory: string, name: string): Promise<void> {
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "SKILL.md"), `---
name: ${name}
description: demo skill
---
body for ${name}
`, "utf8");
}

async function withTemp<T>(work: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "vesicle-skills-repo-"));
  try {
    return await work(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe("skill repository shape detection", () => {
  test("a root SKILL.md is a root-skill", async () => {
    await withTemp(async (dir) => {
      await writeSkill(dir, "root-one");
      const shape = await detectSkillRepo(dir);
      expect(shape).toEqual({ kind: "root-skill", skillRoot: "." });
    });
  });

  test("exactly one nested SKILL.md is single-nested", async () => {
    await withTemp(async (dir) => {
      await writeSkill(join(dir, "packages", "only"), "only");
      const shape = await detectSkillRepo(dir);
      expect(shape).toEqual({ kind: "single-nested", skillRoot: "packages/only" });
    });
  });

  test("a skills/<name> collection is a skills-collection", async () => {
    await withTemp(async (dir) => {
      await writeSkill(join(dir, "skills", "alpha"), "alpha");
      await writeSkill(join(dir, "skills", "beta"), "beta");
      const shape = await detectSkillRepo(dir);
      expect(shape.kind).toBe("skills-collection");
      if (shape.kind !== "skills-collection") return;
      expect(shape.skillRoots).toEqual(["skills/alpha", "skills/beta"]);
    });
  });

  test("multiple arbitrary nested skills are multi-arbitrary", async () => {
    await withTemp(async (dir) => {
      await writeSkill(join(dir, "a"), "a");
      await writeSkill(join(dir, "b"), "b");
      const shape = await detectSkillRepo(dir);
      expect(shape.kind).toBe("multi-arbitrary");
      if (shape.kind !== "multi-arbitrary") return;
      expect(shape.skillRoots).toEqual(["a", "b"]);
    });
  });

  test("no SKILL.md is none", async () => {
    await withTemp(async (dir) => {
      await mkdir(join(dir, "empty"), { recursive: true });
      await writeFile(join(dir, "README.md"), "# not a skill\n", "utf8");
      const shape = await detectSkillRepo(dir);
      expect(shape).toEqual({ kind: "none" });
    });
  });

  test("a root SKILL.md takes precedence over nested candidates", async () => {
    await withTemp(async (dir) => {
      await writeSkill(dir, "root-one");
      await writeSkill(join(dir, "skills", "nested"), "nested");
      const shape = await detectSkillRepo(dir);
      expect(shape).toEqual({ kind: "root-skill", skillRoot: "." });
    });
  });

  test(".git and node_modules are never descended into", async () => {
    await withTemp(async (dir) => {
      await writeSkill(join(dir, ".git", "trapped"), "trapped");
      await writeSkill(join(dir, "node_modules", "trapped"), "trapped2");
      const shape = await detectSkillRepo(dir);
      expect(shape).toEqual({ kind: "none" });
    });
  });

  test("a symbolic-link directory is not descended into", async () => {
    if (!symlinkSupported) return;
    await withTemp(async (dir) => {
      const real = join(dir, "real-skill");
      await writeSkill(real, "real");
      await symlink(real, join(dir, "linked"));
      const shape = await detectSkillRepo(dir);
      expect(shape.kind).toBe("single-nested");
      if (shape.kind !== "single-nested") return;
      expect(shape.skillRoot).toBe("real-skill");
    });
  });

  test("a symbolic-link SKILL.md entry is not a candidate", async () => {
    if (!symlinkSupported) return;
    await withTemp(async (dir) => {
      await mkdir(join(dir, "linked-entry"), { recursive: true });
      const target = join(dir, "real-skill.md");
      await writeFile(target, "---\nname: x\ndescription: y\n---\nbody\n", "utf8");
      await symlink(target, join(dir, "linked-entry", "SKILL.md"));
      const shape = await detectSkillRepo(dir);
      expect(shape).toEqual({ kind: "none" });
    });
  });

  test("a symbolic-link or missing source root is rejected", async () => {
    if (!symlinkSupported) return;
    await withTemp(async (dir) => {
      const real = join(dir, "real-dir");
      await mkdir(real, { recursive: true });
      await symlink(real, join(dir, "link"));
      await expect(detectSkillRepo(join(dir, "link"))).rejects.toThrow();
      await expect(detectSkillRepo(join(dir, "does-not-exist"))).rejects.toThrow();
    });
  });
});
