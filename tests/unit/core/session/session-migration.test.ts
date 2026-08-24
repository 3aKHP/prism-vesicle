import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HarnessRuntimeIdentity } from "../../../../src/core/harness/driver";
import type { SessionRecord } from "../../../../src/core/session/record-model";
import { createSessionStore } from "../../../../src/core/session/append-store";
import { listSessions, loadSessionSnapshot } from "../../../../src/core/session/store";
import { projectSessionHistory } from "../../../../src/core/session/history-projector";
import {
  appendSessionMigrationRecord,
  archiveSessionBeforeMigration,
  findLastSessionMigration,
  parseSessionMigrationRecord,
  SESSION_MIGRATION_KIND,
  type SessionMigrationRecord,
} from "../../../../src/core/session/session-migration";

function identity(version: string): HarnessRuntimeIdentity {
  return {
    packId: "prism-engine-v10",
    packVersion: version,
    sourceCommit: "0e4bbb5".repeat(4),
    manifestSha256: "a".repeat(64),
    adapterId: "vesicle-v1",
    adapterVersion: "1.1.0",
    adapterHash: "b".repeat(64),
  };
}

function migration(toVersion: string, from: HarnessRuntimeIdentity | null = identity("10.3.0-alpha.1")): SessionMigrationRecord {
  return {
    migratedAt: "2026-08-24T00:00:00.000Z",
    from,
    to: identity(toVersion),
    archivePath: ".vesicle/sessions/archive/sess-1.jsonl",
    preflight: { verdict: "warning", warningCount: 1, layers: ["resume", "serializer"] },
  };
}

function record(uuid: string, parentUuid: string | null, role: SessionRecord["role"], content: string, metadata?: Record<string, unknown>): SessionRecord {
  return { uuid, parentUuid, ts: "2026-08-24T00:00:00.000Z", sessionId: "sess-1", role, content, ...(metadata ? { metadata } : {}) };
}

describe("session migration record parsing", () => {
  test("round-trips through JSON", () => {
    const source = migration("10.3.0-alpha.2");
    expect(parseSessionMigrationRecord(JSON.parse(JSON.stringify(source)))).toEqual(source);
  });

  test("accepts a null from for legacy identity-less sessions", () => {
    const source = migration("10.3.0-alpha.2", null);
    expect(parseSessionMigrationRecord(JSON.parse(JSON.stringify(source)))).toEqual(source);
  });

  test("rejects malformed payloads", () => {
    expect(() => parseSessionMigrationRecord("nope")).toThrow();
    expect(() => parseSessionMigrationRecord({ ...migration("v"), from: undefined })).toThrow();
    const badVerdict = migration("v");
    badVerdict.preflight.verdict = "blocking" as SessionMigrationRecord["preflight"]["verdict"];
    expect(() => parseSessionMigrationRecord(badVerdict)).toThrow();
    const badLayer = migration("v");
    badLayer.preflight.layers = ["network" as never];
    expect(() => parseSessionMigrationRecord(badLayer)).toThrow();
    const badCount = migration("v");
    badCount.preflight.warningCount = -1;
    expect(() => parseSessionMigrationRecord(badCount)).toThrow();
  });
});

describe("session migration projection", () => {
  function migrationSystemRecord(m: SessionMigrationRecord): SessionRecord {
    return record("m1", "u1", "system", "", { kind: SESSION_MIGRATION_KIND, harness: m.to, migration: m });
  }

  test("a migration record rebinds the effective harness identity", () => {
    const m = migration("10.3.0-alpha.2");
    const projection = projectSessionHistory([
      record("s", null, "system", "", { harness: identity("10.3.0-alpha.1") }),
      record("u1", "s", "user", "hello"),
      migrationSystemRecord(m),
      record("u2", "m1", "user", "continue"),
    ]);
    expect(projection.harness).toEqual(identity("10.3.0-alpha.2"));
    expect(projection.messages.map((message) => message.content)).toEqual(["hello", "continue"]);
  });

  test("the last migration wins", () => {
    const first = migration("10.3.0-alpha.2");
    const second = migration("10.3.0-beta.1");
    const records = [
      record("s", null, "system", "", { harness: identity("10.3.0-alpha.1") }),
      record("m1", "s", "system", "", { kind: SESSION_MIGRATION_KIND, harness: first.to, migration: first }),
      record("m2", "m1", "system", "", { kind: SESSION_MIGRATION_KIND, harness: second.to, migration: second }),
    ];
    expect(projectSessionHistory(records).harness).toEqual(identity("10.3.0-beta.1"));
    expect(findLastSessionMigration(records)).toEqual(second);
  });

  test("a malformed migration payload fails closed", () => {
    expect(() => projectSessionHistory([
      record("s", null, "system", "", { harness: identity("10.3.0-alpha.1") }),
      record("m1", "s", "system", "", { kind: SESSION_MIGRATION_KIND, migration: { migratedAt: "x" } }),
    ])).toThrow();
  });
});

describe("session migration archive", () => {
  test("archives original bytes plus one tag record and leaves the live file untouched", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "vesicle-session-migration-"));
    const store = await createSessionStore(rootDir, "sess-1");
    await store.append({ role: "system", content: "", metadata: { harness: identity("10.3.0-alpha.1") } });
    await store.append({ role: "user", content: "hello" });
    const liveBefore = await readFile(join(rootDir, ".vesicle", "sessions", "sess-1.jsonl"), "utf8");

    const tag = { archivedAt: "2026-08-24T00:00:00.000Z", from: identity("10.3.0-alpha.1"), to: identity("10.3.0-alpha.2"), reason: "harness-migration" as const };
    const archivePath = await archiveSessionBeforeMigration(rootDir, "sess-1", tag);
    expect(archivePath).toBe(".vesicle/sessions/archive/sess-1.jsonl");

    const archived = await readFile(join(rootDir, ".vesicle", "sessions", "archive", "sess-1.jsonl"), "utf8");
    const lines = archived.split("\n").filter((line) => line.length > 0);
    expect(archived.startsWith(liveBefore)).toBe(true);
    expect(lines).toHaveLength(liveBefore.split("\n").filter((line) => line.length > 0).length + 1);
    const tagRecord = JSON.parse(lines.at(-1)!) as SessionRecord;
    expect(tagRecord.metadata?.kind).toBe("session-archive");
    expect(tagRecord.metadata?.archive).toEqual(tag);
    expect(await readFile(join(rootDir, ".vesicle", "sessions", "sess-1.jsonl"), "utf8")).toBe(liveBefore);
  });

  test("re-archiving the same session suffixes instead of overwriting", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "vesicle-session-migration-"));
    const store = await createSessionStore(rootDir, "sess-1");
    await store.append({ role: "user", content: "first" });
    const first = await archiveSessionBeforeMigration(rootDir, "sess-1", { archivedAt: "2026-08-24T00:00:00.000Z", from: identity("10.3.0-alpha.1"), to: identity("10.3.0-alpha.2"), reason: "harness-migration" });
    await store.append({ role: "user", content: "second" });
    const second = await archiveSessionBeforeMigration(rootDir, "sess-1", { archivedAt: "2026-08-24T01:00:00.000Z", from: identity("10.3.0-alpha.2"), to: identity("10.3.0-beta.1"), reason: "harness-migration" });
    expect(first).toBe(".vesicle/sessions/archive/sess-1.jsonl");
    expect(second).toBe(".vesicle/sessions/archive/sess-1.migrated-2.jsonl");
    expect((await readdir(join(rootDir, ".vesicle", "sessions", "archive"))).sort()).toEqual(["sess-1.jsonl", "sess-1.migrated-2.jsonl"]);
  });

  test("archived copies never appear in the session list and the migration record rebinds the snapshot identity", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "vesicle-session-migration-"));
    const store = await createSessionStore(rootDir, "sess-1");
    await store.append({ role: "system", content: "", metadata: { harness: identity("10.3.0-alpha.1") } });
    await appendSessionMigrationRecord(store, migration("10.3.0-alpha.2"));
    await archiveSessionBeforeMigration(rootDir, "sess-1", { archivedAt: "2026-08-24T00:00:00.000Z", from: identity("10.3.0-alpha.1"), to: identity("10.3.0-alpha.2"), reason: "harness-migration" });
    const sessions = await listSessions(rootDir);
    expect(sessions.map((summary) => summary.sessionId)).toEqual(["sess-1"]);
    const snapshot = await loadSessionSnapshot(rootDir, "sess-1", { synthesizeDanglingToolResults: false });
    expect(snapshot.harness).toEqual(identity("10.3.0-alpha.2"));
    expect(findLastSessionMigration(snapshot.records)).toEqual(migration("10.3.0-alpha.2"));
  });
});
