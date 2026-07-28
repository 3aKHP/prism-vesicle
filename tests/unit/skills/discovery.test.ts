import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discoverSkills, loadSkill } from "../../../src/skills";

const symlinkSupported = await (async (): Promise<boolean> => {
  const dir = await mkdtemp(join(tmpdir(), "vesicle-skill-symlink-probe-"));
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

async function makeSkill(parent: string, name: string, description = "demo skill"): Promise<string> {
  const root = join(parent, name);
  await mkdir(root, { recursive: true });
  await writeFile(join(root, "SKILL.md"), `---
name: ${name}
description: ${description}
---
body for ${name}
`, "utf8");
  return root;
}

async function withTemp<T>(work: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "vesicle-skills-discovery-"));
  try {
    return await work(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe("skill discovery", () => {
  test("user scope outranks harness scope on a name collision", async () => {
    await withTemp(async (dir) => {
      const harnessRoot = await makeSkill(dir, "shared", "harness version");
      const userRoot = await makeSkill(join(dir, "user"), "shared", "user version");
      const result = await discoverSkills({ harnessRoots: [harnessRoot], userRoots: [userRoot] });
      expect(result.skills.map((s) => s.name)).toEqual(["shared"]);
      expect(result.skills[0]!.scope).toBe("user");
      expect(result.diagnostics.map((d) => d.kind)).toContain("shadowed");
    });
  });

  test("project scope outranks user scope on a name collision", async () => {
    await withTemp(async (dir) => {
      const userRoot = await makeSkill(join(dir, "user"), "shared", "user version");
      const projectRoot = await makeSkill(join(dir, "project"), "shared", "project version");
      const result = await discoverSkills({ userRoots: [userRoot], projectRoots: [projectRoot] });
      expect(result.skills.map((s) => s.name)).toEqual(["shared"]);
      expect(result.skills[0]!.scope).toBe("project");
      expect(result.diagnostics.filter((d) => d.kind === "shadowed")).toHaveLength(1);
    });
  });

  test("three-scope collision selects project > user > harness", async () => {
    await withTemp(async (dir) => {
      const harnessRoot = await makeSkill(join(dir, "h"), "triple", "harness version");
      const userRoot = await makeSkill(join(dir, "u"), "triple", "user version");
      const projectRoot = await makeSkill(join(dir, "p"), "triple", "project version");
      const result = await discoverSkills({ harnessRoots: [harnessRoot], userRoots: [userRoot], projectRoots: [projectRoot] });
      expect(result.skills).toHaveLength(1);
      expect(result.skills[0]!.scope).toBe("project");
      expect(result.diagnostics.filter((d) => d.kind === "shadowed")).toHaveLength(2);
    });
  });

  test("a malformed skill does not hide a valid sibling", async () => {
    await withTemp(async (dir) => {
      const good = await makeSkill(dir, "good-one");
      const badRoot = join(dir, "bad-one");
      await mkdir(badRoot, { recursive: true });
      await writeFile(join(badRoot, "SKILL.md"), `---
description: missing name field
---
body`, "utf8");
      const result = await discoverSkills({ userRoots: [good, badRoot] });
      expect(result.skills.map((s) => s.name)).toEqual(["good-one"]);
      expect(result.invalid.map((s) => s.name)).toEqual(["bad-one"]);
    });
  });

  test("fail-soft on an unreadable root still returns valid siblings", async () => {
    await withTemp(async (dir) => {
      const good = await makeSkill(dir, "fine");
      // A path with no SKILL.md loads as an invalid skill rather than throwing.
      const empty = join(dir, "empty");
      await mkdir(empty, { recursive: true });
      const result = await discoverSkills({ userRoots: [good, empty] });
      expect(result.skills.map((s) => s.name)).toEqual(["fine"]);
      expect(result.invalid).toHaveLength(1);
    });
  });

  test("a symbolic-link skill root is rejected", async () => {
    if (!symlinkSupported) return;
    await withTemp(async (dir) => {
      const real = await makeSkill(dir, "real");
      const link = join(dir, "link");
      await symlink(real, link);
      const loaded = await loadSkill(link, "user");
      expect(loaded.parsed.ok).toBe(false);
      if (loaded.parsed.ok) return;
      expect(loaded.parsed.diagnostics.map((d) => d.kind)).toContain("linked-root");
    });
  });

  test("a SKILL.md that is itself a symbolic link is rejected", async () => {
    if (!symlinkSupported) return;
    await withTemp(async (dir) => {
      const root = join(dir, "linked-entry");
      await mkdir(root, { recursive: true });
      const target = join(dir, "real-skill.md");
      await writeFile(target, "---\nname: linked-entry\ndescription: x\n---\nbody\n", "utf8");
      await symlink(target, join(root, "SKILL.md"));
      const loaded = await loadSkill(root, "user");
      expect(loaded.parsed.ok).toBe(false);
      if (loaded.parsed.ok) return;
      expect(loaded.parsed.diagnostics.map((d) => d.kind)).toContain("not-a-regular-file");
    });
  });

  test("host scope loses to harness on a name collision", async () => {
    await withTemp(async (dir) => {
      const hostRoot = await makeSkill(join(dir, "host"), "shared", "host version");
      const harnessRoot = await makeSkill(join(dir, "harness"), "shared", "harness version");
      const result = await discoverSkills({ harnessRoots: [harnessRoot], hostRoots: [hostRoot] });
      expect(result.skills).toHaveLength(1);
      expect(result.skills[0]!.scope).toBe("harness");
      expect(result.diagnostics.filter((d) => d.kind === "shadowed")).toHaveLength(1);
      expect(result.diagnostics[0]!.message).toContain('"host"');
    });
  });

  test("four-scope collision selects project and produces three shadow diagnostics", async () => {
    await withTemp(async (dir) => {
      const hostRoot = await makeSkill(join(dir, "ho"), "quad", "host version");
      const harnessRoot = await makeSkill(join(dir, "ha"), "quad", "harness version");
      const userRoot = await makeSkill(join(dir, "u"), "quad", "user version");
      const projectRoot = await makeSkill(join(dir, "p"), "quad", "project version");
      const result = await discoverSkills({
        harnessRoots: [harnessRoot],
        userRoots: [userRoot],
        projectRoots: [projectRoot],
        hostRoots: [hostRoot],
      });
      expect(result.skills).toHaveLength(1);
      expect(result.skills[0]!.scope).toBe("project");
      expect(result.diagnostics.filter((d) => d.kind === "shadowed")).toHaveLength(3);
    });
  });

  test("a malformed host sibling does not hide valid host skills", async () => {
    await withTemp(async (dir) => {
      const good = await makeSkill(join(dir, "host"), "good-host");
      const badRoot = join(dir, "host", "bad-host");
      await mkdir(badRoot, { recursive: true });
      await writeFile(join(badRoot, "SKILL.md"), "not valid frontmatter", "utf8");
      const result = await discoverSkills({ hostRoots: [good, badRoot] });
      expect(result.skills.map((s) => s.name)).toEqual(["good-host"]);
      expect(result.invalid).toHaveLength(1);
    });
  });
});
