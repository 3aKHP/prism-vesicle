import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { createSessionStore, loadSessionRecords, loadSessionSnapshot, projectSessionHistory } from "../../../src/core/session/store";
import { recoverSessionInteractions } from "../../../src/core/session/interaction-recovery";
import {
  appendCandidateSelection,
  CANDIDATE_SELECTION_KIND,
  enumerateCandidateLeaves,
  findLatestSelection,
} from "../../../src/core/session/selection";

async function twoCandidateSession(rootDir: string): Promise<{ userUuid: string; leafA1: string; leafA2: string }> {
  const store = await createSessionStore(rootDir, "cand-sel");
  await store.append({ role: "system", content: "prompt", metadata: { engine: "etl" } });
  const userA = await store.append({
    role: "user",
    content: "the prompt",
    metadata: { logicalTurnId: "t1", providerRoundId: "r1" },
  });
  // Candidate A1 (the first turn's leaf).
  const asstA1 = await store.append({
    role: "assistant",
    content: "A1",
    metadata: { logicalTurnId: "t1", providerRoundId: "r1" },
  });
  // Candidate A2: a sibling subtree off the shared user record. It carries an
  // unanswered request_confirmation so interaction recovery has something to
  // (not) surface depending on which candidate is active.
  const forked = await createSessionStore(rootDir, "cand-sel", { parentUuid: userA.uuid });
  const asstA2 = await forked.append({
    role: "assistant",
    content: "A2",
    metadata: {
      logicalTurnId: "t2",
      providerRoundId: "r2",
      toolCalls: [{ id: "call-gate", name: "request_confirmation", arguments: JSON.stringify({ gate: "runtime-turn", summary: "x" }) }],
    },
  });
  return { userUuid: userA.uuid, leafA1: asstA1.uuid, leafA2: asstA2.uuid };
}

describe("session: horizontal candidate selection", () => {
  test("enumerates sibling candidate leaves off the shared fork point", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "vesicle-candsel-"));
    const { userUuid, leafA1, leafA2 } = await twoCandidateSession(rootDir);
    const records = await loadSessionRecords(rootDir, "cand-sel");
    const leaves = enumerateCandidateLeaves(records, userUuid).map((record) => record.uuid);
    expect(leaves).toEqual([leafA1, leafA2]);
  });

  test("the newest candidate is the default active branch until a selection is made", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "vesicle-candsel-"));
    const { leafA1, leafA2 } = await twoCandidateSession(rootDir);
    const snapshot = await loadSessionSnapshot(rootDir, "cand-sel");
    // Physical tail is candidate A2, so the default branch walks to A2 and
    // excludes the A1 sibling entirely.
    expect(snapshot.headUuid).toBe(leafA2);
    const contents = snapshot.messages.map((message) => message.content).join("\n");
    expect(contents).toContain("A2");
    expect(contents).not.toContain("A1");
    void leafA1;
  });

  test("a selection marker repoints the default branch to the selected candidate and is invisible to projection", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "vesicle-candsel-"));
    const { userUuid, leafA1 } = await twoCandidateSession(rootDir);
    const before = await loadSessionRecords(rootDir, "cand-sel");

    const marker = await appendCandidateSelection(rootDir, "cand-sel", { forkPointUuid: userUuid, selectedLeafUuid: leafA1 });

    // Append-only: the marker is one new record; nothing was mutated.
    const after = await loadSessionRecords(rootDir, "cand-sel");
    expect(after.length).toBe(before.length + 1);
    expect(after.some((record) => record.uuid === marker.uuid)).toBe(true);
    expect(after.some((record) => record.metadata?.kind === CANDIDATE_SELECTION_KIND)).toBe(true);

    // The default branch now walks through the marker to candidate A1.
    const snapshot = await loadSessionSnapshot(rootDir, "cand-sel");
    const contents = snapshot.messages.map((message) => message.content).join("\n");
    expect(contents).toContain("A1");
    expect(contents).not.toContain("A2");

    // The marker is role:system and never reaches the provider message list.
    const projected = projectSessionHistory(after).messages.map((message) => message.content).join("\n");
    expect(projected).not.toContain("candidate-selection");

    // The active-candidate oracle reports A1.
    expect(findLatestSelection(after)).toEqual({ forkPointUuid: userUuid, selectedLeafUuid: leafA1 });
  });

  test("selecting a candidate scopes interaction recovery to that candidate's branch", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "vesicle-candsel-"));
    const { userUuid, leafA1 } = await twoCandidateSession(rootDir);

    // Before selection, candidate A2 (the default) carries an unanswered gate,
    // so recovery surfaces a pending gate.
    const beforeSelection = await loadSessionSnapshot(rootDir, "cand-sel");
    expect(beforeSelection.pendingGate).toBeDefined();

    await appendCandidateSelection(rootDir, "cand-sel", { forkPointUuid: userUuid, selectedLeafUuid: leafA1 });

    // After selecting A1, the active branch's trailing assistant is A1 (no gate),
    // so the pending gate on the A2 sibling is no longer surfaced. This is the
    // Option-X scoping benefit: recovery runs over the selected branch only.
    const afterSelection = await loadSessionSnapshot(rootDir, "cand-sel");
    expect(afterSelection.pendingGate).toBeUndefined();

    // The raw recovery over the selected branch agrees.
    const selectedBranchRecovery = recoverSessionInteractions(afterSelection.records);
    expect(selectedBranchRecovery.pendingGate).toBeUndefined();
  });

  test("appendCandidateSelection rejects a leaf that is not in the session", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "vesicle-candsel-"));
    const { userUuid } = await twoCandidateSession(rootDir);
    await expect(
      appendCandidateSelection(rootDir, "cand-sel", { forkPointUuid: userUuid, selectedLeafUuid: "not-a-real-uuid" }),
    ).rejects.toThrow(/not in session/);
  });
});
