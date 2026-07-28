import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSkill } from "../../../src/skills";

async function withEnv<T>(work: (env: NodeJS.ProcessEnv, scratch: string) => Promise<T>): Promise<T> {
  const scratch = await mkdtemp(join(tmpdir(), "vesicle-skill-create-"));
  const env = { ...process.env, VESICLE_CONFIG_DIR: join(scratch, "config") };
  try {
    return await work(env, scratch);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

describe("skill create", () => {
  test("creates a valid skill directory with SKILL.md and resource dirs", async () => {
    await withEnv(async (env, scratch) => {
      const projectRoot = join(scratch, "project");
      await mkdir(projectRoot, { recursive: true });
      const result = await createSkill("my-skill", projectRoot, { scope: "user", env });
      expect(result.name).toBe("my-skill");
      expect(result.scope).toBe("user");

      const skillMd = await readFile(join(result.root, "SKILL.md"), "utf8");
      expect(skillMd).toContain("name: my-skill");
      expect(skillMd).toContain("description:");

      for (const dir of ["scripts", "references", "assets"]) {
        const info = await stat(join(result.root, dir));
        expect(info.isDirectory()).toBe(true);
      }
    });
  });

  test("project scope creates under .agents/skills/", async () => {
    await withEnv(async (env, scratch) => {
      const projectRoot = join(scratch, "project");
      await mkdir(projectRoot, { recursive: true });
      const result = await createSkill("proj-skill", projectRoot, { scope: "project", env });
      expect(result.root).toBe(join(projectRoot, ".agents", "skills", "proj-skill"));
    });
  });

  test("rejects an invalid skill name", async () => {
    await withEnv(async (env, scratch) => {
      const projectRoot = join(scratch, "project");
      await mkdir(projectRoot, { recursive: true });
      await expect(createSkill("Invalid_Name", projectRoot, { scope: "user", env })).rejects.toThrow(/lowercase alphanumeric/);
    });
  });

  test("refuses to overwrite without --force", async () => {
    await withEnv(async (env, scratch) => {
      const projectRoot = join(scratch, "project");
      await mkdir(projectRoot, { recursive: true });
      await createSkill("existing", projectRoot, { scope: "project", env });
      await expect(createSkill("existing", projectRoot, { scope: "project", env })).rejects.toThrow(/already exists/);
    });
  });

  test("--force backs up and replaces", async () => {
    await withEnv(async (env, scratch) => {
      const projectRoot = join(scratch, "project");
      await mkdir(projectRoot, { recursive: true });
      const first = await createSkill("replace-me", projectRoot, { scope: "project", env });
      const second = await createSkill("replace-me", projectRoot, { scope: "project", force: true, env });
      expect(second.backupPath).toBeDefined();
      expect(second.root).toBe(first.root);
      const backupInfo = await stat(second.backupPath!);
      expect(backupInfo.isDirectory()).toBe(true);
    });
  });
});
