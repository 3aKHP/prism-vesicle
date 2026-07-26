import { describe, expect, test } from "bun:test";
import { segmentSession } from "../../../src/core/session/store";
import type { SessionRecord } from "../../../src/core/session/record-model";

function record(role: SessionRecord["role"], metadata: Record<string, unknown> = {}, content = ""): SessionRecord {
  return { uuid: crypto.randomUUID(), parentUuid: null, ts: "2026-07-26T00:00:00Z", sessionId: "s", role, content, metadata };
}

function systemRoot(): SessionRecord {
  return record("system", { engine: "etl", assets: { sha256: "a" } }, "composed prompt");
}

describe("session segmentation", () => {
  test("multiple identity-stamped Agent Loops segment independently", () => {
    const records = [
      systemRoot(),
      record("user", { logicalTurnId: "t1", providerRoundId: "r1" }, "first"),
      record("assistant", { logicalTurnId: "t1", providerRoundId: "r1" }, "reply one"),
      record("user", { logicalTurnId: "t2", providerRoundId: "r2" }, "second"),
      record("assistant", { logicalTurnId: "t2", providerRoundId: "r2" }, "reply two"),
    ];
    const segmentation = segmentSession(records);
    expect(segmentation.inferred).toBe(false);
    expect(segmentation.turns.map((turn) => turn.logicalTurnId)).toEqual(["t1", "t2"]);
    expect(segmentation.frontier).toBeUndefined();
    expect(segmentation.turns.every((turn) => turn.complete)).toBe(true);
  });

  test("one parallel tool batch is a single indivisible provider round", () => {
    const records = [
      systemRoot(),
      record("user", { logicalTurnId: "t1", providerRoundId: "r1" }, "do two things"),
      record("assistant", { logicalTurnId: "t1", providerRoundId: "r1", toolCalls: [{ id: "c1" }, { id: "c2" }] }, ""),
      record("tool", { logicalTurnId: "t1", providerRoundId: "r1", toolCallId: "c1" }, '{"ok":true}'),
      record("tool", { logicalTurnId: "t1", providerRoundId: "r1", toolCallId: "c2" }, '{"ok":true}'),
    ];
    const segmentation = segmentSession(records);
    expect(segmentation.turns).toHaveLength(1);
    const turn = segmentation.turns[0]!;
    expect(turn.rounds).toHaveLength(1);
    expect(turn.rounds[0]!.complete).toBe(true);
    expect(turn.rounds[0]!.records.map((entry) => entry.role)).toEqual(["user", "assistant", "tool", "tool"]);
  });

  test("a round missing a tool result is incomplete and stays the retained frontier", () => {
    const records = [
      systemRoot(),
      record("user", { logicalTurnId: "t1", providerRoundId: "r1" }, "do a thing"),
      record("assistant", { logicalTurnId: "t1", providerRoundId: "r1", toolCalls: [{ id: "c1" }, { id: "c2" }] }, ""),
      record("tool", { logicalTurnId: "t1", providerRoundId: "r1", toolCallId: "c1" }, '{"ok":true}'),
    ];
    const segmentation = segmentSession(records);
    expect(segmentation.turns).toHaveLength(0);
    expect(segmentation.frontier?.logicalTurnId).toBe("t1");
    expect(segmentation.frontier?.rounds[0]?.complete).toBe(false);
  });

  test("legacy records segment conservatively at authored prompts", () => {
    const records = [
      systemRoot(),
      record("user", {}, "first"),
      record("assistant", { toolCalls: [{ id: "c1" }] }, "reply one"),
      record("tool", { toolCallId: "c1" }, '{"ok":true}'),
      record("user", { kind: "gate-resolution" }, "[gate] resolved"),
      record("user", {}, "second"),
      record("assistant", {}, "reply two"),
    ];
    const segmentation = segmentSession(records);
    expect(segmentation.inferred).toBe(true);
    // The host-injected gate-resolution does not start a new turn.
    expect(segmentation.turns.map((turn) => turn.records[0]!.content)).toEqual(["first", "second"]);
    expect(segmentation.turns.every((turn) => turn.inferred)).toBe(true);
  });

  test("legacy ambiguity retains an incomplete suffix verbatim as the frontier", () => {
    const records = [
      systemRoot(),
      record("user", {}, "first"),
      record("assistant", {}, "reply one"),
      // A trailing user prompt with no assistant reply cannot be split safely.
      record("user", {}, "second"),
    ];
    const segmentation = segmentSession(records);
    expect(segmentation.turns.map((turn) => turn.records[0]!.content)).toEqual(["first"]);
    expect(segmentation.frontier?.records.map((entry) => entry.content)).toEqual(["second"]);
    expect(segmentation.frontier?.complete).toBe(false);
  });

  test("the bootstrap composed-prompt root is not part of any turn", () => {
    const records = [
      systemRoot(),
      record("user", { logicalTurnId: "t1", providerRoundId: "r1" }, "first"),
      record("assistant", { logicalTurnId: "t1", providerRoundId: "r1" }, "reply"),
    ];
    const segmentation = segmentSession(records);
    expect(segmentation.bootstrap.map((entry) => entry.role)).toEqual(["system"]);
    expect(segmentation.turns[0]!.records.every((entry) => entry.role !== "system" || entry.metadata?.kind === "validation")).toBe(true);
  });
});
