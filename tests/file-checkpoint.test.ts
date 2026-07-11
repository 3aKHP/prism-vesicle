import { mkdtemp, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import {
  FileCheckpointManager,
  fileCheckpointDiffStats,
  fileCheckpointTurnDiffStats,
  restoreFileCheckpoint,
} from "../src/core/checkpoints/file-history";
import { createSessionStore, loadSessionSnapshot } from "../src/core/session/store";
import { executeFileTool } from "../src/core/tools";

describe("file checkpoints", () => {
  test("restores overwritten and newly-created files to the state before a user turn", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "vesicle-checkpoint-"));
    await mkdir(join(rootDir, "workspace"), { recursive: true });
    await writeFile(join(rootDir, "workspace", "existing.md"), "before\n", "utf8");

    const store = await createSessionStore(rootDir, "checkpoint-session");
    await store.append({ role: "system", content: "prompt" });
    const user = await store.append({ role: "user", content: "change files" });
    const checkpoint = new FileCheckpointManager(rootDir, store, user.uuid);
    await checkpoint.createSnapshot();
    const beforeMutation = (paths: string[]) => checkpoint.trackBeforeMutation(paths);

    expect((await executeFileTool(rootDir, {
      id: "write",
      name: "write_file",
      arguments: JSON.stringify({ path: "workspace/existing.md", content: "after\nmore\n" }),
    }, { beforeMutation })).ok).toBe(true);
    expect((await executeFileTool(rootDir, {
      id: "create",
      name: "create_file",
      arguments: JSON.stringify({ path: "workspace/new.md", content: "new\n" }),
    }, { beforeMutation })).ok).toBe(true);

    await store.append({ role: "assistant", content: "done" });
    const nextUser = await store.append({ role: "user", content: "next" });
    const nextCheckpoint = new FileCheckpointManager(rootDir, store, nextUser.uuid);
    await nextCheckpoint.createSnapshot();

    const stats = await fileCheckpointDiffStats(rootDir, store.sessionId, user.uuid);
    expect(stats?.filesChanged.sort()).toEqual(["workspace/existing.md", "workspace/new.md"]);
    expect(stats?.insertions).toBeGreaterThan(0);
    expect((await fileCheckpointTurnDiffStats(rootDir, store.sessionId, user.uuid, nextUser.uuid))?.filesChanged.sort())
      .toEqual(["workspace/existing.md", "workspace/new.md"]);

    const restored = await restoreFileCheckpoint(rootDir, store.sessionId, user.uuid);
    expect(restored.sort()).toEqual(["workspace/existing.md", "workspace/new.md"]);
    expect(await readFile(join(rootDir, "workspace", "existing.md"), "utf8")).toBe("before\n");
    await expect(stat(join(rootDir, "workspace", "new.md"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("persists snapshots in JSONL without exposing them as provider messages", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "vesicle-checkpoint-session-"));
    const store = await createSessionStore(rootDir, "checkpoint-resume");
    await store.append({ role: "system", content: "prompt" });
    const user = await store.append({ role: "user", content: "hello" });
    const checkpoint = new FileCheckpointManager(rootDir, store, user.uuid);
    await checkpoint.createSnapshot();
    await store.append({ role: "assistant", content: "world" });

    const snapshot = await loadSessionSnapshot(rootDir, store.sessionId);
    expect(snapshot.messages.map((message) => message.content)).toEqual(["hello", "world"]);
    expect(snapshot.records.some((record) => record.metadata?.kind === "file-history-snapshot")).toBe(true);
  });

  test("does not mix file snapshots from orphaned conversation branches", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "vesicle-checkpoint-branch-"));
    const sessionId = "checkpoint-branches";
    const original = await createSessionStore(rootDir, sessionId);
    await original.append({ role: "system", content: "prompt" });
    const first = await original.append({ role: "user", content: "first" });
    const firstCheckpoint = new FileCheckpointManager(rootDir, original, first.uuid);
    await firstCheckpoint.createSnapshot();
    const firstAnswer = await original.append({ role: "assistant", content: "first answer" });

    const deadTurn = await original.append({ role: "user", content: "dead branch" });
    const deadCheckpoint = new FileCheckpointManager(rootDir, original, deadTurn.uuid);
    await deadCheckpoint.createSnapshot();
    await executeFileTool(rootDir, {
      id: "dead",
      name: "create_file",
      arguments: JSON.stringify({ path: "workspace/dead.md", content: "dead" }),
    }, { beforeMutation: (paths) => deadCheckpoint.trackBeforeMutation(paths) });
    await original.append({ role: "assistant", content: "dead answer" });

    const active = await createSessionStore(rootDir, sessionId, { parentUuid: firstAnswer.uuid });
    const activeTurn = await active.append({ role: "user", content: "active branch" });
    const activeCheckpoint = new FileCheckpointManager(rootDir, active, activeTurn.uuid);
    await activeCheckpoint.createSnapshot();
    await executeFileTool(rootDir, {
      id: "active",
      name: "create_file",
      arguments: JSON.stringify({ path: "workspace/active.md", content: "active" }),
    }, { beforeMutation: (paths) => activeCheckpoint.trackBeforeMutation(paths) });
    await active.append({ role: "assistant", content: "active answer" });

    expect(await restoreFileCheckpoint(rootDir, sessionId, activeTurn.uuid)).toEqual(["workspace/active.md"]);
    expect(await readFile(join(rootDir, "workspace", "dead.md"), "utf8")).toBe("dead");
    await expect(stat(join(rootDir, "workspace", "active.md"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("keeps at most 100 checkpoints active for code restoration", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "vesicle-checkpoint-limit-"));
    const store = await createSessionStore(rootDir, "checkpoint-limit");
    await store.append({ role: "system", content: "prompt" });
    const messageIds: string[] = [];
    for (let index = 0; index < 101; index++) {
      const user = await store.append({ role: "user", content: `turn ${index}` });
      messageIds.push(user.uuid);
      await store.append({
        role: "system",
        content: "",
        metadata: {
          kind: "file-history-snapshot",
          messageId: user.uuid,
          snapshot: { messageId: user.uuid, files: {}, timestamp: new Date().toISOString() },
          isSnapshotUpdate: false,
        },
      });
    }

    expect(await fileCheckpointDiffStats(rootDir, store.sessionId, messageIds[0]!)).toBeUndefined();
    expect(await fileCheckpointDiffStats(rootDir, store.sessionId, messageIds.at(-1)!)).toEqual({
      filesChanged: [],
      insertions: 0,
      deletions: 0,
    });
  });
});
