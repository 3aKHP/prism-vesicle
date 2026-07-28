import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
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
const noHost = () => ({ hostAssetsDirectory: join(scratch, "no-host") });

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

    const first = await activateSkillForSession(scratch, env(), sessionId, "alpha", { profile: { id: "etl" }, filesystemOptions: noHost() });
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

    const second = await activateSkillForSession(scratch, env(), sessionId, "alpha", { profile: { id: "etl" }, filesystemOptions: noHost() });
    expect(second.alreadyActive).toBe(true);
    expect((await loadSessionRecords(scratch, sessionId)).length).toBe(records.length);
    clearSessionActivations(sessionId);
    clearSessionSkillCatalog(sessionId);
  });

  test("an unknown name errors with the valid names", async () => {
    await writeUserSkill("alpha");
    const sessionId = randomUUID();
    await createSession(sessionId);
    await expect(activateSkillForSession(scratch, env(), sessionId, "missing", { profile: { id: "etl" }, filesystemOptions: noHost() }))
      .rejects.toThrow('Unknown skill "missing". Available skills: alpha.');
    clearSessionSkillCatalog(sessionId);
  });

  test("the activation record is not rewind-selectable but reaches provider history as a user message", async () => {
    await writeUserSkill("alpha");
    const sessionId = randomUUID();
    await createSession(sessionId);
    await activateSkillForSession(scratch, env(), sessionId, "alpha", { profile: { id: "etl" }, filesystemOptions: noHost() });

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
    const first = await activateSkillForSession(scratch, env(), sessionId, "alpha", { profile: { id: "etl" }, filesystemOptions: noHost() });

    // Simulate a restart: drop every in-memory registry, keep only the JSONL.
    clearSessionActivations(sessionId);
    clearSessionSkillCatalog(sessionId);
    expect(isDuplicateActivation(sessionId, "alpha", first.contentHash)).toBe(false);

    const records = await loadSessionRecords(scratch, sessionId);
    hydrateSessionActivations(sessionId, deriveSessionActivations(records));
    expect(isDuplicateActivation(sessionId, "alpha", first.contentHash)).toBe(true);

    const second = await activateSkillForSession(scratch, env(), sessionId, "alpha", { profile: { id: "etl" }, filesystemOptions: noHost() });
    expect(second.alreadyActive).toBe(true);
    clearSessionActivations(sessionId);
    clearSessionSkillCatalog(sessionId);
  });

  test("a persisted catalog snapshot never substitutes a changed Skill on resume", async () => {
    await writeUserSkill("alpha");
    // Freeze the catalog snapshot into the session header, as bootstrap does.
    const catalog = await resolveSkillCatalog(scratch, env(), { id: "etl" }, undefined, noHost());
    const snapshot = snapshotSkillCatalog(catalog);
    const sessionId = randomUUID();
    await createSession(sessionId, { skills: snapshot });

    // The Skill changes on disk after the session froze it.
    await writeUserSkill("alpha", "# alpha\n\nCHANGED body.");

    // After a restart the catalog re-resolves by name+hash: alpha is dropped,
    // so host activation fails instead of injecting different content.
    await expect(activateSkillForSession(scratch, env(), sessionId, "alpha", { profile: { id: "etl" }, filesystemOptions: noHost() }))
      .rejects.toThrow('Unknown skill "alpha". Available skills: (none).');
    clearSessionSkillCatalog(sessionId);
  });

  test("returns the appended record uuid and chains an explicit branch parent", async () => {
    await writeUserSkill("alpha");
    const sessionId = randomUUID();
    await createSession(sessionId);
    const headerUuid = (await loadSessionRecords(scratch, sessionId))[0]!.uuid;

    const activation = await activateSkillForSession(scratch, env(), sessionId, "alpha", {
      profile: { id: "etl" },
      filesystemOptions: noHost(),
      parentUuid: headerUuid,
    });
    expect(activation.alreadyActive).toBe(false);
    expect(activation.recordUuid).toBeDefined();

    const stored = (await loadSessionRecords(scratch, sessionId)).find((record) => record.uuid === activation.recordUuid);
    expect(stored?.metadata?.kind).toBe("skill-activation");
    expect(stored?.parentUuid).toBe(headerUuid);

    // A duplicate activation appends nothing and reports no record uuid.
    const duplicate = await activateSkillForSession(scratch, env(), sessionId, "alpha", { profile: { id: "etl" }, filesystemOptions: noHost() });
    expect(duplicate.alreadyActive).toBe(true);
    expect(duplicate.recordUuid).toBeUndefined();
    clearSessionActivations(sessionId);
    clearSessionSkillCatalog(sessionId);
  });

  test("concurrent identical activations are serialized so hash dedup holds", async () => {
    await writeUserSkill("alpha");
    const sessionId = randomUUID();
    await createSession(sessionId);

    const [first, second] = await Promise.all([
      activateSkillForSession(scratch, env(), sessionId, "alpha", { profile: { id: "etl" }, filesystemOptions: noHost() }),
      activateSkillForSession(scratch, env(), sessionId, "alpha", { profile: { id: "etl" }, filesystemOptions: noHost() }),
    ]);
    expect([first.alreadyActive, second.alreadyActive].sort()).toEqual([false, true]);

    const records = await loadSessionRecords(scratch, sessionId);
    expect(records.filter((record) => record.metadata?.kind === "skill-activation").length).toBe(1);
    clearSessionActivations(sessionId);
    clearSessionSkillCatalog(sessionId);
  });

  test("cross-process concurrent activations are atomic so hash dedup holds", async () => {
    await writeUserSkill("alpha");
    const sessionId = randomUUID();
    await createSession(sessionId);

    const skillsImport = join(import.meta.dir, "..", "..", "..", "src", "core", "skills", "index.ts");
    const workerPath = join(scratch, "worker.ts");
    await Bun.write(
      workerPath,
      [
        `import { activateSkillForSession } from ${JSON.stringify(skillsImport)};`,
        `import { writeFile } from "node:fs/promises";`,
        `import { existsSync } from "node:fs";`,
        `const [rootDir, sid, skillName, readyFile, goFile, noHostDir] = process.argv.slice(2);`,
        `await writeFile(readyFile, "ready", "utf8");`,
        `while (!existsSync(goFile)) await Bun.sleep(2);`,
        `const result = await activateSkillForSession(rootDir, process.env, sid, skillName, { profile: { id: "etl" }, filesystemOptions: { hostAssetsDirectory: noHostDir } });`,
        `console.log(JSON.stringify({ alreadyActive: result.alreadyActive }));`,
      ].join("\n"),
    );

    const noHostDir = join(scratch, "no-host");
    const goFile = join(scratch, "go");
    const env = { ...process.env, VESICLE_CONFIG_DIR: join(scratch, "config") };
    const spawnWorker = (index: number) =>
      Bun.spawn([process.execPath, workerPath, scratch, sessionId, "alpha", join(scratch, `ready-${index}`), goFile, noHostDir], { env, stdout: "pipe", stderr: "pipe" });
    const children = [spawnWorker(0), spawnWorker(1)];

    // Release both workers at once so they contend inside the critical section.
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline && !(existsSync(join(scratch, "ready-0")) && existsSync(join(scratch, "ready-1")))) {
      await Bun.sleep(5);
    }
    await writeFile(goFile, "go", "utf8");

    const outputs = await Promise.all(
      children.map(async (child) => {
        const text = await new Response(child.stdout).text();
        await child.exited;
        return text;
      }),
    );
    const statuses = outputs
      .map((text) => (JSON.parse(text.trim().split("\n").at(-1)!) as { alreadyActive: boolean }).alreadyActive)
      .sort();
    expect(statuses).toEqual([false, true]);

    const records = await loadSessionRecords(scratch, sessionId);
    expect(records.filter((record) => record.metadata?.kind === "skill-activation").length).toBe(1);
    clearSessionActivations(sessionId);
    clearSessionSkillCatalog(sessionId);
  }, 30000);

  test.skipIf(process.getuid?.() === 0)("the registry is marked only after a durable append, so a failed append does not poison dedup", async () => {
    await writeUserSkill("alpha");
    const sessionId = randomUUID();
    await createSession(sessionId);
    const sessionsDir = join(scratch, ".vesicle", "sessions");

    await chmod(sessionsDir, 0o555);
    try {
      await expect(activateSkillForSession(scratch, env(), sessionId, "alpha", { profile: { id: "etl" }, filesystemOptions: noHost() }))
        .rejects.toThrow();
      // The failed append must not have registered the activation.
      const skill = (await resolveSkillCatalog(scratch, env(), { id: "etl" }, undefined, noHost())).byName.get("alpha");
      const hash = skill?.parsed.ok ? skill.parsed.bodySha256 : "";
      expect(hash).not.toBe("");
      expect(isDuplicateActivation(sessionId, "alpha", hash)).toBe(false);
    } finally {
      await chmod(sessionsDir, 0o755);
    }

    const retry = await activateSkillForSession(scratch, env(), sessionId, "alpha", { profile: { id: "etl" }, filesystemOptions: noHost() });
    expect(retry.alreadyActive).toBe(false);
    const after = await activateSkillForSession(scratch, env(), sessionId, "alpha", { profile: { id: "etl" }, filesystemOptions: noHost() });
    expect(after.alreadyActive).toBe(true);
    clearSessionActivations(sessionId);
    clearSessionSkillCatalog(sessionId);
  });
});
