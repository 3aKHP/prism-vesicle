import { describe, expect, test } from "bun:test";
import { turnAnchorsFromSnapshot } from "../../../src/tui/turn-anchors";
import type { SessionRecord } from "../../../src/core/session/record-model";

let sequence = 0;
function record(fields: {
  uuid: string;
  parentUuid: string | null;
  role: SessionRecord["role"];
  content: string;
  logicalTurnId?: string;
}): SessionRecord {
  sequence += 1;
  return {
    uuid: fields.uuid,
    parentUuid: fields.parentUuid,
    ts: new Date(2026, 0, 1, 0, 0, sequence).toISOString(),
    sessionId: "turn-anchors-test",
    role: fields.role,
    content: fields.content,
    ...(fields.logicalTurnId ? { metadata: { logicalTurnId: fields.logicalTurnId, providerRoundId: `${fields.logicalTurnId}-r` } } : {}),
  };
}

describe("turnAnchorsFromSnapshot", () => {
  test("one anchor per authored turn with prompt/reply ids and candidate awareness", () => {
    sequence = 0;
    const root = record({ uuid: "root", parentUuid: null, role: "system", content: "bootstrap" });
    const u1 = record({ uuid: "u1", parentUuid: "root", role: "user", content: "turn one", logicalTurnId: "t1" });
    const a1 = record({ uuid: "a1", parentUuid: "u1", role: "assistant", content: "reply A", logicalTurnId: "t1" });
    // Regenerated sibling candidate: shares the logical turn, hangs off u1.
    const a2 = record({ uuid: "a2", parentUuid: "u1", role: "assistant", content: "reply B", logicalTurnId: "t1" });
    const u2 = record({ uuid: "u2", parentUuid: "a2", role: "user", content: "turn two", logicalTurnId: "t2" });
    const b2 = record({ uuid: "b2", parentUuid: "u2", role: "assistant", content: "reply two", logicalTurnId: "t2" });

    // The active branch follows the physical tail (candidate B, then turn two).
    const anchors = turnAnchorsFromSnapshot([root, u1, a1, a2, u2, b2]);
    expect(anchors.map((anchor) => anchor.forkUuid)).toEqual(["u1", "u2"]);
    expect(anchors.map((anchor) => anchor.userMessageId)).toEqual(["u1", "u2"]);
    expect(anchors.map((anchor) => anchor.assistantMessageId)).toEqual(["a2", "b2"]);
    expect(anchors.map((anchor) => anchor.hasCandidates)).toEqual([true, false]);
  });

  test("legacy records without identity metadata still anchor at authored prompts", () => {
    sequence = 0;
    const root = record({ uuid: "root", parentUuid: null, role: "system", content: "bootstrap" });
    const u1 = record({ uuid: "u1", parentUuid: "root", role: "user", content: "turn one" });
    const a1 = record({ uuid: "a1", parentUuid: "u1", role: "assistant", content: "reply one" });
    const u2 = record({ uuid: "u2", parentUuid: "a1", role: "user", content: "turn two" });
    const a2 = record({ uuid: "a2", parentUuid: "u2", role: "assistant", content: "reply two" });

    const anchors = turnAnchorsFromSnapshot([root, u1, a1, u2, a2]);
    expect(anchors.map((anchor) => anchor.forkUuid)).toEqual(["u1", "u2"]);
    expect(anchors.every((anchor) => anchor.hasCandidates === false)).toBe(true);
  });

  test("host-injected user records do not create anchors", () => {
    sequence = 0;
    const root = record({ uuid: "root", parentUuid: null, role: "system", content: "bootstrap" });
    const u1 = record({ uuid: "u1", parentUuid: "root", role: "user", content: "turn one", logicalTurnId: "t1" });
    const a1 = record({ uuid: "a1", parentUuid: "u1", role: "assistant", content: "", logicalTurnId: "t1" });
    const gate = record({ uuid: "gate", parentUuid: "a1", role: "user", content: "approved", logicalTurnId: "t1" });
    gate.metadata = { ...gate.metadata, kind: "gate-resolution" };
    const a2 = record({ uuid: "a2", parentUuid: "gate", role: "assistant", content: "done", logicalTurnId: "t1" });

    const anchors = turnAnchorsFromSnapshot([root, u1, a1, gate, a2]);
    expect(anchors.map((anchor) => anchor.forkUuid)).toEqual(["u1"]);
    expect(anchors[0]?.assistantMessageId).toBe("a2");
  });
});
