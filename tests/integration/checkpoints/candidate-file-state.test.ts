import { chmod, mkdtemp, mkdir, readFile, stat, symlink, writeFile } from "node:fs/promises";
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
import { symlinkCapable } from "../../support/symlink-capability";
import { modeZeroDeniesRead } from "../../support/chmod-capability";

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

  test("a degraded candidate with a ledger is still never captured against a foreign disk", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "vesicle-candidate-files-ledger-degraded-"));
    const sessionId = "candidate-files-ledger-degraded";
    await mkdir(join(rootDir, "workspace"), { recursive: true });
    await writeFile(join(rootDir, "workspace", "doc.md"), "before\n", "utf8");

    const store = await createSessionStore(rootDir, sessionId);
    await store.append({ role: "system", content: "prompt" });
    const user = await store.append({ role: "user", content: "write" });

    // Candidate A writes against the true baseline.
    const checkpointA = new FileCheckpointManager(rootDir, store, user.uuid);
    await checkpointA.createSnapshot();
    await executeFileTool(rootDir, {
      id: "a-write",
      name: "write_file",
      arguments: JSON.stringify({ path: "workspace/doc.md", content: "A version\n" }),
    }, { beforeMutation: (paths: string[]) => checkpointA.trackBeforeMutation(paths) });
    const assistantA = await store.append({ role: "assistant", content: "candidate A" });

    // MVP-era shape: candidate B forks WITHOUT a baseline restore, so it runs
    // against A's files. Both candidates have a ledger; neither has a bundle.
    const storeB = await createSessionStore(rootDir, sessionId, { parentUuid: user.uuid });
    const checkpointB = new FileCheckpointManager(rootDir, storeB, user.uuid);
    await checkpointB.createSnapshot();
    await executeFileTool(rootDir, {
      id: "b-write",
      name: "write_file",
      arguments: JSON.stringify({ path: "workspace/doc.md", content: "B version\n" }),
    }, { beforeMutation: (paths: string[]) => checkpointB.trackBeforeMutation(paths) });
    const assistantB = await storeB.append({ role: "assistant", content: "candidate B" });

    // Switch B -> A: A has no bundle, so the switch degrades and marks A; the
    // departing B is still captured truthfully (disk equals B's post-state).
    const toA = await switchCandidateFileState(rootDir, sessionId, {
      forkPointUuid: user.uuid,
      fromLeaf: assistantB.uuid,
      toLeaf: assistantA.uuid,
    });
    expect(toA).toEqual({ restored: false, changed: [], reason: "missing" });
    expect(await readFile(join(rootDir, "workspace", "doc.md"), "utf8")).toBe("B version\n");

    // The disk now holds B's files while the marker points at the degraded A.
    // Leaving A must NOT capture B's files as A's authoritative bundle, even
    // though A has a ledger — this is the regression the marker exists for.
    const toB = await switchCandidateFileState(rootDir, sessionId, {
      forkPointUuid: user.uuid,
      fromLeaf: assistantA.uuid,
      toLeaf: assistantB.uuid,
    });
    expect(toB.restored).toBe(true);
    expect(await readFile(join(rootDir, "workspace", "doc.md"), "utf8")).toBe("B version\n");

    const records = await loadSessionRecords(rootDir, sessionId);
    const bundlesForA = records.filter(
      (record) => record.metadata?.kind === "candidate-file-state" && record.metadata?.leafUuid === assistantA.uuid,
    );
    expect(bundlesForA).toHaveLength(0);
    const bundlesForB = records.filter(
      (record) => record.metadata?.kind === "candidate-file-state" && record.metadata?.leafUuid === assistantB.uuid,
    );
    expect(bundlesForB).toHaveLength(1);
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
        version: 2,
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

  test("version-1 partial bundles are rejected and degrade conversation-only", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "vesicle-candidate-files-v1-"));
    const sessionId = "candidate-files-v1";
    await mkdir(join(rootDir, "workspace"), { recursive: true });
    await writeFile(join(rootDir, "workspace", "existing.md"), "before\n", "utf8");

    const store = await createSessionStore(rootDir, sessionId);
    await store.append({ role: "system", content: "prompt" });
    const user = await store.append({ role: "user", content: "write" });
    const assistantA = await store.append({ role: "assistant", content: "candidate A" });
    const storeB = await createSessionStore(rootDir, sessionId, { parentUuid: user.uuid });
    const assistantB = await storeB.append({ role: "assistant", content: "candidate B" });

    // A legacy (version-less) bundle with otherwise-valid entries: under
    // full-manifest semantics its partial file map must not be applied as if
    // complete, so the parser rejects it and the switch degrades.
    const legacy = await createSessionStore(rootDir, sessionId, { parentUuid: assistantA.uuid });
    await legacy.append({
      role: "system",
      content: "",
      metadata: {
        kind: "candidate-file-state",
        forkPointUuid: user.uuid,
        leafUuid: assistantA.uuid,
        timestamp: new Date().toISOString(),
        files: { "workspace/existing.md": { backup: "5".repeat(64), kind: "file" } },
      },
    });

    const outcome = await switchCandidateFileState(rootDir, sessionId, {
      forkPointUuid: user.uuid,
      fromLeaf: assistantB.uuid,
      toLeaf: assistantA.uuid,
    });
    expect(outcome.restored).toBe(false);
    expect(outcome.reason).toBe("missing");
    expect(await readFile(join(rootDir, "workspace", "existing.md"), "utf8")).toBe("before\n");
  });

  test("files outside every ledger are captured by full manifests and round-trip through switches", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "vesicle-candidate-files-manual-"));
    const sessionId = "candidate-files-manual";
    const { user, assistantA, assistantB } = await buildTwoCandidateSession(rootDir, sessionId);

    // A manual/MCP-style write while B is active: no checkpoint tool saw it.
    await writeFile(join(rootDir, "workspace", "manual.md"), "manual edit\n", "utf8");

    // Leaving B freezes the full disk — including the untracked write — into
    // B's bundle; switching to A deletes it along with B's artifacts.
    const toA = await switchCandidateFileState(rootDir, sessionId, {
      forkPointUuid: user.uuid,
      fromLeaf: assistantB.uuid,
      toLeaf: assistantA.uuid,
    });
    expect(toA.restored).toBe(true);
    await expect(stat(join(rootDir, "workspace", "manual.md"))).rejects.toMatchObject({ code: "ENOENT" });

    // Switching back restores it: it is part of B's recorded post-state now.
    const toB = await switchCandidateFileState(rootDir, sessionId, {
      forkPointUuid: user.uuid,
      fromLeaf: assistantA.uuid,
      toLeaf: assistantB.uuid,
    });
    expect(toB.restored).toBe(true);
    expect(await readFile(join(rootDir, "workspace", "manual.md"), "utf8")).toBe("manual edit\n");
  });

  test("a candidate without any checkpoint ledger still refuses capture and degrades", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "vesicle-candidate-files-no-ledger-"));
    const sessionId = "candidate-files-no-ledger";
    const { user, assistantB } = await buildTwoCandidateSession(rootDir, sessionId);

    // Candidate C forks and writes without a FileCheckpointManager: its branch
    // carries no ledger at all. Full manifests widen the CAPTURE DOMAIN, but
    // the ledger anchor still gates capture — without it the disk-equals-
    // post-state precondition cannot be verified.
    const storeC = await createSessionStore(rootDir, sessionId, { parentUuid: user.uuid });
    await executeFileTool(rootDir, {
      id: "c-create",
      name: "create_file",
      arguments: JSON.stringify({ path: "workspace/c.md", content: "c body\n" }),
    }, {});
    const assistantC = await storeC.append({ role: "assistant", content: "candidate C" });

    expect(await ensureCandidatePostState(rootDir, sessionId, { forkPointUuid: user.uuid, leafUuid: assistantC.uuid })).toBeUndefined();

    // Switching to C degrades conversation-only: B departs truthfully, C is
    // marked, and C's file stays on disk untouched.
    const toC = await switchCandidateFileState(rootDir, sessionId, {
      forkPointUuid: user.uuid,
      fromLeaf: assistantB.uuid,
      toLeaf: assistantC.uuid,
    });
    expect(toC).toEqual({ restored: false, changed: [], reason: "missing" });
    expect(await readFile(join(rootDir, "workspace", "c.md"), "utf8")).toBe("c body\n");

    // Leaving the degraded C must not freeze B's disk state as C's bundle.
    const toB = await switchCandidateFileState(rootDir, sessionId, {
      forkPointUuid: user.uuid,
      fromLeaf: assistantC.uuid,
      toLeaf: assistantB.uuid,
    });
    expect(toB.restored).toBe(true);
    expect(await readFile(join(rootDir, "workspace", "b.md"), "utf8")).toBe("b body\n");
    const records = await loadSessionRecords(rootDir, sessionId);
    expect(records.some((record) => record.metadata?.kind === "candidate-file-state" && record.metadata?.leafUuid === assistantC.uuid)).toBe(false);
  });

  test("scratch tmp/ stays outside manifests and survives candidate switches", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "vesicle-candidate-files-scratch-"));
    const sessionId = "candidate-files-scratch";
    await mkdir(join(rootDir, "tmp"), { recursive: true });
    await writeFile(join(rootDir, "tmp", "spill.txt"), "scratch\n", "utf8");
    const { user, assistantA, assistantB } = await buildTwoCandidateSession(rootDir, sessionId);

    const toA = await switchCandidateFileState(rootDir, sessionId, {
      forkPointUuid: user.uuid,
      fromLeaf: assistantB.uuid,
      toLeaf: assistantA.uuid,
    });
    expect(toA.restored).toBe(true);
    expect(await readFile(join(rootDir, "tmp", "spill.txt"), "utf8")).toBe("scratch\n");

    const toB = await switchCandidateFileState(rootDir, sessionId, {
      forkPointUuid: user.uuid,
      fromLeaf: assistantA.uuid,
      toLeaf: assistantB.uuid,
    });
    expect(toB.restored).toBe(true);
    expect(await readFile(join(rootDir, "tmp", "spill.txt"), "utf8")).toBe("scratch\n");
  });

  test("manual edits after a genuine restore round-trip through a superseding bundle", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "vesicle-candidate-files-supersede-"));
    const sessionId = "candidate-files-supersede";
    const { user, assistantA, assistantB } = await buildTwoCandidateSession(rootDir, sessionId);

    // Switch B -> A: A's bundled manifest is applied (restored marker).
    const toA = await switchCandidateFileState(rootDir, sessionId, {
      forkPointUuid: user.uuid,
      fromLeaf: assistantB.uuid,
      toLeaf: assistantA.uuid,
    });
    expect(toA.restored).toBe(true);

    // The user edits while A is active; the documented promise is that this
    // snapshot is taken when A is left.
    await writeFile(join(rootDir, "workspace", "manual.md"), "manual edit\n", "utf8");

    const toB = await switchCandidateFileState(rootDir, sessionId, {
      forkPointUuid: user.uuid,
      fromLeaf: assistantA.uuid,
      toLeaf: assistantB.uuid,
    });
    expect(toB.restored).toBe(true);
    // B's manifest does not contain the edit, so it leaves the disk...
    await expect(stat(join(rootDir, "workspace", "manual.md"))).rejects.toMatchObject({ code: "ENOENT" });

    // ...but switching back restores it: A's departure captured a SUPERSEDING
    // bundle (the old captured-once reuse would have dropped the edit).
    const backToA = await switchCandidateFileState(rootDir, sessionId, {
      forkPointUuid: user.uuid,
      fromLeaf: assistantB.uuid,
      toLeaf: assistantA.uuid,
    });
    expect(backToA.restored).toBe(true);
    expect(await readFile(join(rootDir, "workspace", "manual.md"), "utf8")).toBe("manual edit\n");

    const records = await loadSessionRecords(rootDir, sessionId);
    const bundlesForA = records.filter(
      (record) => record.metadata?.kind === "candidate-file-state" && record.metadata?.leafUuid === assistantA.uuid,
    );
    expect(bundlesForA.length).toBeGreaterThanOrEqual(2);
    expect(Object.keys(bundlesForA.at(-1)?.metadata?.files as Record<string, unknown>)).toContain("workspace/manual.md");
  });

  test.skipIf(!modeZeroDeniesRead)(
    "a failed switch poisons both leaves until a successful restore revives them",
    async () => {
      const rootDir = await mkdtemp(join(tmpdir(), "vesicle-candidate-files-poison-"));
      const sessionId = "candidate-files-poison";
      const { user, assistantA, assistantB } = await buildTwoCandidateSession(rootDir, sessionId);

      // Degrade a bundle-less candidate C, then activate B through it: B
      // inherits a degraded marker (conversation-only switch) while the disk
      // still holds A's files. Degradation also means B's departure will skip
      // the disk read, so the sabotage below reaches the APPLY phase.
      const storeC = await createSessionStore(rootDir, sessionId, { parentUuid: user.uuid });
      const assistantC = await storeC.append({ role: "assistant", content: "candidate C" });
      const toC = await switchCandidateFileState(rootDir, sessionId, {
        forkPointUuid: user.uuid,
        fromLeaf: assistantA.uuid,
        toLeaf: assistantC.uuid,
      });
      expect(toC.reason).toBe("missing");
      const toB = await switchCandidateFileState(rootDir, sessionId, {
        forkPointUuid: user.uuid,
        fromLeaf: assistantC.uuid,
        toLeaf: assistantB.uuid,
      });
      expect(toB.reason).toBe("missing");

      // Sabotage: make a file unreadable so applying A's manifest throws
      // inside the path guards.
      await chmod(join(rootDir, "workspace", "existing.md"), 0);

      await expect(switchCandidateFileState(rootDir, sessionId, {
        forkPointUuid: user.uuid,
        fromLeaf: assistantB.uuid,
        toLeaf: assistantA.uuid,
      })).rejects.toThrow();

      // Both leaves lose on-disk authority: the half-restored disk belongs to
      // neither, so captures are refused for both.
      let records = await loadSessionRecords(rootDir, sessionId);
      const latestKinds = new Map<string, string>();
      for (const record of records) {
        const leaf = record.metadata?.leafUuid;
        const kind = record.metadata?.kind;
        if (typeof leaf === "string" && (kind === "candidate-file-state" || kind === "candidate-file-degraded" || kind === "candidate-file-restored")) {
          latestKinds.set(leaf, kind);
        }
      }
      expect(latestKinds.get(assistantA.uuid)).toBe("candidate-file-degraded");
      expect(latestKinds.get(assistantB.uuid)).toBe("candidate-file-degraded");
      expect(await ensureCandidatePostState(rootDir, sessionId, { forkPointUuid: user.uuid, leafUuid: assistantB.uuid })).toBeUndefined();

      // Repair and retry: A's bundle still restores (degradation blocks
      // capture, not restoration), and the success revives re-capture.
      await chmod(join(rootDir, "workspace", "existing.md"), 0o644);
      const retry = await switchCandidateFileState(rootDir, sessionId, {
        forkPointUuid: user.uuid,
        fromLeaf: assistantB.uuid,
        toLeaf: assistantA.uuid,
      });
      expect(retry.restored).toBe(true);
      expect(await readFile(join(rootDir, "workspace", "existing.md"), "utf8")).toBe("A version\n");

      records = await loadSessionRecords(rootDir, sessionId);
      const eventsForA = records.filter((record) => {
        const kind = record.metadata?.kind;
        return record.metadata?.leafUuid === assistantA.uuid
          && (kind === "candidate-file-state" || kind === "candidate-file-degraded" || kind === "candidate-file-restored");
      });
      expect(eventsForA.at(-1)?.metadata?.kind).toBe("candidate-file-restored");
      expect(await ensureCandidatePostState(rootDir, sessionId, { forkPointUuid: user.uuid, leafUuid: assistantA.uuid })).toBeDefined();
      void assistantC;
    },
  );

  test.skipIf(!symlinkCapable)("symlinks are never captured or deleted; switches report them as untracked", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "vesicle-candidate-files-symlink-"));
    const sessionId = "candidate-files-symlink";
    await mkdir(join(rootDir, "workspace"), { recursive: true });
    await writeFile(join(rootDir, "workspace", "existing.md"), "before\n", "utf8");
    await symlink(join(rootDir, "workspace", "existing.md"), join(rootDir, "workspace", "link.md"));

    const { user, assistantA, assistantB } = await buildTwoCandidateSession(rootDir, sessionId);

    const toA = await switchCandidateFileState(rootDir, sessionId, {
      forkPointUuid: user.uuid,
      fromLeaf: assistantB.uuid,
      toLeaf: assistantA.uuid,
    });
    expect(toA.restored).toBe(true);
    expect(toA.untracked).toContain("workspace/link.md");
    // The symlink survives the manifest application untouched.
    const linkInfo = await stat(join(rootDir, "workspace", "link.md"));
    expect(linkInfo.isFile()).toBe(true);
    expect(await readFile(join(rootDir, "workspace", "existing.md"), "utf8")).toBe("A version\n");
  });
});
