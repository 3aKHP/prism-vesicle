import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import {
  activateSkillForSession,
  catalogNames,
  clearSessionActivations,
  clearSessionSkillCatalog,
  computeSkillCatalogDrift,
  refreshSessionSkillCatalog,
  resolveSessionSkillCatalog,
  resolveSkillCatalog,
  SKILL_ACTIVATION_KIND,
  SKILL_CATALOG_RECORD_KIND,
  snapshotSkillCatalog,
} from "../../../src/core/skills";
import type { SkillCatalogSnapshot } from "../../../src/core/skills";
import { createSessionStore, loadSessionRecords, loadSessionSnapshot } from "../../../src/core/session/store";
import type { SessionRecord } from "../../../src/core/session/record-model";
import { makeScratch } from "./helpers";

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
async function writeUserSkill(name: string, body?: string): Promise<void> {
  const root = join(scratch, "config", "skills", name);
  await mkdir(root, { recursive: true });
  await Bun.write(
    join(root, "SKILL.md"),
    `---\nname: ${name}\ndescription: ${name} description\n---\n\n${body ?? `# ${name}\n\nProcedure body for ${name}.`}\n`,
  );
}

async function freezeCurrent(): Promise<SkillCatalogSnapshot> {
  const resolved = await resolveSkillCatalog(scratch, env(), { id: "etl" }, undefined, noHost());
  return snapshotSkillCatalog(resolved);
}

/** A durable host-activation record the derivation reads back as live. */
function activationRecord(sessionId: string, name: string, contentHash: string): SessionRecord {
  return {
    uuid: randomUUID(),
    parentUuid: null,
    ts: new Date().toISOString(),
    sessionId,
    role: "user",
    content: `Activate ${name}.`,
    metadata: { kind: SKILL_ACTIVATION_KIND, name, contentHash },
  };
}

/** A minimal session whose header carries (or omits) a frozen catalog snapshot. */
async function createScratchSession(sessionId: string, skills?: SkillCatalogSnapshot): Promise<void> {
  const store = await createSessionStore(scratch, sessionId);
  await store.append({
    role: "system",
    content: "",
    metadata: { engine: "etl", providerId: "test", model: "test-model", ...(skills ? { skills } : {}) },
  });
}

describe("computeSkillCatalogDrift", () => {
  test("classifies changed (with and without a stale activation), removed, and added entries", async () => {
    await writeUserSkill("alpha");
    await writeUserSkill("beta");
    await writeUserSkill("gamma");
    const persisted = await freezeCurrent();
    const alphaV1 = persisted.entries.find((entry) => entry.name === "alpha")!.bodySha256;

    await writeUserSkill("alpha", "# alpha\n\nCHANGED body.");
    await rm(join(scratch, "config", "skills", "beta"), { recursive: true, force: true });
    await writeUserSkill("delta");

    const withActivation = await computeSkillCatalogDrift({
      rootDir: scratch,
      env: env(),
      profile: { id: "etl" },
      persistedSnapshot: persisted,
      records: [activationRecord("sess", "alpha", alphaV1)],
      filesystemOptions: noHost(),
    });
    expect(withActivation.persisted).toBe(true);
    expect(withActivation.events).toEqual([
      { kind: "changed", name: "alpha", mustReactivate: true },
      { kind: "removed", name: "beta" },
    ]);
    expect(withActivation.added).toEqual(["delta"]);
    expect(withActivation.reactivate).toEqual(["alpha"]);

    const withoutActivation = await computeSkillCatalogDrift({
      rootDir: scratch,
      env: env(),
      profile: { id: "etl" },
      persistedSnapshot: persisted,
      records: [],
      filesystemOptions: noHost(),
    });
    expect(withoutActivation.events).toEqual([
      { kind: "changed", name: "alpha", mustReactivate: false },
      { kind: "removed", name: "beta" },
    ]);
    expect(withoutActivation.reactivate).toEqual([]);
  });
});

describe("refreshSessionSkillCatalog", () => {
  test("an in-sync catalog is an idempotent no-op: no record is appended", async () => {
    await writeUserSkill("alpha");
    const persisted = await freezeCurrent();
    const sessionId = "sess-refresh-noop";
    await createScratchSession(sessionId, persisted);

    const result = await refreshSessionSkillCatalog({
      rootDir: scratch,
      env: env(),
      sessionId,
      profile: { id: "etl" },
      filesystemOptions: noHost(),
    });
    expect(result.appended).toBe(false);
    expect(result.drift.events).toEqual([]);
    expect(result.drift.added).toEqual([]);
    expect(await loadSessionRecords(scratch, sessionId)).toHaveLength(1);
  });

  test("a drifted Skill is re-frozen at current content and can be activated again", async () => {
    await writeUserSkill("alpha");
    const v1 = await freezeCurrent();
    const v1Hash = v1.entries[0]!.bodySha256;
    const sessionId = "sess-refresh-drift";
    await createScratchSession(sessionId, v1);
    const store = await createSessionStore(scratch, sessionId);
    await store.append(activationRecord(sessionId, "alpha", v1Hash));

    await writeUserSkill("alpha", "# alpha\n\nCHANGED body.");
    const result = await refreshSessionSkillCatalog({
      rootDir: scratch,
      env: env(),
      sessionId,
      profile: { id: "etl" },
      filesystemOptions: noHost(),
    });
    expect(result.appended).toBe(true);
    expect(result.drift.reactivate).toEqual(["alpha"]);

    const records = await loadSessionRecords(scratch, sessionId);
    const last = records.at(-1)!;
    expect(last.role).toBe("system");
    expect(last.metadata?.kind).toBe(SKILL_CATALOG_RECORD_KIND);
    const appended = last.metadata?.skills as SkillCatalogSnapshot;
    expect(appended.entries.map((entry) => entry.name)).toEqual(["alpha"]);
    expect(appended.entries[0]!.bodySha256).not.toBe(v1Hash);
    // Append-only: the header keeps the original freeze.
    const header = records[0]!.metadata?.skills as SkillCatalogSnapshot | undefined;
    expect(header).toBeDefined();
    expect(header!.entries[0]!.bodySha256).toBe(v1Hash);

    // Session-level latest-wins projection reads the re-frozen snapshot ...
    const snapshot = await loadSessionSnapshot(scratch, sessionId, { synthesizeDanglingToolResults: false });
    const v2Hash = snapshot.skillCatalogSnapshot!.entries[0]!.bodySha256;
    expect(v2Hash).toBe(appended.entries[0]!.bodySha256);
    // ... and the in-process freeze was dropped, so alpha resolves at v2 instead of being dropped.
    const resolved = await resolveSessionSkillCatalog(
      scratch, env(), { id: "etl" }, sessionId, snapshot.skillCatalogSnapshot, undefined, noHost(),
    );
    expect(catalogNames(resolved)).toEqual(["alpha"]);

    // The v1 activation retired through the existing prune; re-activation at v2 is not dedup-suppressed.
    const first = await activateSkillForSession(scratch, env(), sessionId, "alpha", { profile: { id: "etl" }, mode: "context-only" });
    expect(first.alreadyActive).toBe(false);
    expect(first.contentHash).toBe(v2Hash);
    const second = await activateSkillForSession(scratch, env(), sessionId, "alpha", { profile: { id: "etl" }, mode: "context-only" });
    expect(second.alreadyActive).toBe(true);
    clearSessionSkillCatalog(sessionId);
    clearSessionActivations(sessionId);
  });

  test("a legacy session without a frozen catalog gets a durable freeze", async () => {
    await writeUserSkill("alpha");
    const sessionId = "sess-refresh-legacy";
    await createScratchSession(sessionId);

    const result = await refreshSessionSkillCatalog({
      rootDir: scratch,
      env: env(),
      sessionId,
      profile: { id: "etl" },
      filesystemOptions: noHost(),
    });
    expect(result.appended).toBe(true);
    expect(result.drift.persisted).toBe(false);
    const records = await loadSessionRecords(scratch, sessionId);
    expect(records.at(-1)!.metadata?.kind).toBe(SKILL_CATALOG_RECORD_KIND);
  });

  test("an empty installation with no snapshot changes nothing", async () => {
    const sessionId = "sess-refresh-empty";
    await createScratchSession(sessionId);

    const result = await refreshSessionSkillCatalog({
      rootDir: scratch,
      env: env(),
      sessionId,
      profile: { id: "etl" },
      filesystemOptions: noHost(),
    });
    expect(result.appended).toBe(false);
    expect(await loadSessionRecords(scratch, sessionId)).toHaveLength(1);
  });
});
