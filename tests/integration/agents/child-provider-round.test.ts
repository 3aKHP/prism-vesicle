import { describe, expect, test } from "bun:test";
import { runChildProviderRound } from "../../../src/core/agents/child-provider-round";
import type { ProviderAdapter, ProviderStreamEvent, VesicleRequest } from "../../../src/providers/shared/types";

const request: VesicleRequest = {
  id: "child-session",
  model: { provider: "fixture", model: "fixture-model" },
  system: ["system"],
  messages: [{ role: "user", content: "write" }],
};

describe("SubAgent provider attempt commitment", () => {
  test("publishes only the successful retry after discarding a tool candidate", async () => {
    const call = { id: "call-child", name: "write_file", arguments: "{}" };
    const response = await runChildProviderRound(adapter(async function* () {
      yield { type: "attempt_started", attempt: 1 };
      yield { type: "tool_call_candidate", attempt: 1, toolCall: call };
      yield { type: "attempt_discarded", attempt: 1 };
      yield { type: "attempt_started", attempt: 2 };
      yield { type: "tool_call_candidate", attempt: 2, toolCall: call };
      yield { type: "complete", attempt: 2, response: { id: "child-success", content: "", toolCalls: [call] } };
    }), request, () => undefined);

    expect(response.id).toBe("child-success");
    expect(response.toolCalls).toEqual([call]);
  });

  test("rejects a late terminal event from a discarded attempt", async () => {
    const call = { id: "call-discarded", name: "write_file", arguments: "{}" };
    await expect(runChildProviderRound(adapter(async function* () {
      yield { type: "attempt_started", attempt: 1 };
      yield { type: "tool_call_candidate", attempt: 1, toolCall: call };
      yield { type: "attempt_discarded", attempt: 1 };
      yield { type: "complete", attempt: 1, response: { id: "child-late", content: "", toolCalls: [call] } };
    }), request, () => undefined)).rejects.toThrow(/without an active attempt transaction/);
  });

  test("publishes nothing when a discarded attempt ends before terminal completion", async () => {
    await expect(runChildProviderRound(adapter(async function* () {
      yield { type: "attempt_started", attempt: 1 };
      yield { type: "attempt_discarded", attempt: 1 };
    }), request, () => undefined)).rejects.toThrow(/ended without a final response/);
  });
});

function adapter(stream: () => AsyncIterable<ProviderStreamEvent>): ProviderAdapter {
  return {
    id: "child-attempt-fixture",
    complete: async () => { throw new Error("unexpected non-stream request"); },
    stream: async function* () {
      yield* stream();
    },
  };
}
