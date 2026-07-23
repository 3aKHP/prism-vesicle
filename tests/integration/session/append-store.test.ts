import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, test } from "bun:test";
import { createSessionStore, listSessions, loadSessionSnapshot } from "../../../src/core/session/store";
import { writeSessionFixture } from "./fixtures/session";

describe("session: append store and listSessions", () => {
  test("serializes appends from multiple stores for the same session", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "vesicle-session-concurrent-"));
    const sessionId = "2026-01-01T00-00-00-000Z-concurrent";
    const first = await createSessionStore(rootDir, sessionId);
    const second = await createSessionStore(rootDir, sessionId);
    const system = await first.append({ role: "system", content: "prompt" });

    const [user, checkpoint] = await Promise.all([
      first.append({ role: "user", content: "parent turn" }),
      second.append({ role: "system", content: "", metadata: { kind: "file-history-snapshot" } }),
    ]);

    expect(user.parentUuid).toBe(system.uuid);
    expect(checkpoint.parentUuid).toBe(user.uuid);
    const snapshot = await loadSessionSnapshot(rootDir, sessionId);
    expect(snapshot.records.map((record) => record.uuid)).toEqual([system.uuid, user.uuid, checkpoint.uuid]);
  });

  test("append-only session records fork from an explicit parent and resume the newest branch", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "vesicle-session-branch-"));
    const sessionId = "2026-01-01T00-00-00-000Z-branching";
    const original = await createSessionStore(rootDir, sessionId);
    await original.append({ role: "system", content: "prompt" });
    await original.append({ role: "user", content: "first prompt" });
    const firstAnswer = await original.append({ role: "assistant", content: "first answer" });
    const oldPrompt = await original.append({ role: "user", content: "old second prompt" });
    const oldAnswer = await original.append({ role: "assistant", content: "old second answer" });

    const fork = await createSessionStore(rootDir, sessionId, { parentUuid: firstAnswer.uuid });
    const revisedPrompt = await fork.append({ role: "user", content: "revised second prompt" });
    await fork.append({ role: "assistant", content: "revised second answer" });

    expect(oldPrompt.parentUuid).toBe(firstAnswer.uuid);
    expect(revisedPrompt.parentUuid).toBe(firstAnswer.uuid);

    const active = await loadSessionSnapshot(rootDir, sessionId);
    expect(active.messages.map((message) => message.content)).toEqual([
      "first prompt",
      "first answer",
      "revised second prompt",
      "revised second answer",
    ]);

    const oldBranch = await loadSessionSnapshot(rootDir, sessionId, { headUuid: oldAnswer.uuid });
    expect(oldBranch.messages.map((message) => message.content)).toEqual([
      "first prompt",
      "first answer",
      "old second prompt",
      "old second answer",
    ]);
  });

  test("legacy linear JSONL records receive deterministic implicit parents", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "vesicle-session-legacy-"));
    const sessionId = "2026-01-01T00-00-00-000Z-legacy";
    const sessionDir = join(rootDir, ".vesicle", "sessions");
    await mkdir(sessionDir, { recursive: true });
    const records = [
      { ts: "2026-01-01T00:00:00.000Z", sessionId, role: "system", content: "prompt" },
      { ts: "2026-01-01T00:00:01.000Z", sessionId, role: "user", content: "legacy prompt" },
      { ts: "2026-01-01T00:00:02.000Z", sessionId, role: "assistant", content: "legacy answer" },
    ];
    await writeFile(join(sessionDir, `${sessionId}.jsonl`), records.map((record) => JSON.stringify(record)).join("\n") + "\n", "utf8");

    const snapshot = await loadSessionSnapshot(rootDir, sessionId);
    expect(snapshot.records.map((record) => record.uuid)).toEqual([
      `${sessionId}:legacy:0`,
      `${sessionId}:legacy:1`,
      `${sessionId}:legacy:2`,
    ]);
    expect(snapshot.records[1]?.parentUuid).toBe(`${sessionId}:legacy:0`);
    expect(snapshot.messages.map((message) => message.content)).toEqual(["legacy prompt", "legacy answer"]);
  });

  test("listSessions returns summaries newest-first with previews", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "vesicle-session-"));
    const sessionDir = join(rootDir, ".vesicle", "sessions");
    await mkdir(sessionDir, { recursive: true });
    await writeSessionFixture(sessionDir, "2026-01-01T00-00-00-000Z-aaaaaaaa", [
      { ts: "2026-01-01T00:00:00.000Z", role: "system", content: "prompt" },
      { ts: "2026-01-01T00:00:01.000Z", role: "user", content: "first session question" },
      { ts: "2026-01-01T00:00:02.000Z", role: "assistant", content: "answer" },
    ]);
    await writeSessionFixture(sessionDir, "2026-02-01T00-00-00-000Z-bbbbbbbb", [
      { ts: "2026-02-01T00:00:00.000Z", role: "system", content: "prompt" },
      { ts: "2026-02-01T00:00:01.000Z", role: "user", content: "second session, a different question" },
    ]);

    const summaries = await listSessions(rootDir);
    expect(summaries).toHaveLength(2);
    expect(summaries[0].sessionId).toContain("bbbbbbbb");
    expect(summaries[1].sessionId).toContain("aaaaaaaa");
    expect(summaries[0].preview).toContain("second session");
    expect(summaries[0].recordCount).toBe(2);
  });

  test("listSessions returns empty array when sessions dir does not exist", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "vesicle-empty-"));
    const summaries = await listSessions(rootDir);
    expect(summaries).toEqual([]);
  });

  test("listSessions hides SubAgent transcripts from the primary resume picker", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "vesicle-session-subagent-"));
    const primary = await createSessionStore(rootDir, "primary");
    await primary.append({ role: "system", content: "primary" });
    await primary.append({ role: "user", content: "main task" });
    const child = await createSessionStore(rootDir, "child");
    await child.append({ role: "system", content: "child", metadata: { kind: "subagent-session", parentSessionId: "primary" } });
    await child.append({ role: "user", content: "delegated task" });

    expect((await listSessions(rootDir)).map((session) => session.sessionId)).toEqual(["primary"]);
    expect((await listSessions(rootDir, { includeSubagents: true })).map((session) => session.sessionId).sort()).toEqual(["child", "primary"]);
  });

});
