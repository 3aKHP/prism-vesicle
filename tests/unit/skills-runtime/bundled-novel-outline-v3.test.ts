import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { loadSkill } from "../../../src/skills";

const SKILL_ROOT = resolve(import.meta.dir, "../../../host-assets/skills/novel-outline-v3");

describe("bundled novel-outline-v3 skill", () => {
  test("loads through the production loader with valid metadata", async () => {
    const loaded = await loadSkill(SKILL_ROOT, "host");
    expect(loaded.parsed.ok).toBe(true);
    if (!loaded.parsed.ok) return;
    expect(loaded.parsed.metadata.name).toBe("novel-outline-v3");
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

  test("stays within parser bounds", async () => {
    const loaded = await loadSkill(SKILL_ROOT, "host");
    if (!loaded.parsed.ok) throw new Error("Skill failed to load");
    expect(loaded.parsed.lines).toBeLessThanOrEqual(500);
    expect(loaded.parsed.bytes).toBeLessThanOrEqual(64 * 1024);
    expect(loaded.parsed.resources.length).toBeLessThanOrEqual(200);
    for (const resource of loaded.parsed.resources) {
      expect(resource.bytes).toBeLessThanOrEqual(256 * 1024);
    }
  });

  test("contains exactly three reference resources", async () => {
    const loaded = await loadSkill(SKILL_ROOT, "host");
    if (!loaded.parsed.ok) throw new Error("Skill failed to load");
    const refs = loaded.parsed.resources.filter((r) => r.kind === "reference");
    expect(refs).toHaveLength(3);
    const paths = refs.map((r) => r.path).sort();
    expect(paths).toEqual([
      "references/ledgers.md",
      "references/templates.md",
      "references/tension_model.md",
    ]);
  });
});
