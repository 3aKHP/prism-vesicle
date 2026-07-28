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

  test("shortens descriptions without omitting when the budget nearly fits", () => {
    // Two long descriptions whose full form exceeds a modest budget but whose
    // shortened form fits: both entries are kept, none omitted.
    const long = "x".repeat(300);
    const skills = [
      fakeSkill("h1", "harness", long),
      fakeSkill("u1", "user", long),
    ];
    const fullBytes = 2 * Buffer.byteLength(`h1\n${long}\nharness\n`, "utf8");
    const catalog = buildCatalog(skills, { budgetBytes: Math.floor(fullBytes / 2) });
    expect(catalog.entries.map((e) => e.name).sort()).toEqual(["h1", "u1"]);
    expect(catalog.omitted).toEqual([]);
    // Descriptions were actually shortened.
    expect(catalog.entries.every((e) => e.description.length < long.length)).toBe(true);
  });

  test("omits lowest-precedence entries exactly when the budget cannot fit both", () => {
    const skills = [
      fakeSkill("h1", "harness", "harness one description text"),
      fakeSkill("u1", "user", "user one description text"),
    ];
    // A budget so small that even min-shortened descriptions cannot fit both.
    const catalog = buildCatalog(skills, { budgetBytes: 60 });
    expect(catalog.entries.map((e) => e.name)).toEqual(["u1"]);
    // Precise: exactly h1 omitted (with its scope), u1 kept, nothing else.
    expect(catalog.omitted).toEqual([{ name: "h1", scope: "harness", reason: "omitted to respect the catalog budget" }]);
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

  test("budget omission drops host before harness, installed, user, and project", () => {
    const skills = [
      fakeSkill("a-host", "host", "host skill description text"),
      fakeSkill("b-harness", "harness", "harness skill description text"),
      fakeSkill("c-installed", "installed", "installed skill description text"),
      fakeSkill("d-user", "user", "user skill description text"),
      fakeSkill("e-project", "project", "project skill description text"),
    ];
    const catalog = buildCatalog(skills, { budgetBytes: 120 });
    const omittedNames = catalog.omitted.map((o) => o.name);
    expect(omittedNames).toContain("a-host");
    const keptNames = catalog.entries.map((e) => e.name);
    expect(keptNames).toContain("e-project");
    const omittedScopes = catalog.omitted.map((o) => o.scope);
    if (omittedScopes.includes("harness")) {
      expect(omittedScopes).toContain("host");
    }
  });
});
