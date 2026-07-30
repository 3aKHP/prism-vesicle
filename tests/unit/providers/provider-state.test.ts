import { describe, expect, test } from "bun:test";
import {
  maxProviderStateEnvelopeBytes,
  parseProviderStateEnvelope,
  type ProviderStateEnvelope,
} from "../../../src/providers/shared/state";
import { ProviderAttemptCommitBarrier } from "../../../src/providers/shared/attempt-commit";
import { qualityDecisionCandidate } from "../../../src/core/agent-loop/quality-round-state";

function state(payload: ProviderStateEnvelope["payload"] = { outputItems: [{ type: "reasoning", encrypted: "fixture" }] }): ProviderStateEnvelope {
  return {
    version: 1,
    protocol: "fixture-responses",
    providerId: "fixture-provider",
    model: "fixture-model",
    endpointFingerprint: "sha256:fixture-endpoint",
    payload,
  };
}

describe("provider-neutral durable state", () => {
  test("validates, bounds, and deeply clones an owner-qualified JSON envelope", () => {
    const source = state();
    const parsed = parseProviderStateEnvelope(source);
    expect(parsed).toEqual(source);
    expect(parsed).not.toBe(source);
    expect(parsed.payload).not.toBe(source.payload);

    (source.payload as { outputItems: Array<{ encrypted: string }> }).outputItems[0]!.encrypted = "mutated";
    expect(parsed.payload).toEqual({ outputItems: [{ type: "reasoning", encrypted: "fixture" }] });
  });

  test("fails closed on unknown versions, non-JSON payloads, cycles, and oversize state", () => {
    expect(() => parseProviderStateEnvelope({ ...state(), version: 2 })).toThrow(/version 2 is not supported/);
    expect(() => parseProviderStateEnvelope({ ...state(), payload: { date: new Date() } })).toThrow(/not JSON-safe/);
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => parseProviderStateEnvelope({ ...state(), payload: cyclic })).toThrow(/not JSON-safe/);
    expect(() => parseProviderStateEnvelope(state("x".repeat(maxProviderStateEnvelopeBytes)))).toThrow(/durable-state limit/);
  });

  test("clones state into a durable Quality candidate", () => {
    const source = state();
    const candidate = qualityDecisionCandidate({ id: "quality-response", content: "draft", providerState: source });
    expect(candidate.providerState).toEqual(source);
    expect(candidate.providerState).not.toBe(source);
    expect(candidate.providerState?.payload).not.toBe(source.payload);
  });
});

describe("provider attempt commit barrier", () => {
  test("discards failed-attempt candidates and publishes only the completed attempt", () => {
    const barrier = new ProviderAttemptCommitBarrier();
    const call = { id: "call-once", name: "write_file", arguments: "{}" };
    barrier.start(1);
    barrier.addCandidate(1, call);
    barrier.discard(1);
    barrier.start(2);
    barrier.addCandidate(2, call);
    const responseCalls = [call];
    const committed = barrier.commit({ id: "response-2", content: "", toolCalls: responseCalls, providerState: state() }, 2);

    expect(committed.toolCalls).toEqual([call]);
    expect(committed.toolCalls).not.toBe(responseCalls);
    expect(committed.providerState).toEqual(state());
  });

  test("rejects a terminal response that disagrees with its pending tool candidates", () => {
    const barrier = new ProviderAttemptCommitBarrier();
    barrier.start(1);
    barrier.addCandidate(1, { id: "call-a", name: "read_file", arguments: "{}" });
    expect(() => barrier.commit({
      id: "response-bad",
      content: "",
      toolCalls: [{ id: "call-b", name: "read_file", arguments: "{}" }],
    }, 1)).toThrow(/do not match/);
  });

  test("requires one explicitly discarded attempt before another can start", () => {
    const barrier = new ProviderAttemptCommitBarrier();
    barrier.start(1);
    expect(() => barrier.start(2)).toThrow(/already pending/);
    barrier.discard(1);
    expect(() => barrier.start(1)).toThrow(/already started/);
    barrier.start(2);
  });

  test("cannot bypass a pending attempt by omitting its terminal identity", () => {
    const barrier = new ProviderAttemptCommitBarrier();
    barrier.start(1);
    expect(() => barrier.commit({ id: "response", content: "" })).toThrow(/must identify/);
    expect(() => barrier.discard(2)).toThrow(/not pending/);
  });
});
