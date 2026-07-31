import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { loadSkill } from "../../../src/skills";

const SKILL_ROOT = resolve(import.meta.dir, "../../../host-assets/skills/skillify");

describe("bundled skillify skill", () => {
  test("loads through the production loader with valid metadata", async () => {
    const loaded = await loadSkill(SKILL_ROOT, "host");
    expect(loaded.parsed.ok).toBe(true);
    if (!loaded.parsed.ok) return;
    expect(loaded.parsed.metadata.name).toBe("skillify");
    expect(loaded.parsed.metadata.description.length).toBeGreaterThan(0);
    expect(loaded.parsed.metadata.description.length).toBeLessThanOrEqual(1024);
    expect(loaded.parsed.diagnostics).toEqual([]);
  });

  test("contains exactly two script resources and no other supporting files", async () => {
    const loaded = await loadSkill(SKILL_ROOT, "host");
    if (!loaded.parsed.ok) throw new Error("Skill failed to load");
    const scripts = loaded.parsed.resources.filter((r) => r.kind === "script");
    expect(scripts).toHaveLength(2);
    const paths = scripts.map((r) => r.path).sort();
    expect(paths).toEqual(["scripts/publish_skill.ps1", "scripts/publish_skill.sh"]);
    // No references, assets, or other resources.
    expect(loaded.parsed.resources.filter((r) => r.kind !== "script")).toEqual([]);
  });

  test("stays within parser bounds", async () => {
    const loaded = await loadSkill(SKILL_ROOT, "host");
    if (!loaded.parsed.ok) throw new Error("Skill failed to load");
    expect(loaded.parsed.lines).toBeLessThanOrEqual(500);
    expect(loaded.parsed.bytes).toBeLessThanOrEqual(64 * 1024);
    expect(loaded.parsed.resources.length).toBeLessThanOrEqual(200);
  });
});
