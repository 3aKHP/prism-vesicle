import { describe, expect, test } from "bun:test";
import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { loadSkill } from "../../../src/skills";

const SKILL_ROOT = resolve(import.meta.dir, "../../../host-assets/skills/vesicle-docs");

describe("bundled vesicle-docs skill", () => {
  test("loads through the production loader with valid metadata", async () => {
    const loaded = await loadSkill(SKILL_ROOT, "host");
    expect(loaded.parsed.ok).toBe(true);
    if (!loaded.parsed.ok) return;
    expect(loaded.parsed.metadata.name).toBe("vesicle-docs");
    expect(loaded.parsed.metadata.description.length).toBeGreaterThan(0);
    expect(loaded.parsed.metadata.description.length).toBeLessThanOrEqual(1024);
    expect(loaded.parsed.diagnostics).toEqual([]);
  });

  test("contains no scripts", async () => {
    const loaded = await loadSkill(SKILL_ROOT, "host");
    if (!loaded.parsed.ok) throw new Error("Skill failed to load");
    const scripts = loaded.parsed.resources.filter((r) => r.kind === "script");
    expect(scripts).toEqual([]);
  });

  test("stays within resource count and size bounds", async () => {
    const loaded = await loadSkill(SKILL_ROOT, "host");
    if (!loaded.parsed.ok) throw new Error("Skill failed to load");
    expect(loaded.parsed.resources.length).toBeLessThanOrEqual(200);
    for (const resource of loaded.parsed.resources) {
      expect(resource.bytes).toBeLessThanOrEqual(256 * 1024);
    }
  });

  test("contains both user language categories and developer docs", async () => {
    const loaded = await loadSkill(SKILL_ROOT, "host");
    if (!loaded.parsed.ok) throw new Error("Skill failed to load");
    const paths = loaded.parsed.resources.map((r) => r.path);
    expect(paths.some((p) => p.includes("user-zh-cn"))).toBe(true);
    expect(paths.some((p) => p.includes("user-en"))).toBe(true);
    expect(paths.some((p) => p.includes("dev-"))).toBe(true);
    expect(paths.some((p) => p.includes("examples-"))).toBe(true);
    expect(paths).toContain("references/index.md");
  });

  test("contains no local checkout path or private reference", async () => {
    const files = await readdir(resolve(SKILL_ROOT, "references"));
    const projectRoot = resolve(import.meta.dir, "../../..");
    for (const file of files) {
      const content = await readFile(resolve(SKILL_ROOT, "references", file), "utf8");
      expect(content.includes(projectRoot)).toBe(false);
      expect(content.includes("/home/asus/")).toBe(false);
      expect(/sk-[a-zA-Z0-9]{20,}/.test(content)).toBe(false);
    }
  });

  test("generated index lists all source pages", async () => {
    const loaded = await loadSkill(SKILL_ROOT, "host");
    if (!loaded.parsed.ok) throw new Error("Skill failed to load");
    const indexResource = loaded.parsed.resources.find((r) => r.path === "references/index.md");
    expect(indexResource).toBeDefined();
    const indexContent = await readFile(resolve(SKILL_ROOT, "references", "index.md"), "utf8");
    expect(indexContent).toContain("Generated index");
    expect(indexContent).toContain("README.md");
    expect(indexContent).toContain("docs/dev/SKILLS.md");
  });
});
