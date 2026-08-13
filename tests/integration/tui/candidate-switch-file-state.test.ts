import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import { ensureCandidatePostState, restoreForkBaseline } from "../../../src/core/checkpoints/candidate-files";
import { FileCheckpointManager } from "../../../src/core/checkpoints/file-history";
import { appendCandidateSelection, findLatestSelection } from "../../../src/core/session/selection";
import { createSessionStore, loadSessionRecords } from "../../../src/core/session/store";
import { executeFileTool } from "../../../src/core/tools";
import { createTurnController } from "../../../src/tui/turn-controller";

// Per-candidate file coexistence at the TUI boundary: switchCandidate restores
// the target candidate's files BEFORE writing the selection marker, and refuses
// to switch while a background SubAgent could race the restore.

function controllerOptions(rootDir: string, sessionId: string, overrides: { agentCards?: unknown[] } = {}) {
  const statuses: string[] = [];
  const options = {
    rootDir,
    sessionId: () => sessionId,
    busy: () => false,
    setBusy: () => false,
    setConversation: () => undefined,
    setStatus: (status: string) => { statuses.push(status); },
    setMessages: () => undefined,
    setOutput: () => undefined,
    setStreamingAssistant: () => undefined,
    setStreamingReasoning: () => undefined,
    recordActivity: () => undefined,
    refreshArtifacts: async () => undefined,
    agentCards: () => overrides.agentCards ?? [],
    setPendingGate: () => undefined,
    setPendingEngineSwitch: () => undefined,
    setPendingUserQuestion: () => undefined,
    setPendingPermission: () => undefined,
    setPendingQualityDecision: () => undefined,
    queuedWork: { prepareTurn: () => undefined, block: () => undefined, handleInterruption: async () => false, takePendingUserInputs: () => [], runToolBoundaryCommands: async () => undefined },
    runCancellable: async <T>(operation: (signal: AbortSignal) => Promise<T>) => ({ kind: "complete" as const, value: await operation(new AbortController().signal) }),
  };
  return { options: options as unknown as Parameters<typeof createTurnController>[0], statuses };
}

/**
 * Two file-writing candidates off one fork: A writes doc.md to "A", departs
 * (bundled), the baseline is restored, B forks and writes doc.md to "B", and a
 * marker selects B. Disk is B's post-state when the helper returns.
 */
async function twoFileWritingCandidates(root: string) {
  await mkdir(join(root, "workspace"), { recursive: true });
  await writeFile(join(root, "workspace", "doc.md"), "before\n", "utf8");
  const session = await createSessionStore(root, "s");
  await session.append({ role: "system", content: "prompt", metadata: { engine: "etl" } });
  const user = await session.append({ role: "user", content: "turn 1", metadata: { logicalTurnId: "t1", providerRoundId: "r1" } });

  const checkpointA = new FileCheckpointManager(root, session, user.uuid);
  await checkpointA.createSnapshot();
  await executeFileTool(root, {
    id: "a-write",
    name: "write_file",
    arguments: JSON.stringify({ path: "workspace/doc.md", content: "A\n" }),
  }, { beforeMutation: (paths: string[]) => checkpointA.trackBeforeMutation(paths) });
  const asstA = await session.append({ role: "assistant", content: "A1", metadata: { logicalTurnId: "t1", providerRoundId: "r1" } });

  await ensureCandidatePostState(root, "s", { forkPointUuid: user.uuid, leafUuid: asstA.uuid });
  await restoreForkBaseline(root, "s", user.uuid);

  const forked = await createSessionStore(root, "s", { parentUuid: user.uuid });
  const checkpointB = new FileCheckpointManager(root, forked, user.uuid);
  await checkpointB.createSnapshot();
  await executeFileTool(root, {
    id: "b-write",
    name: "write_file",
    arguments: JSON.stringify({ path: "workspace/doc.md", content: "B\n" }),
  }, { beforeMutation: (paths: string[]) => checkpointB.trackBeforeMutation(paths) });
  const asstB = await forked.append({ role: "assistant", content: "A2", metadata: { logicalTurnId: "t1", providerRoundId: "r2" } });
  await appendCandidateSelection(root, "s", { forkPointUuid: user.uuid, selectedLeafUuid: asstB.uuid });
  return { user, asstA, asstB };
}

test("switchCandidate moves the marker and the files together", async () => {
  const root = await mkdtemp(join(tmpdir(), "vesicle-tui-switch-files-"));
  try {
    const { asstA } = await twoFileWritingCandidates(root);
    expect(await readFile(join(root, "workspace", "doc.md"), "utf8")).toBe("B\n");

    const { options, statuses } = controllerOptions(root, "s");
    const controller = createTurnController(options);
    await controller.refreshCandidateSwitcher("s");
    expect(controller.candidateSwitcher()?.total).toBe(2);

    await controller.switchCandidate(-1);

    expect(await readFile(join(root, "workspace", "doc.md"), "utf8")).toBe("A\n");
    const selection = findLatestSelection(await loadSessionRecords(root, "s"));
    expect(selection?.selectedLeafUuid).toBe(asstA.uuid);
    expect(controller.candidateSwitcher()?.index).toBe(0);
    expect(statuses.at(-1)).toBe("candidate 1/2");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("switchCandidate refuses while a background SubAgent is running", async () => {
  const root = await mkdtemp(join(tmpdir(), "vesicle-tui-switch-agent-"));
  try {
    const { asstB } = await twoFileWritingCandidates(root);
    const markersBefore = (await loadSessionRecords(root, "s"))
      .filter((record) => record.metadata?.kind === "candidate-selection").length;

    const { options, statuses } = controllerOptions(root, "s", { agentCards: [{ status: "running" }] });
    const controller = createTurnController(options);
    await controller.refreshCandidateSwitcher("s");
    expect(controller.candidateSwitcher()?.total).toBe(2);

    await controller.switchCandidate(-1);

    // No marker appended, no file restore attempted, switcher unchanged.
    const markersAfter = (await loadSessionRecords(root, "s"))
      .filter((record) => record.metadata?.kind === "candidate-selection").length;
    expect(markersAfter).toBe(markersBefore);
    expect(await readFile(join(root, "workspace", "doc.md"), "utf8")).toBe("B\n");
    expect(findLatestSelection(await loadSessionRecords(root, "s"))?.selectedLeafUuid).toBe(asstB.uuid);
    expect(controller.candidateSwitcher()?.index).toBe(1);
    expect(statuses.at(-1)).toBe("wait for active SubAgents before switching candidates");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a hostile filesystem aborts the switch before the marker is written", async () => {
  const root = await mkdtemp(join(tmpdir(), "vesicle-tui-switch-fail-"));
  const outside = await mkdtemp(join(tmpdir(), "vesicle-tui-switch-fail-outside-"));
  try {
    const { user, asstB } = await twoFileWritingCandidates(root);
    const markersBefore = (await loadSessionRecords(root, "s"))
      .filter((record) => record.metadata?.kind === "candidate-selection").length;
    // B departs with a clean bundle before the sabotage below.
    await ensureCandidatePostState(root, "s", { forkPointUuid: user.uuid, leafUuid: asstB.uuid });

    const { options, statuses } = controllerOptions(root, "s");
    const controller = createTurnController(options);
    await controller.refreshCandidateSwitcher("s");
    expect(controller.candidateSwitcher()?.total).toBe(2);

    // Externally introduced symlink ancestor after arming: the restore must
    // refuse to write through it (same contract as /rewind) and throw.
    await rm(join(root, "workspace"), { recursive: true, force: true });
    await writeFile(join(outside, "doc.md"), "outside\n", "utf8");
    await symlink(outside, join(root, "workspace"), "dir");

    await controller.switchCandidate(-1);

    // No marker appended; the switcher and the active candidate are unchanged,
    // and the symlink target was never written through.
    const markersAfter = (await loadSessionRecords(root, "s"))
      .filter((record) => record.metadata?.kind === "candidate-selection").length;
    expect(markersAfter).toBe(markersBefore);
    expect(findLatestSelection(await loadSessionRecords(root, "s"))?.selectedLeafUuid).toBe(asstB.uuid);
    expect(controller.candidateSwitcher()?.index).toBe(1);
    expect(statuses.at(-1)).toBe("error");
    expect(await readFile(join(outside, "doc.md"), "utf8")).toBe("outside\n");
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});
