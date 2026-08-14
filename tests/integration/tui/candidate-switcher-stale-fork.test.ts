import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import { createSessionStore, loadSessionRecords } from "../../../src/core/session/store";
import { appendCandidateSelection } from "../../../src/core/session/selection";
import { createTurnController } from "../../../src/tui/turn-controller";

// Bot Review blocking finding: the switcher must NOT arm when the conversation
// has moved past the candidate fork point, otherwise Option+←/→ would re-point
// the active branch backward and orphan the later turns. These tests build the
// real durable state and exercise refreshCandidateSwitcher through the
// controller, so the fork-point-is-last-turn guard is covered end-to-end.

function minimalControllerOptions(rootDir: string, sessionId: string) {
  // refreshCandidateSwitcher only reads the session file; the other ports are
  // stubbed because no turn runs here.
  return {
    rootDir,
    sessionId: () => sessionId,
    busy: () => false,
    setBusy: () => false,
    queuedWork: { prepareTurn: () => undefined, block: () => undefined, handleInterruption: async () => false, takePendingUserInputs: () => [], runToolBoundaryCommands: async () => undefined },
    runCancellable: async <T>(operation: (signal: AbortSignal) => Promise<T>) => ({ kind: "complete" as const, value: await operation(new AbortController().signal) }),
  } as unknown as Parameters<typeof createTurnController>[0];
}

async function twoCandidatesWithMarker(root: string, forkPointContent: string) {
  const session = await createSessionStore(root, "s");
  await session.append({ role: "system", content: "prompt", metadata: { engine: "etl" } });
  const user1 = await session.append({ role: "user", content: forkPointContent, metadata: { logicalTurnId: "t1", providerRoundId: "r1" } });
  await session.append({ role: "assistant", content: "A1", metadata: { logicalTurnId: "t1", providerRoundId: "r1" } });
  const forked = await createSessionStore(root, "s", { parentUuid: user1.uuid });
  const asst2 = await forked.append({ role: "assistant", content: "A2", metadata: { logicalTurnId: "t1b", providerRoundId: "r1b" } });
  await appendCandidateSelection(root, "s", { forkPointUuid: user1.uuid, selectedLeafUuid: asst2.uuid });
  return user1.uuid;
}

test("candidate switcher does not arm when the conversation moved past the fork point", async () => {
  const root = await mkdtemp(join(tmpdir(), "vesicle-cand-stale-"));
  try {
    const user1 = await twoCandidatesWithMarker(root, "turn 1");
    // A later turn appended after the marker makes the fork point stale.
    const turn2 = await createSessionStore(root, "s");
    await turn2.append({ role: "user", content: "turn 2", metadata: { logicalTurnId: "t2", providerRoundId: "r2" } });
    await turn2.append({ role: "assistant", content: "A3", metadata: { logicalTurnId: "t2", providerRoundId: "r2" } });

    const controller = createTurnController(minimalControllerOptions(root, "s"));
    await controller.refreshCandidateSwitcher("s");
    expect(controller.candidateSwitcher()).toBeNull();
    void user1;
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("candidate switcher arms when the fork point is still the last turn", async () => {
  const root = await mkdtemp(join(tmpdir(), "vesicle-cand-live-"));
  try {
    const user1 = await twoCandidatesWithMarker(root, "turn 1");
    // No later turn: the fork point is still the active branch's last turn.

    const controller = createTurnController(minimalControllerOptions(root, "s"));
    await controller.refreshCandidateSwitcher("s");
    const switcher = controller.candidateSwitcher();
    expect(switcher).not.toBeNull();
    expect(switcher?.forkPointUuid).toBe(user1);
    expect(switcher?.total).toBe(2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("candidate switcher refresh replaces a paused leaf with its completed continuation", async () => {
  const root = await mkdtemp(join(tmpdir(), "vesicle-cand-cont-"));
  try {
    const session = await createSessionStore(root, "s");
    await session.append({ role: "system", content: "prompt", metadata: { engine: "etl" } });
    const user = await session.append({ role: "user", content: "turn 1" });
    await session.append({ role: "assistant", content: "A1" });
    const forked = await createSessionStore(root, "s", { parentUuid: user.uuid });
    const paused = await forked.append({
      role: "assistant",
      content: "paused",
      metadata: { toolCalls: [{ id: "gate", name: "request_confirmation", arguments: "{}" }] },
    });
    const marker = await appendCandidateSelection(root, "s", { forkPointUuid: user.uuid, selectedLeafUuid: paused.uuid });
    const controller = createTurnController(minimalControllerOptions(root, "s"));
    await controller.refreshCandidateSwitcher("s");
    expect(controller.candidateSwitcher()?.leaves).toContain(paused.uuid);

    const continuation = await createSessionStore(root, "s", { parentUuid: marker.uuid });
    await continuation.append({ role: "tool", content: "approved", metadata: { toolCallId: "gate", ok: true } });
    const final = await continuation.append({ role: "assistant", content: "completed" });
    await controller.refreshCandidateSwitcher("s");

    expect(controller.candidateSwitcher()?.leaves).toContain(final.uuid);
    expect(controller.candidateSwitcher()?.leaves).not.toContain(paused.uuid);
    expect(controller.candidateSwitcher()?.index).toBe(1);
    expect((await loadSessionRecords(root, "s")).at(-1)?.uuid).toBe(final.uuid);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a deep selection marker re-arms the switcher at the selected depth", async () => {
  // Any-depth switching keys the marker's forkPointUuid on the target leaf's
  // owning turn (ownerForkOfLeaf). The inline switcher must then arm at THAT
  // depth with the siblings of the selected leaf, not at the top fork.
  const root = await mkdtemp(join(tmpdir(), "vesicle-cand-deep-"));
  try {
    const session = await createSessionStore(root, "s");
    await session.append({ role: "system", content: "prompt", metadata: { engine: "etl" } });
    const user1 = await session.append({ role: "user", content: "turn 1", metadata: { logicalTurnId: "t1", providerRoundId: "r1" } });
    await session.append({ role: "assistant", content: "A1", metadata: { logicalTurnId: "t1", providerRoundId: "r1" } });

    // Candidate B forks at turn 1 and continues to turn 2.
    const storeB = await createSessionStore(root, "s", { parentUuid: user1.uuid });
    const b1 = await storeB.append({ role: "assistant", content: "B1", metadata: { logicalTurnId: "t1b", providerRoundId: "r1b" } });
    const turn2 = await createSessionStore(root, "s");
    const user2 = await turn2.append({ role: "user", content: "turn 2", metadata: { logicalTurnId: "t2", providerRoundId: "r2" } });
    const c1 = await turn2.append({ role: "assistant", content: "C1", metadata: { logicalTurnId: "t2", providerRoundId: "r2" } });
    const storeC2 = await createSessionStore(root, "s", { parentUuid: user2.uuid });
    const c2 = await storeC2.append({ role: "assistant", content: "C2", metadata: { logicalTurnId: "t2c", providerRoundId: "r2c" } });

    // Marker keyed on the nested fork, as switchToCandidate writes it.
    await appendCandidateSelection(root, "s", { forkPointUuid: user2.uuid, selectedLeafUuid: c1.uuid });

    const controller = createTurnController(minimalControllerOptions(root, "s"));
    await controller.refreshCandidateSwitcher("s");
    const switcher = controller.candidateSwitcher();
    expect(switcher?.forkPointUuid).toBe(user2.uuid);
    expect(switcher?.leaves).toEqual([c1.uuid, c2.uuid]);
    expect(switcher?.index).toBe(0);
    expect(switcher?.total).toBe(2);
    void b1;
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
