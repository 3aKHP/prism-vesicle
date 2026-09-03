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
  peekSessionSkillCatalog,
  pruneSessionActivations,
  readFrozenSessionSkillCatalog,
  recordActivation,
  clearSessionActivations,
  isDuplicateActivation,
  resolveEngineEligibleCatalog,
  resolveSessionSkillCatalog,
  snapshotSkillCatalog,
} from "../../../src/core/skills";
import { createSessionStore, loadSessionSnapshot } from "../../../src/core/session/store";
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
const noHost = () => ({ hostAssetsDirectory: join(scratch, "no-host") });

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

    const first = await resolveSessionSkillCatalog(scratch, env(), { id: "etl" }, sessionId, undefined, undefined, noHost());
    expect(catalogNames(first)).toEqual(["alpha"]);

    await writeUserSkill("alpha", "# alpha\n\nCHANGED body.");
    await writeUserSkill("beta");

    const second = await resolveSessionSkillCatalog(scratch, env(), { id: "etl" }, sessionId, undefined, undefined, noHost());
    expect(second.catalog.hash).toBe(first.catalog.hash);
    expect(catalogNames(second)).toEqual(["alpha"]);
    const winner = second.byName.get("alpha");
    expect(winner?.parsed.ok && winner.parsed.body).toContain("Procedure body for alpha.");

    // A different session resolves fresh and sees the change.
    const other = await resolveSessionSkillCatalog(scratch, env(), { id: "etl" }, randomUUID(), undefined, undefined, noHost());
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
    const first = await resolveSessionSkillCatalog(scratch, env(), { id: "etl" }, sessionId, undefined, undefined, noHost());
    const snapshot = snapshotSkillCatalog(first);
    expect(isMeaningfulSkillCatalogSnapshot(snapshot)).toBe(true);

    // Simulate a process restart: the in-process freeze is gone, the snapshot is the authority.
    clearSessionSkillCatalog(sessionId);
    const resumed = await resolveSessionSkillCatalog(scratch, env(), { id: "etl" }, sessionId, snapshot, undefined, noHost());
    expect(resumed.catalog.hash).toBe(snapshot.catalogHash);
    expect(catalogNames(resumed)).toEqual(["alpha"]);
    expect(resumed.catalog.diagnostics).toEqual([]);
  });

  test("hash-mismatched entries are dropped with a diagnostic, never substituted", async () => {
    await writeUserSkill("alpha");
    await writeUserSkill("beta");
    const sessionId = randomUUID();
    const first = await resolveSessionSkillCatalog(scratch, env(), { id: "etl" }, sessionId, undefined, undefined, noHost());
    const snapshot = snapshotSkillCatalog(first);

    await writeUserSkill("alpha", "# alpha\n\nCHANGED body.");

    clearSessionSkillCatalog(sessionId);
    const resumed = await resolveSessionSkillCatalog(scratch, env(), { id: "etl" }, sessionId, snapshot, undefined, noHost());
    expect(catalogNames(resumed)).toEqual(["beta"]);
    expect(resumed.byName.has("alpha")).toBe(false);
    expect(
      resumed.catalog.diagnostics.some((diagnostic) => diagnostic.message.includes('"alpha"') && diagnostic.message.includes("changed or disappeared")),
    ).toBe(true);
  });

  test("snapshot metadata carries no absolute paths and round-trips the parser", async () => {
    await writeUserSkill("alpha");
    const resolved = await resolveSessionSkillCatalog(scratch, env(), { id: "etl" }, randomUUID(), undefined, undefined, noHost());
    const snapshot = snapshotSkillCatalog(resolved);
    const serialized = JSON.stringify(snapshot);
    expect(serialized).not.toContain(scratch);
    expect(parseSkillCatalogSnapshot(JSON.parse(serialized))).toEqual(snapshot);
    expect(parseSkillCatalogSnapshot({ catalogHash: 1 })).toBeUndefined();
    expect(parseSkillCatalogSnapshot("garbage")).toBeUndefined();
  });
});

describe("peekSessionSkillCatalog", () => {
  test("under resume drift, previews exactly the activation set and writes no freeze", async () => {
    await writeUserSkill("alpha");
    await writeUserSkill("beta");
    const sessionId = randomUUID();
    const frozen = await resolveSessionSkillCatalog(scratch, env(), { id: "etl" }, sessionId, undefined, undefined, noHost());
    const snapshot = snapshotSkillCatalog(frozen);

    // Persist the snapshot the way a real session does, then restart the process.
    const store = await createSessionStore(scratch, sessionId);
    await store.append({
      role: "system",
      content: "",
      metadata: { engine: "etl", providerId: "test", model: "test-model", skills: snapshot },
    });
    clearSessionSkillCatalog(sessionId);

    // Drift: alpha's body changes, gamma is installed after the freeze.
    await writeUserSkill("alpha", "# alpha\n\nCHANGED body.");
    await writeUserSkill("gamma");

    const peeked = await peekSessionSkillCatalog(scratch, env(), { id: "etl" }, sessionId, undefined, noHost());
    expect(catalogNames(peeked)).toEqual(["beta"]);
    // The preview is read-only: it must not establish the session's freeze.
    expect(readFrozenSessionSkillCatalog(sessionId)).toBeUndefined();

    // Activation resolves the same set from the same durable snapshot (#309:
    // the picker must not promise what `/skill <name>` cannot activate).
    const durable = await loadSessionSnapshot(scratch, sessionId, { synthesizeDanglingToolResults: false });
    const activation = await resolveSessionSkillCatalog(scratch, env(), { id: "etl" }, sessionId, durable?.skillCatalogSnapshot, undefined, noHost());
    expect(catalogNames(activation)).toEqual(catalogNames(peeked));
    clearSessionSkillCatalog(sessionId);
  });

  test("an existing freeze wins over live drift, matching what activation serves", async () => {
    await writeUserSkill("alpha");
    await writeUserSkill("beta");
    const sessionId = randomUUID();
    await resolveSessionSkillCatalog(scratch, env(), { id: "etl" }, sessionId, undefined, undefined, noHost());

    // Live drift after the freeze: activation still serves the frozen catalog,
    // so the peek must not drop frozen entries a snapshot re-resolution would.
    await writeUserSkill("alpha", "# alpha\n\nCHANGED body.");
    await writeUserSkill("gamma");

    const peeked = await peekSessionSkillCatalog(scratch, env(), { id: "etl" }, sessionId, undefined, noHost());
    expect(catalogNames(peeked)).toEqual(["alpha", "beta"]);
    clearSessionSkillCatalog(sessionId);
  });

  test("a missing session id and a record-less session resolve fresh", async () => {
    await writeUserSkill("alpha");
    const withoutSession = await peekSessionSkillCatalog(scratch, env(), { id: "etl" }, undefined, undefined, noHost());
    expect(catalogNames(withoutSession)).toEqual(["alpha"]);
    const recordless = await peekSessionSkillCatalog(scratch, env(), { id: "etl" }, randomUUID(), undefined, noHost());
    expect(catalogNames(recordless)).toEqual(["alpha"]);
  });
});

describe("engine eligibility", () => {
  test("Stage gets an empty eligible catalog; all other engines get the full catalog", async () => {
    await writeUserSkill("alpha");
    const frozen = await resolveSessionSkillCatalog(scratch, env(), { id: "etl" }, randomUUID(), undefined, undefined, noHost());
    expect(catalogNames(frozen)).toEqual(["alpha"]);

    expect(catalogNames(resolveEngineEligibleCatalog(frozen, { id: "stage" }))).toEqual([]);
    expect(catalogNames(resolveEngineEligibleCatalog(frozen, { id: "etl" }))).toEqual(["alpha"]);
    expect(catalogNames(resolveEngineEligibleCatalog(frozen, { id: "runtime" }))).toEqual(["alpha"]);
  });

  test("pruning removes ineligible activations so reactivation is not suppressed", async () => {
    const sessionId = randomUUID();
    recordActivation(sessionId, "alpha", "h1");
    recordActivation(sessionId, "beta", "h2");
    pruneSessionActivations(sessionId, new Map([["beta", "h2"]]));
    expect(isDuplicateActivation(sessionId, "alpha", "h1")).toBe(false);
    expect(isDuplicateActivation(sessionId, "beta", "h2")).toBe(true);
    clearSessionActivations(sessionId);
  });

  test("pruning drops a same-name activation recorded at a stale content hash", async () => {
    // The re-freeze case: the frozen catalog now serves "beta" at a new body
    // hash, so the pre-re-freeze activation no longer counts as live and dedup
    // must not suppress re-activating the new content.
    const sessionId = randomUUID();
    recordActivation(sessionId, "beta", "old-hash");
    pruneSessionActivations(sessionId, new Map([["beta", "new-hash"]]));
    expect(isDuplicateActivation(sessionId, "beta", "old-hash")).toBe(false);
    expect(isDuplicateActivation(sessionId, "beta", "new-hash")).toBe(false);
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
