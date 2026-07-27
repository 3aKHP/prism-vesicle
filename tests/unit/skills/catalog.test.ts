import { describe, expect, test } from "bun:test";
import { buildCatalog } from "../../../src/skills";
import type { LoadedSkill, SkillScope } from "../../../src/skills";

function fakeSkill(name: string, scope: SkillScope, description: string, bodySha256 = "a".repeat(64)): LoadedSkill {
  return {
    name,
    scope,
    rootDirectory: "/tmp",
    parsed: {
      ok: true,
      metadata: { name, description, unknownFields: [] },
      body: "",
      bodySha256: bodySha256,
      bytes: 0,
      lines: 0,
      resources: [],
      diagnostics: [],
    },
  };
}

describe("skill catalog", () => {
  test("keeps all entries under the budget and hashes their identity", () => {
    const skills = [
      fakeSkill("alpha", "harness", "alpha description"),
      fakeSkill("beta", "user", "beta description"),
    ];
    const catalog = buildCatalog(skills);
    expect(catalog.entries.map((e) => e.name)).toEqual(["alpha", "beta"]);
    expect(catalog.omitted).toEqual([]);
    // Deterministic over input order: re-pass reversed yields the same hash.
    const reversed = buildCatalog([...skills].reverse());
    expect(reversed.hash).toBe(catalog.hash);
  });

  test("omits lowest-precedence entries to respect a tight budget", () => {
    const skills = [
      fakeSkill("h1", "harness", "harness one description text"),
      fakeSkill("u1", "user", "user one description text"),
    ];
    // A budget so small that even shortened descriptions cannot fit both.
    const catalog = buildCatalog(skills, { budgetBytes: 60 });
    expect(catalog.entries.map((e) => e.name)).toEqual(["u1"]);
    expect(catalog.omitted.map((o) => o.name)).toContain("h1");
  });

  test("the catalog hash is over identity, not mutable description text", () => {
    // Same name/scope/contentSha256 (default body hash), different description.
    const a = buildCatalog([fakeSkill("s", "user", "original description")]);
    const shortened = buildCatalog([fakeSkill("s", "user", "short")]);
    expect(shortened.hash).toBe(a.hash);
  });

  test("changing the active content version changes the hash", () => {
    const v1 = fakeSkill("s", "user", "desc", "1".repeat(64));
    const v2 = fakeSkill("s", "user", "desc", "2".repeat(64));
    expect(buildCatalog([v1]).hash).not.toBe(buildCatalog([v2]).hash);
  });
});
