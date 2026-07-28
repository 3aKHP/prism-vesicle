import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { loadSkill } from "../../../src/skills";
import type { LoadedSkill } from "../../../src/skills";

const fixturesRoot = join(import.meta.dir, "..", "..", "fixtures", "pilot-skills");

async function loadPilot(name: string): Promise<LoadedSkill> {
  return loadSkill(join(fixturesRoot, name), "user");
}

describe("pilot skill fixtures", () => {
  test("review-rubric parses with expected metadata and no scripts", async () => {
    const skill = await loadPilot("review-rubric");
    expect(skill.parsed.ok).toBe(true);
    if (!skill.parsed.ok) return;
    expect(skill.name).toBe("review-rubric");
    expect(skill.parsed.metadata.name).toBe("review-rubric");
    expect(skill.parsed.metadata.description).toContain("review");
    expect(skill.parsed.resources.filter((r) => r.kind === "script")).toHaveLength(0);
    expect(skill.parsed.body).toContain("Narrative Coherence");
    expect(skill.parsed.body).toContain("Boundaries");
    expect(skill.parsed.lines).toBeLessThanOrEqual(500);
    expect(skill.parsed.bytes).toBeLessThanOrEqual(64 * 1024);
  });

  test("artifact-handoff parses with expected metadata and no scripts", async () => {
    const skill = await loadPilot("artifact-handoff");
    expect(skill.parsed.ok).toBe(true);
    if (!skill.parsed.ok) return;
    expect(skill.name).toBe("artifact-handoff");
    expect(skill.parsed.metadata.description).toContain("artifact");
    expect(skill.parsed.resources.filter((r) => r.kind === "script")).toHaveLength(0);
    expect(skill.parsed.body).toContain("Delivery Header Template");
  });

  test("research-synthesis parses with one bundled script", async () => {
    const skill = await loadPilot("research-synthesis");
    expect(skill.parsed.ok).toBe(true);
    if (!skill.parsed.ok) return;
    expect(skill.name).toBe("research-synthesis");
    expect(skill.parsed.metadata.description).toContain("synthesis");
    const scripts = skill.parsed.resources.filter((r) => r.kind === "script");
    expect(scripts).toHaveLength(1);
    expect(scripts[0]!.path).toBe("scripts/word-count.sh");
    expect(skill.parsed.body).toContain("word-count.sh");
  });

  test("no pilot skill declares allowed-tools", async () => {
    for (const name of ["review-rubric", "artifact-handoff", "research-synthesis"]) {
      const skill = await loadPilot(name);
      expect(skill.parsed.ok).toBe(true);
      if (!skill.parsed.ok) continue;
      const diagnostics = skill.parsed.diagnostics.filter((d) => d.message.includes("allowed-tools"));
      expect(diagnostics).toHaveLength(0);
    }
  });

  test("all pilot descriptions are under 1024 characters", async () => {
    for (const name of ["review-rubric", "artifact-handoff", "research-synthesis"]) {
      const skill = await loadPilot(name);
      if (!skill.parsed.ok) continue;
      expect(skill.parsed.metadata.description.length).toBeLessThanOrEqual(1024);
    }
  });
});
