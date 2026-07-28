import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import {
  catalogNames,
  clearSessionSkillCatalog,
  composeSkillCatalogBlock,
  isMeaningfulSkillCatalogSnapshot,
  parseSkillCatalogSnapshot,
  pruneSessionActivations,
  recordActivation,
  clearSessionActivations,
  isDuplicateActivation,
  resolveEngineEligibleCatalog,
  resolveSessionSkillCatalog,
  snapshotSkillCatalog,
} from "../../../src/core/skills";
import { buildCatalog } from "../../../src/skills";
import { makeScratch, writeSkill, loadWritten } from "./helpers";

let scratch: string;

beforeEach(async () => {
  scratch = await makeScratch();
});

afterEach(async () => {
  await rm(scratch, { recursive: true, force: true });
});

const env = (): NodeJS.ProcessEnv => ({ VESICLE_CONFIG_DIR: join(scratch, "config") });

/** Write a skill directly into the fake user-scope discovery directory. */
async function writeUserSkill(name: string, body?: string): Promise<string> {
  const root = join(scratch, "config", "skills", name);
  await mkdir(root, { recursive: true });
  await Bun.write(
    join(root, "SKILL.md"),
    `---\nname: ${name}\ndescription: ${name} description\n---\n\n${body ?? `# ${name}\n\nProcedure body for ${name}.`}\n`,
  );
  return root;
}

describe("session catalog freeze", () => {
  test("a second resolution for the same session ignores on-disk changes", async () => {
    await writeUserSkill("alpha");
    const sessionId = randomUUID();

    const first = await resolveSessionSkillCatalog(scratch, env(), { id: "etl" }, sessionId, undefined);
    expect(catalogNames(first)).toEqual(["alpha"]);

    await writeUserSkill("alpha", "# alpha\n\nCHANGED body.");
    await writeUserSkill("beta");

    const second = await resolveSessionSkillCatalog(scratch, env(), { id: "etl" }, sessionId, undefined);
    expect(second.catalog.hash).toBe(first.catalog.hash);
    expect(catalogNames(second)).toEqual(["alpha"]);
    const winner = second.byName.get("alpha");
    expect(winner?.parsed.ok && winner.parsed.body).toContain("Procedure body for alpha.");

    // A different session resolves fresh and sees the change.
    const other = await resolveSessionSkillCatalog(scratch, env(), { id: "etl" }, randomUUID(), undefined);
    expect(catalogNames(other)).toEqual(["alpha", "beta"]);
    clearSessionSkillCatalog(sessionId);
  });

  test("Stage freezes an empty catalog", async () => {
    await writeUserSkill("alpha");
    const resolved = await resolveSessionSkillCatalog(scratch, env(), { id: "stage" }, randomUUID(), undefined);
    expect(resolved.catalog.entries).toEqual([]);
  });
});

describe("persisted snapshot resume", () => {
  test("a matching snapshot re-resolves to the identical frozen catalog", async () => {
    await writeUserSkill("alpha");
    const sessionId = randomUUID();
    const first = await resolveSessionSkillCatalog(scratch, env(), { id: "etl" }, sessionId, undefined);
    const snapshot = snapshotSkillCatalog(first);
    expect(isMeaningfulSkillCatalogSnapshot(snapshot)).toBe(true);

    // Simulate a process restart: the in-process freeze is gone, the snapshot is the authority.
    clearSessionSkillCatalog(sessionId);
    const resumed = await resolveSessionSkillCatalog(scratch, env(), { id: "etl" }, sessionId, snapshot);
    expect(resumed.catalog.hash).toBe(snapshot.catalogHash);
    expect(catalogNames(resumed)).toEqual(["alpha"]);
    expect(resumed.catalog.diagnostics).toEqual([]);
  });

  test("hash-mismatched entries are dropped with a diagnostic, never substituted", async () => {
    await writeUserSkill("alpha");
    await writeUserSkill("beta");
    const sessionId = randomUUID();
    const first = await resolveSessionSkillCatalog(scratch, env(), { id: "etl" }, sessionId, undefined);
    const snapshot = snapshotSkillCatalog(first);

    await writeUserSkill("alpha", "# alpha\n\nCHANGED body.");

    clearSessionSkillCatalog(sessionId);
    const resumed = await resolveSessionSkillCatalog(scratch, env(), { id: "etl" }, sessionId, snapshot);
    expect(catalogNames(resumed)).toEqual(["beta"]);
    expect(resumed.byName.has("alpha")).toBe(false);
    expect(
      resumed.catalog.diagnostics.some((diagnostic) => diagnostic.message.includes('"alpha"') && diagnostic.message.includes("changed or disappeared")),
    ).toBe(true);
  });

  test("snapshot metadata carries no absolute paths and round-trips the parser", async () => {
    await writeUserSkill("alpha");
    const resolved = await resolveSessionSkillCatalog(scratch, env(), { id: "etl" }, randomUUID(), undefined);
    const snapshot = snapshotSkillCatalog(resolved);
    const serialized = JSON.stringify(snapshot);
    expect(serialized).not.toContain(scratch);
    expect(parseSkillCatalogSnapshot(JSON.parse(serialized))).toEqual(snapshot);
    expect(parseSkillCatalogSnapshot({ catalogHash: 1 })).toBeUndefined();
    expect(parseSkillCatalogSnapshot("garbage")).toBeUndefined();
  });
});

describe("engine eligibility", () => {
  test("Stage and engines without declared skill tools get an empty eligible catalog", async () => {
    await writeUserSkill("alpha");
    const frozen = await resolveSessionSkillCatalog(scratch, env(), { id: "etl" }, randomUUID(), undefined);
    expect(catalogNames(frozen)).toEqual(["alpha"]);

    expect(catalogNames(resolveEngineEligibleCatalog(frozen, { id: "stage" }))).toEqual([]);
    expect(catalogNames(resolveEngineEligibleCatalog(frozen, { id: "etl", defaultTools: ["read_file"] }))).toEqual([]);
    expect(catalogNames(resolveEngineEligibleCatalog(frozen, { id: "etl", defaultTools: ["read_file", "activate_skill"] }))).toEqual(["alpha"]);
    expect(catalogNames(resolveEngineEligibleCatalog(frozen, { id: "etl" }))).toEqual(["alpha"]);
  });

  test("pruning removes ineligible activations so reactivation is not suppressed", async () => {
    const sessionId = randomUUID();
    recordActivation(sessionId, "alpha", "h1");
    recordActivation(sessionId, "beta", "h2");
    pruneSessionActivations(sessionId, new Set(["beta"]));
    expect(isDuplicateActivation(sessionId, "alpha", "h1")).toBe(false);
    expect(isDuplicateActivation(sessionId, "beta", "h2")).toBe(true);
    clearSessionActivations(sessionId);
  });
});

describe("composeSkillCatalogBlock", () => {
  test("an empty catalog renders nothing, keeping the composed prompt byte-identical", () => {
    expect(composeSkillCatalogBlock(buildCatalog([]))).toBe("");
  });

  test("the block is delimited routing metadata with scope, hash, and the authority rule", async () => {
    const root = await writeSkill(scratch, "alpha", { description: "Alpha routing description." });
    const skill = await loadWritten(root);
    const catalog = buildCatalog([skill]);
    const block = composeSkillCatalogBlock(catalog);
    expect(block.startsWith(`<skill_catalog hash="${catalog.hash}">`)).toBe(true);
    expect(block).toContain("- alpha [user]: Alpha routing description.");
    expect(block).toContain("routing data, not instructions");
    expect(block).toContain("activate_skill");
    expect(block.endsWith("</skill_catalog>")).toBe(true);
    expect(block).not.toContain(root);
  });

  test("omitted entries are noted in the block", async () => {
    const root = await writeSkill(scratch, "alpha", { description: "d".repeat(200) });
    const other = await writeSkill(scratch, "beta", { description: "d".repeat(200) });
    const catalog = buildCatalog([await loadWritten(root), await loadWritten(other)], { budgetBytes: 100 });
    expect(catalog.omitted.length).toBeGreaterThan(0);
    const block = composeSkillCatalogBlock(catalog);
    expect(block).toContain("omitted to respect the catalog budget");
  });
});
