import { mkdtemp, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import {
  ensureCandidatePostState,
  findCandidatePostState,
  isCandidateFileStateRecord,
  restoreForkBaseline,
  switchCandidateFileState,
} from "../../../src/core/checkpoints/candidate-files";
import { FileCheckpointManager } from "../../../src/core/checkpoints/file-history";
import { enumerateCandidateLeaves, findLatestSelection } from "../../../src/core/session/selection";
import { createSessionStore, loadSessionRecords, loadSessionSnapshot } from "../../../src/core/session/store";
import { executeFileTool } from "../../../src/core/tools";

/**
 * Builds the shared half of a two-candidate session: candidate A runs against
 * t0 (modifying workspace/existing.md and creating workspace/a.md), departs
 * with a post-state bundle, the baseline is restored, and candidate B forks
 * off the shared user record against the baseline (modifying existing.md and
 * creating workspace/b.md). Returns the handles the tests switch between.
 */
async function buildTwoCandidateSession(rootDir: string, sessionId: string) {
  await mkdir(join(rootDir, "workspace"), { recursive: true });
  await writeFile(join(rootDir, "workspace", "existing.md"), "before\n", "utf8");

  const store = await createSessionStore(rootDir, sessionId);
  await store.append({ role: "system", content: "prompt" });
  const user = await store.append({ role: "user", content: "write" });

  const checkpointA = new FileCheckpointManager(rootDir, store, user.uuid);
  await checkpointA.createSnapshot();
  const beforeA = (paths: string[]) => checkpointA.trackBeforeMutation(paths);
  await executeFileTool(rootDir, {
    id: "a-write",
    name: "write_file",
    arguments: JSON.stringify({ path: "workspace/existing.md", content: "A version\n" }),
  }, { beforeMutation: beforeA });
  await executeFileTool(rootDir, {
    id: "a-create",
    name: "create_file",
    arguments: JSON.stringify({ path: "workspace/a.md", content: "a body\n" }),
  }, { beforeMutation: beforeA });
  const assistantA = await store.append({ role: "assistant", content: "candidate A" });

  await ensureCandidatePostState(rootDir, sessionId, { forkPointUuid: user.uuid, leafUuid: assistantA.uuid });
  await restoreForkBaseline(rootDir, sessionId, user.uuid);

  const storeB = await createSessionStore(rootDir, sessionId, { parentUuid: user.uuid });
  const checkpointB = new FileCheckpointManager(rootDir, storeB, user.uuid);
  await checkpointB.createSnapshot();
  const beforeB = (paths: string[]) => checkpointB.trackBeforeMutation(paths);
  await executeFileTool(rootDir, {
    id: "b-write",
    name: "write_file",
    arguments: JSON.stringify({ path: "workspace/existing.md", content: "B version\n" }),
  }, { beforeMutation: beforeB });
  await executeFileTool(rootDir, {
    id: "b-create",
    name: "create_file",
    arguments: JSON.stringify({ path: "workspace/b.md", content: "b body\n" }),
  }, { beforeMutation: beforeB });
  const assistantB = await storeB.append({ role: "assistant", content: "candidate B" });

  return { user, assistantA, assistantB };
}

describe("candidate file coexistence", () => {
  test("switching candidates switches the on-disk file state in both directions", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "vesicle-candidate-files-"));
    const sessionId = "candidate-files-switch";
    const { user, assistantA, assistantB } = await buildTwoCandidateSession(rootDir, sessionId);

    // Setup ends with B finished: disk is B's post-state (A's artifacts were
    // already removed by the baseline restore before B ran).
    expect(await readFile(join(rootDir, "workspace", "existing.md"), "utf8")).toBe("B version\n");
    expect(await readFile(join(rootDir, "workspace", "b.md"), "utf8")).toBe("b body\n");
    await expect(stat(join(rootDir, "workspace", "a.md"))).rejects.toMatchObject({ code: "ENOENT" });

    const toA = await switchCandidateFileState(rootDir, sessionId, {
      forkPointUuid: user.uuid,
      fromLeaf: assistantB.uuid,
      toLeaf: assistantA.uuid,
    });
    expect(toA.restored).toBe(true);
    expect(await readFile(join(rootDir, "workspace", "existing.md"), "utf8")).toBe("A version\n");
    expect(await readFile(join(rootDir, "workspace", "a.md"), "utf8")).toBe("a body\n");
    await expect(stat(join(rootDir, "workspace", "b.md"))).rejects.toMatchObject({ code: "ENOENT" });

    const toB = await switchCandidateFileState(rootDir, sessionId, {
      forkPointUuid: user.uuid,
      fromLeaf: assistantA.uuid,
      toLeaf: assistantB.uuid,
    });
    expect(toB.restored).toBe(true);
    expect(await readFile(join(rootDir, "workspace", "existing.md"), "utf8")).toBe("B version\n");
    expect(await readFile(join(rootDir, "workspace", "b.md"), "utf8")).toBe("b body\n");
    await expect(stat(join(rootDir, "workspace", "a.md"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("a candidate is captured once; later external disk changes never overwrite its bundle", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "vesicle-candidate-files-skip-"));
    const sessionId = "candidate-files-skip";
    const { user, assistantA } = await buildTwoCandidateSession(rootDir, sessionId);

    const first = await ensureCandidatePostState(rootDir, sessionId, { forkPointUuid: user.uuid, leafUuid: assistantA.uuid });
    expect(first).toBeDefined();
    await writeFile(join(rootDir, "workspace", "existing.md"), "externally changed\n", "utf8");
    const second = await ensureCandidatePostState(rootDir, sessionId, { forkPointUuid: user.uuid, leafUuid: assistantA.uuid });
    expect(second?.files["workspace/existing.md"]?.backup).toBe(first?.files["workspace/existing.md"]?.backup);

    const records = await loadSessionRecords(rootDir, sessionId);
    const bundlesForA = records.filter(
      (record) => isCandidateFileStateRecord(record) && record.metadata?.leafUuid === assistantA.uuid,
    );
    expect(bundlesForA).toHaveLength(1);
  });

  test("switching to a never-departed legacy candidate degrades to conversation-only", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "vesicle-candidate-files-legacy-"));
    const sessionId = "candidate-files-legacy";
    const { user, assistantA, assistantB } = await buildTwoCandidateSession(rootDir, sessionId);
    // A departed (bundled) during setup; B never did. Drop B's hypothetical
    // bundle path by switching TO B from a state where B has none recorded.
    const recordsBefore = await loadSessionRecords(rootDir, sessionId);
    expect(findCandidatePostState(recordsBefore, assistantB.uuid)).toBeUndefined();

    const outcome = await switchCandidateFileState(rootDir, sessionId, {
      forkPointUuid: user.uuid,
      fromLeaf: assistantA.uuid,
      toLeaf: assistantB.uuid,
    });
    expect(outcome).toEqual({ restored: false, changed: [], reason: "missing" });
    // Disk untouched: B's artifacts remain exactly as they were.
    expect(await readFile(join(rootDir, "workspace", "existing.md"), "utf8")).toBe("B version\n");
    expect(await readFile(join(rootDir, "workspace", "b.md"), "utf8")).toBe("b body\n");
  });

  test("the fork baseline merge is first-wins so MVP-era polluted pre-states resolve to the true baseline", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "vesicle-candidate-files-baseline-"));
    const sessionId = "candidate-files-baseline";
    await mkdir(join(rootDir, "workspace"), { recursive: true });
    await writeFile(join(rootDir, "workspace", "existing.md"), "before\n", "utf8");

    const store = await createSessionStore(rootDir, sessionId);
    await store.append({ role: "system", content: "prompt" });
    const user = await store.append({ role: "user", content: "write" });

    // Candidate A: t0 -> tA.
    const checkpointA = new FileCheckpointManager(rootDir, store, user.uuid);
    await checkpointA.createSnapshot();
    const beforeA = (paths: string[]) => checkpointA.trackBeforeMutation(paths);
    await executeFileTool(rootDir, {
      id: "a-write",
      name: "write_file",
      arguments: JSON.stringify({ path: "workspace/existing.md", content: "A version\n" }),
    }, { beforeMutation: beforeA });
    await executeFileTool(rootDir, {
      id: "a-create",
      name: "create_file",
      arguments: JSON.stringify({ path: "workspace/a.md", content: "a body\n" }),
    }, { beforeMutation: beforeA });
    await store.append({ role: "assistant", content: "candidate A" });

    // MVP-era shape: B forks WITHOUT a baseline restore, so B's pre-turn
    // snapshot records A's polluted state for existing.md.
    const storeB = await createSessionStore(rootDir, sessionId, { parentUuid: user.uuid });
    const checkpointB = new FileCheckpointManager(rootDir, storeB, user.uuid);
    await checkpointB.createSnapshot();
    const beforeB = (paths: string[]) => checkpointB.trackBeforeMutation(paths);
    await executeFileTool(rootDir, {
      id: "b-write",
      name: "write_file",
      arguments: JSON.stringify({ path: "workspace/existing.md", content: "B version\n" }),
    }, { beforeMutation: beforeB });
    await storeB.append({ role: "assistant", content: "candidate B" });

    expect(await readFile(join(rootDir, "workspace", "existing.md"), "utf8")).toBe("B version\n");
    await restoreForkBaseline(rootDir, sessionId, user.uuid);
    // A's earlier pre-state wins for existing.md; A's creation is deleted.
    expect(await readFile(join(rootDir, "workspace", "existing.md"), "utf8")).toBe("before\n");
    await expect(stat(join(rootDir, "workspace", "a.md"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("bundles stay out of provider projection and candidate enumeration", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "vesicle-candidate-files-projection-"));
    const sessionId = "candidate-files-projection";
    const { user, assistantA, assistantB } = await buildTwoCandidateSession(rootDir, sessionId);

    const records = await loadSessionRecords(rootDir, sessionId);
    expect(records.some((record) => isCandidateFileStateRecord(record))).toBe(true);

    // Provider projection exposes only conversation content; the default branch
    // walks to candidate B (the physical tail) and bundle records never leak in.
    const snapshot = await loadSessionSnapshot(rootDir, sessionId);
    expect(snapshot.messages.map((message) => message.content)).toEqual(["write", "candidate B"]);

    // Candidate enumeration and selection oracles are unaffected by bundle records.
    const leaves = enumerateCandidateLeaves(records, user.uuid).map((record) => record.uuid);
    expect(leaves).toEqual([assistantA.uuid, assistantB.uuid]);
    expect(findLatestSelection(records)).toBeUndefined();
  });

  test("a host-process-tainted candidate reports taint on switch", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "vesicle-candidate-files-taint-"));
    const sessionId = "candidate-files-taint";
    await mkdir(join(rootDir, "workspace"), { recursive: true });
    await writeFile(join(rootDir, "workspace", "existing.md"), "before\n", "utf8");

    const store = await createSessionStore(rootDir, sessionId);
    await store.append({ role: "system", content: "prompt" });
    const user = await store.append({ role: "user", content: "write" });
    const checkpointA = new FileCheckpointManager(rootDir, store, user.uuid);
    await checkpointA.createSnapshot();
    await checkpointA.trackBeforeMutation(["workspace/existing.md"]);
    await writeFile(join(rootDir, "workspace", "existing.md"), "A version\n", "utf8");
    await checkpointA.markTaintedByHostProcess();
    const assistantA = await store.append({ role: "assistant", content: "candidate A" });

    const storeB = await createSessionStore(rootDir, sessionId, { parentUuid: user.uuid });
    const assistantB = await storeB.append({ role: "assistant", content: "candidate B" });

    // A departs (capturing its tainted post-state), then we switch back to it.
    await ensureCandidatePostState(rootDir, sessionId, { forkPointUuid: user.uuid, leafUuid: assistantA.uuid });
    const outcome = await switchCandidateFileState(rootDir, sessionId, {
      forkPointUuid: user.uuid,
      fromLeaf: assistantB.uuid,
      toLeaf: assistantA.uuid,
    });
    expect(outcome.restored).toBe(true);
    expect(outcome.tainted).toBe(true);
    expect(await readFile(join(rootDir, "workspace", "existing.md"), "utf8")).toBe("A version\n");
  });

  test("all candidate file operations no-op when checkpointing is disabled", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "vesicle-candidate-files-disabled-"));
    const sessionId = "candidate-files-disabled";
    const { user, assistantA, assistantB } = await buildTwoCandidateSession(rootDir, sessionId);
    await writeFile(join(rootDir, "workspace", "existing.md"), "untouched\n", "utf8");

    process.env.VESICLE_DISABLE_FILE_CHECKPOINTING = "1";
    try {
      expect(await ensureCandidatePostState(rootDir, sessionId, { forkPointUuid: user.uuid, leafUuid: assistantA.uuid })).toBeUndefined();
      expect(await restoreForkBaseline(rootDir, sessionId, user.uuid)).toEqual([]);
      expect(await switchCandidateFileState(rootDir, sessionId, {
        forkPointUuid: user.uuid,
        fromLeaf: assistantA.uuid,
        toLeaf: assistantB.uuid,
      })).toEqual({ restored: false, changed: [], reason: "disabled" });
      expect(await readFile(join(rootDir, "workspace", "existing.md"), "utf8")).toBe("untouched\n");
    } finally {
      delete process.env.VESICLE_DISABLE_FILE_CHECKPOINTING;
    }
  });

  test("conversation-only switches mark degradation and never freeze a wrong bundle", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "vesicle-candidate-files-degraded-"));
    const sessionId = "candidate-files-degraded";
    const { user, assistantA, assistantB } = await buildTwoCandidateSession(rootDir, sessionId);

    // Candidate C forks with no checkpoint ledger and is selected by a
    // conversation-only operation: nothing is restored, so the disk still
    // holds B's post-state while the marker points at C.
    const storeC = await createSessionStore(rootDir, sessionId, { parentUuid: user.uuid });
    const assistantC = await storeC.append({ role: "assistant", content: "candidate C" });
    const toC = await switchCandidateFileState(rootDir, sessionId, {
      forkPointUuid: user.uuid,
      fromLeaf: assistantB.uuid,
      toLeaf: assistantC.uuid,
    });
    expect(toC).toEqual({ restored: false, changed: [], reason: "missing" });
    expect(await readFile(join(rootDir, "workspace", "existing.md"), "utf8")).toBe("B version\n");

    // Leaving the degraded candidate must NOT capture B's files as C's
    // authoritative bundle — the disk is not C's post-state.
    expect(await ensureCandidatePostState(rootDir, sessionId, { forkPointUuid: user.uuid, leafUuid: assistantC.uuid })).toBeUndefined();

    // Switching to a bundled candidate restores truthfully again.
    const toB = await switchCandidateFileState(rootDir, sessionId, {
      forkPointUuid: user.uuid,
      fromLeaf: assistantC.uuid,
      toLeaf: assistantB.uuid,
    });
    expect(toB.restored).toBe(true);
    expect(await readFile(join(rootDir, "workspace", "existing.md"), "utf8")).toBe("B version\n");
    expect(await readFile(join(rootDir, "workspace", "b.md"), "utf8")).toBe("b body\n");
    await expect(stat(join(rootDir, "workspace", "a.md"))).rejects.toMatchObject({ code: "ENOENT" });
    void assistantA;
  });

  test("malformed bundle entries are rejected at parse and degrade to conversation-only", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "vesicle-candidate-files-malformed-"));
    const sessionId = "candidate-files-malformed";
    await mkdir(join(rootDir, "workspace"), { recursive: true });
    await writeFile(join(rootDir, "workspace", "existing.md"), "before\n", "utf8");

    const store = await createSessionStore(rootDir, sessionId);
    await store.append({ role: "system", content: "prompt" });
    const user = await store.append({ role: "user", content: "write" });
    const assistantA = await store.append({ role: "assistant", content: "candidate A" });
    const storeB = await createSessionStore(rootDir, sessionId, { parentUuid: user.uuid });
    const assistantB = await storeB.append({ role: "assistant", content: "candidate B" });

    // A crafted session record tries to steer the restore outside the project:
    // a path-traversal entry key and a non-content-addressed backup name.
    const hostile = await createSessionStore(rootDir, sessionId, { parentUuid: assistantA.uuid });
    await hostile.append({
      role: "system",
      content: "",
      metadata: {
        kind: "candidate-file-state",
        forkPointUuid: user.uuid,
        leafUuid: assistantA.uuid,
        timestamp: new Date().toISOString(),
        files: {
          "../../evil.md": { backup: "4".repeat(64), kind: "file" },
          "workspace/existing.md": { backup: "../../../../etc/passwd", kind: "file" },
        },
      },
    });

    // The malformed bundle is ignored entirely; the switch degrades instead of
    // reading or writing through the crafted entries.
    const outcome = await switchCandidateFileState(rootDir, sessionId, {
      forkPointUuid: user.uuid,
      fromLeaf: assistantB.uuid,
      toLeaf: assistantA.uuid,
    });
    expect(outcome.restored).toBe(false);
    expect(outcome.reason).toBe("missing");
    expect(await readFile(join(rootDir, "workspace", "existing.md"), "utf8")).toBe("before\n");
    await expect(stat(join(rootDir, "..", "evil.md"))).rejects.toMatchObject({ code: "ENOENT" });
  });
});
