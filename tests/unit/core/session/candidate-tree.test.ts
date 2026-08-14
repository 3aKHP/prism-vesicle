import { describe, expect, test } from "bun:test";
import {
  buildCandidateTree,
  enumerateCandidateLeaves,
  listForkCandidates,
  ownerForkOfLeaf,
} from "../../../../src/core/session/selection";
import type { SessionRecord } from "../../../../src/core/session/record-model";

let sequence = 0;
function record(
  fields: { uuid: string; parentUuid: string | null; role: SessionRecord["role"]; content: string },
): SessionRecord {
  sequence += 1;
  return {
    uuid: fields.uuid,
    parentUuid: fields.parentUuid,
    ts: new Date(2026, 0, 1, 0, 0, sequence).toISOString(),
    sessionId: "candidate-tree-test",
    role: fields.role,
    content: fields.content,
  };
}

/**
 * The full binary tree from the research note: U1 forks into candidates A and
 * B; each continues one turn and forks again (A1/A2 under U2a, B1/B2 under
 * U2b). B2 is the physical tail, so the active branch is S-U1-B-U2b-B2.
 */
function buildSevenNodeTree() {
  sequence = 0;
  const s = record({ uuid: "s", parentUuid: null, role: "system", content: "bootstrap" });
  const u1 = record({ uuid: "u1", parentUuid: "s", role: "user", content: "outline proposal" });
  const a = record({ uuid: "a", parentUuid: "u1", role: "assistant", content: "three-act structure" });
  const u2a = record({ uuid: "u2a", parentUuid: "a", role: "user", content: "rewrite character card" });
  const a1 = record({ uuid: "a1", parentUuid: "u2a", role: "assistant", content: "cold version" });
  const a2 = record({ uuid: "a2", parentUuid: "u2a", role: "assistant", content: "warm version" });
  const b = record({ uuid: "b", parentUuid: "u1", role: "assistant", content: "dual-line narrative" });
  const u2b = record({ uuid: "u2b", parentUuid: "b", role: "user", content: "expand the conflict" });
  const b1 = record({ uuid: "b1", parentUuid: "u2b", role: "assistant", content: "internal conflict" });
  const b2 = record({ uuid: "b2", parentUuid: "u2b", role: "assistant", content: "external conflict" });
  return { records: [s, u1, a, u2a, a1, a2, b, u2b, b1, b2], u1, u2a, u2b, a, b, a2, b2 };
}

describe("candidate tree primitives", () => {
  test("buildCandidateTree exposes every fork at every depth, including inactive subtrees", () => {
    const { records } = buildSevenNodeTree();
    const tree = buildCandidateTree(records);
    expect(tree).toHaveLength(1);

    const top = tree[0]!;
    expect(top.forkRecordUuid).toBe("u1");
    expect(top.forkExcerpt).toBe("outline proposal");
    expect(top.activePath).toBe(true);
    expect(top.candidates.map((candidate) => candidate.rootUuid)).toEqual(["a", "b"]);

    const [branchA, branchB] = top.candidates;
    expect(branchA!.activePath).toBe(false);
    expect(branchA!.excerpt).toBe("three-act structure");
    expect(branchA!.authoredTurnCount).toBe(1);
    // Display endpoints stay in scope: a top-level branch row ends at its own
    // reply; the deeper candidates live in the nested fork, not in the row.
    expect(branchA!.endpointUuid).toBe("a");
    expect(branchB!.activePath).toBe(true);
    expect(branchB!.authoredTurnCount).toBe(1);
    expect(branchB!.endpointUuid).toBe("b");

    const nestedA = branchA!.fork;
    expect(nestedA?.forkRecordUuid).toBe("u2a");
    expect(nestedA?.candidates.map((candidate) => candidate.rootUuid)).toEqual(["a1", "a2"]);
    expect(nestedA?.candidates.every((candidate) => candidate.fork === undefined)).toBe(true);

    const nestedB = branchB!.fork;
    expect(nestedB?.forkRecordUuid).toBe("u2b");
    expect(nestedB?.candidates.map((candidate) => candidate.rootUuid)).toEqual(["b1", "b2"]);
    expect(nestedB?.candidates.find((candidate) => candidate.rootUuid === "b2")?.activePath).toBe(true);
  });

  test("buildCandidateTree exposes vertical rewind forks at assistant records", () => {
    sequence = 0;
    const s = record({ uuid: "s", parentUuid: null, role: "system", content: "bootstrap" });
    const u1 = record({ uuid: "u1", parentUuid: "s", role: "user", content: "first prompt" });
    const a = record({ uuid: "a", parentUuid: "u1", role: "assistant", content: "first reply" });
    // A /rewind fork: two different follow-up prompts hang off the reply.
    const u2 = record({ uuid: "u2", parentUuid: "a", role: "user", content: "direction one" });
    const u2Alt = record({ uuid: "u2-alt", parentUuid: "a", role: "user", content: "direction two" });
    const reply = record({ uuid: "reply", parentUuid: "u2-alt", role: "assistant", content: "alt reply" });

    const tree = buildCandidateTree([s, u1, a, u2, u2Alt, reply]);
    expect(tree).toHaveLength(1);
    const fork = tree[0]!;
    expect(fork.forkRecordUuid).toBe("a");
    expect(fork.candidates.map((candidate) => candidate.rootUuid)).toEqual(["u2", "u2-alt"]);
    // Branches rooted at user records excerpt their own prompt.
    expect(fork.candidates.map((candidate) => candidate.excerpt)).toEqual(["direction one", "direction two"]);
    expect(fork.candidates[1]!.activePath).toBe(true);
  });

  test("listForkCandidates exposes per-candidate endpoints without flattening siblings into one", () => {
    const { records, u1 } = buildSevenNodeTree();
    const candidates = listForkCandidates(records, u1.uuid);
    expect(candidates.map((candidate) => candidate.rootUuid)).toEqual(["a", "b"]);
    // Endpoints are the subtree leaves (endpoint-ledger semantics): A's branch
    // ends at its deepest continuation A2, not at A itself.
    expect(candidates.map((candidate) => candidate.endpointUuid)).toEqual(["a2", "b2"]);
    expect(candidates.map((candidate) => candidate.replyUuid)).toEqual(["a", "b"]);
    expect(candidates.map((candidate) => candidate.authoredTurnCount)).toEqual([1, 1]);
  });

  test("enumerateCandidateLeaves keeps its endpoint-ledger flattening for switcher arithmetic", () => {
    const { records, u1, u2b } = buildSevenNodeTree();
    expect(enumerateCandidateLeaves(records, u1.uuid).map((leaf) => leaf.uuid)).toEqual(["a2", "b2"]);
    expect(enumerateCandidateLeaves(records, u2b.uuid).map((leaf) => leaf.uuid)).toEqual(["b1", "b2"]);
  });

  test("ownerForkOfLeaf resolves the nearest authored user prompt above any leaf", () => {
    const { records } = buildSevenNodeTree();
    expect(ownerForkOfLeaf(records, "a1")).toBe("u2a");
    expect(ownerForkOfLeaf(records, "a2")).toBe("u2a");
    expect(ownerForkOfLeaf(records, "b2")).toBe("u2b");
    expect(ownerForkOfLeaf(records, "a")).toBe("u1");
    expect(ownerForkOfLeaf(records, "u1")).toBe("u1");
    expect(ownerForkOfLeaf(records, "s")).toBeUndefined();
    expect(ownerForkOfLeaf(records, "missing")).toBeUndefined();
  });

  test("host-injected user records are neither forks nor authored turns", () => {
    sequence = 0;
    const s = record({ uuid: "s", parentUuid: null, role: "system", content: "bootstrap" });
    const u1 = record({ uuid: "u1", parentUuid: "s", role: "user", content: "prompt" });
    const a = record({ uuid: "a", parentUuid: "u1", role: "assistant", content: "reply" });
    const injected = record({ uuid: "inj", parentUuid: "a", role: "user", content: "gate resolution" });
    injected.metadata = { kind: "gate-resolution" };
    const tail = record({ uuid: "tail", parentUuid: "inj", role: "assistant", content: "continued" });

    // Single content-child chains with host-injected records produce no forks.
    expect(buildCandidateTree([s, u1, a, injected, tail])).toEqual([]);
    expect(ownerForkOfLeaf([s, u1, a, injected, tail], "tail")).toBe("u1");
  });

  test("continuations chain through selection markers and endpoints never leak across branches", () => {
    sequence = 0;
    const s = record({ uuid: "s", parentUuid: null, role: "system", content: "bootstrap" });
    const u1 = record({ uuid: "u1", parentUuid: "s", role: "user", content: "turn one" });
    const a1 = record({ uuid: "a1", parentUuid: "u1", role: "assistant", content: "reply one A" });
    const a2 = record({ uuid: "a2", parentUuid: "u1", role: "assistant", content: "reply one B" });
    // a2 is selected; its continuation chains OFF the selection marker.
    const marker = record({ uuid: "marker", parentUuid: "a2", role: "system", content: "" });
    marker.metadata = { kind: "candidate-selection", forkPointUuid: "u1", selectedLeafUuid: "a2" };
    const u2 = record({ uuid: "u2", parentUuid: "marker", role: "user", content: "turn two" });
    const b1 = record({ uuid: "b1", parentUuid: "u2", role: "assistant", content: "reply two A" });
    const b2 = record({ uuid: "b2", parentUuid: "u2", role: "assistant", content: "reply two B" });

    const tree = buildCandidateTree([s, u1, a1, a2, marker, u2, b1, b2]);
    expect(tree).toHaveLength(1);
    const top = tree[0]!;
    expect(top.forkRecordUuid).toBe("u1");
    expect(top.candidates.map((candidate) => candidate.rootUuid)).toEqual(["a1", "a2"]);
    // Endpoints stay in scope: a2's row ends at its own reply, and a1 does
    // not absorb anything from a2's continuation.
    expect(top.candidates.map((candidate) => candidate.endpointUuid)).toEqual(["a1", "a2"]);
    expect(top.candidates[0]!.fork).toBeUndefined();
    // The marker-chained continuation surfaces as a2's nested fork.
    const nested = top.candidates[1]!.fork;
    expect(nested?.forkRecordUuid).toBe("u2");
    expect(nested?.candidates.map((candidate) => candidate.endpointUuid)).toEqual(["b1", "b2"]);
  });
});
