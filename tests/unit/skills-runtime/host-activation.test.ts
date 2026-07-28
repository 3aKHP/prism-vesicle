import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import {
  activateSkillForSession,
  clearSessionActivations,
  clearSessionSkillCatalog,
  deriveSessionActivations,
  hydrateSessionActivations,
  isDuplicateActivation,
  resolveSkillCatalog,
  snapshotSkillCatalog,
} from "../../../src/core/skills";
import { createSessionStore, loadSessionRecords, projectSessionHistory } from "../../../src/core/session/store";
import { isSelectableUserRecord } from "../../../src/core/rewind/service";
import { makeScratch } from "./helpers";

let scratch: string;

beforeEach(async () => {
  scratch = await makeScratch();
});

afterEach(async () => {
  await rm(scratch, { recursive: true, force: true });
});

const env = (): NodeJS.ProcessEnv => ({ VESICLE_CONFIG_DIR: join(scratch, "config") });

async function writeUserSkill(name: string, body?: string): Promise<void> {
  const root = join(scratch, "config", "skills", name);
  await mkdir(root, { recursive: true });
  await Bun.write(
    join(root, "SKILL.md"),
    `---\nname: ${name}\ndescription: ${name} description\n---\n\n${body ?? `# ${name}\n\nProcedure body for ${name}.`}\n`,
  );
}

/** Create a session file with a header record so snapshot loading works. */
async function createSession(sessionId: string, metadata: Record<string, unknown> = {}): Promise<void> {
  const store = await createSessionStore(scratch, sessionId);
  await store.append({ role: "system", content: "test header", metadata: { engine: "etl", ...metadata } });
}

describe("activateSkillForSession", () => {
  test("appends the marked activation record and dedups by content hash", async () => {
    await writeUserSkill("alpha");
    const sessionId = randomUUID();
    await createSession(sessionId);

    const first = await activateSkillForSession(scratch, env(), sessionId, "alpha", { profile: { id: "etl" } });
    expect(first.alreadyActive).toBe(false);
    expect(first.name).toBe("alpha");
    expect(first.scope).toBe("user");

    const records = await loadSessionRecords(scratch, sessionId);
    const activation = records.find((record) => record.metadata?.kind === "skill-activation");
    expect(activation?.role).toBe("user");
    expect(activation?.metadata?.name).toBe("alpha");
    expect(activation?.metadata?.contentHash).toBe(first.contentHash);
    expect(activation?.metadata?.mode).toBe("invoke");
    expect(activation?.content).toContain(`[skill_activation name="alpha" scope="user" hash="${first.contentHash}" status="activated"]`);
    expect(activation?.content).toContain("Procedure body for alpha.");
    expect(activation?.content).toContain("[/skill_activation]");
    expect(activation?.content).not.toContain(scratch);

    const second = await activateSkillForSession(scratch, env(), sessionId, "alpha", { profile: { id: "etl" } });
    expect(second.alreadyActive).toBe(true);
    expect((await loadSessionRecords(scratch, sessionId)).length).toBe(records.length);
    clearSessionActivations(sessionId);
    clearSessionSkillCatalog(sessionId);
  });

  test("an unknown name errors with the valid names", async () => {
    await writeUserSkill("alpha");
    const sessionId = randomUUID();
    await createSession(sessionId);
    await expect(activateSkillForSession(scratch, env(), sessionId, "missing", { profile: { id: "etl" } }))
      .rejects.toThrow('Unknown skill "missing". Available skills: alpha.');
    clearSessionSkillCatalog(sessionId);
  });

  test("the activation record is not rewind-selectable but reaches provider history as a user message", async () => {
    await writeUserSkill("alpha");
    const sessionId = randomUUID();
    await createSession(sessionId);
    await activateSkillForSession(scratch, env(), sessionId, "alpha", { profile: { id: "etl" } });

    const records = await loadSessionRecords(scratch, sessionId);
    const activation = records.find((record) => record.metadata?.kind === "skill-activation")!;
    expect(isSelectableUserRecord(activation)).toBe(false);

    const projected = projectSessionHistory(records);
    const message = projected.messages.find((entry) => entry.role === "user" && entry.kind === "skill-activation");
    expect(message?.content).toBe(activation.content);
    clearSessionActivations(sessionId);
    clearSessionSkillCatalog(sessionId);
  });

  test("resume: activation dedup survives a process restart from durable records alone", async () => {
    await writeUserSkill("alpha");
    const sessionId = randomUUID();
    await createSession(sessionId);
    const first = await activateSkillForSession(scratch, env(), sessionId, "alpha", { profile: { id: "etl" } });

    // Simulate a restart: drop every in-memory registry, keep only the JSONL.
    clearSessionActivations(sessionId);
    clearSessionSkillCatalog(sessionId);
    expect(isDuplicateActivation(sessionId, "alpha", first.contentHash)).toBe(false);

    const records = await loadSessionRecords(scratch, sessionId);
    hydrateSessionActivations(sessionId, deriveSessionActivations(records));
    expect(isDuplicateActivation(sessionId, "alpha", first.contentHash)).toBe(true);

    const second = await activateSkillForSession(scratch, env(), sessionId, "alpha", { profile: { id: "etl" } });
    expect(second.alreadyActive).toBe(true);
    clearSessionActivations(sessionId);
    clearSessionSkillCatalog(sessionId);
  });

  test("a persisted catalog snapshot never substitutes a changed Skill on resume", async () => {
    await writeUserSkill("alpha");
    // Freeze the catalog snapshot into the session header, as bootstrap does.
    const catalog = await resolveSkillCatalog(scratch, env(), { id: "etl" });
    const snapshot = snapshotSkillCatalog(catalog);
    const sessionId = randomUUID();
    await createSession(sessionId, { skills: snapshot });

    // The Skill changes on disk after the session froze it.
    await writeUserSkill("alpha", "# alpha\n\nCHANGED body.");

    // After a restart the catalog re-resolves by name+hash: alpha is dropped,
    // so host activation fails instead of injecting different content.
    await expect(activateSkillForSession(scratch, env(), sessionId, "alpha", { profile: { id: "etl" } }))
      .rejects.toThrow('Unknown skill "alpha". Available skills: (none).');
    clearSessionSkillCatalog(sessionId);
  });
});
