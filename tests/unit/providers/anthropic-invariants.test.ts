import { describe, expect, test } from "bun:test";
import { validateAnthropicHistory } from "../../../src/providers/anthropic-messages/invariants";
import { PROVIDER_NATIVE_CHECKPOINT_KIND, type VesicleMessage } from "../../../src/providers/shared/types";

function userMessage(content = "please look"): VesicleMessage {
  return { role: "user", content };
}

function assistantText(content = "done"): VesicleMessage {
  return { role: "assistant", content };
}

function assistantWithCalls(...calls: Array<{ id: string; name?: string }>): VesicleMessage {
  return {
    role: "assistant",
    content: "",
    toolCalls: calls.map((call) => ({ id: call.id, name: call.name ?? "grep", arguments: "{}" })),
  };
}

function toolMessage(toolCallId: string, extra: Partial<VesicleMessage> = {}): VesicleMessage {
  return { role: "tool", content: "match found", toolCallId, ...extra };
}

function checkpointMarker(): VesicleMessage {
  return { role: "user", content: "", kind: PROVIDER_NATIVE_CHECKPOINT_KIND };
}

describe("validateAnthropicHistory", () => {
  test("accepts empty histories and histories without tool activity", () => {
    expect(validateAnthropicHistory([])).toEqual([]);
    expect(validateAnthropicHistory([userMessage(), assistantText(), userMessage("more")])).toEqual([]);
  });

  test("accepts tool calls answered exactly once before the next turn", () => {
    const history = [
      userMessage(),
      assistantWithCalls({ id: "call_a" }, { id: "call_b" }),
      toolMessage("call_a"),
      toolMessage("call_b"),
      userMessage("thanks"),
      assistantWithCalls({ id: "call_c" }),
      toolMessage("call_c"),
      assistantText("all set"),
    ];
    expect(validateAnthropicHistory(history)).toEqual([]);
  });

  test("accepts tool results carrying images and an error flag", () => {
    const history = [
      userMessage(),
      assistantWithCalls({ id: "call_a" }),
      toolMessage("call_a", {
        toolOk: false,
        images: [{ id: "img_1", path: "/tmp/shot.png", mediaType: "image/png", bytes: 4, sha256: "deadbeef", source: "project", data: "aGk=" }],
      }),
      userMessage("retry"),
    ];
    expect(validateAnthropicHistory(history)).toEqual([]);
  });

  test("ignores system records and checkpoint markers the serializer skips", () => {
    const history: VesicleMessage[] = [
      userMessage(),
      { role: "system", content: "env" },
      assistantWithCalls({ id: "call_a" }),
      { role: "system", content: "mid-run host record" },
      checkpointMarker(),
      toolMessage("call_a"),
      userMessage("continue"),
    ];
    expect(validateAnthropicHistory(history)).toEqual([]);
  });

  test("reports a conversation that would open with a non-user message", () => {
    const history: VesicleMessage[] = [
      { role: "system", content: "host-only" },
      assistantText("hi"),
      userMessage("hello?"),
    ];
    const violations = validateAnthropicHistory(history);
    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain("first serialized message");
    expect(violations[0]).toContain("assistant");
  });

  test("reports unanswered tool calls at the turn boundary that closes the run", () => {
    const history = [userMessage(), assistantWithCalls({ id: "call_a" }, { id: "call_b" }), toolMessage("call_a"), userMessage("partial?")];
    expect(validateAnthropicHistory(history)).toEqual([
      'messages[1] assistant tool call "call_b" is not answered by a tool result before the next turn at messages[3].',
    ]);
  });

  test("reports unanswered tool calls at the end of the history", () => {
    const history = [userMessage(), assistantWithCalls({ id: "call_a" })];
    expect(validateAnthropicHistory(history)).toEqual([
      'messages[1] assistant tool call "call_a" is not answered by a tool result before the end of the history.',
    ]);
  });

  test("reports tool results that answer no pending tool call", () => {
    const history = [userMessage(), toolMessage("call_ghost")];
    expect(validateAnthropicHistory(history)).toEqual([
      'messages[1] tool result "call_ghost" does not answer any pending tool call from the preceding assistant turn.',
    ]);
  });

  test("reports a tool result that arrives after its run already closed", () => {
    const history = [userMessage(), assistantWithCalls({ id: "call_a" }, { id: "call_b" }), toolMessage("call_a"), userMessage("and?"), toolMessage("call_b")];
    expect(validateAnthropicHistory(history)).toEqual([
      'messages[1] assistant tool call "call_b" is not answered by a tool result before the next turn at messages[3].',
      'messages[4] tool result "call_b" does not answer any pending tool call from the preceding assistant turn.',
    ]);
  });

  test("reports duplicate tool results for one call", () => {
    const history = [userMessage(), assistantWithCalls({ id: "call_a" }), toolMessage("call_a"), toolMessage("call_a"), userMessage("thanks")];
    expect(validateAnthropicHistory(history)).toEqual([
      'messages[3] tool result "call_a" answers a tool call that already received its tool result.',
    ]);
  });

  test("reports tool results whose toolCallId is missing or empty", () => {
    const missingId: VesicleMessage = { role: "tool", content: "match found" };
    const history = [userMessage(), assistantWithCalls({ id: "call_a" }), missingId, toolMessage(""), toolMessage("call_a")];
    expect(validateAnthropicHistory(history)).toEqual([
      'messages[2] tool result has an empty toolCallId, which would serialize as tool_use_id "".',
      'messages[3] tool result has an empty toolCallId, which would serialize as tool_use_id "".',
    ]);
  });

  test("reports assistant tool calls whose id is empty", () => {
    const history: VesicleMessage[] = [
      userMessage(),
      { role: "assistant", content: "", toolCalls: [{ id: "", name: "grep", arguments: "{}" }] },
      userMessage("hello?"),
    ];
    expect(validateAnthropicHistory(history)).toEqual([
      'messages[1] assistant tool call #1 ("grep") has an empty id, which would serialize as a tool_use id "".',
    ]);
  });

  test("does not mutate the input history", () => {
    const history = [userMessage(), assistantWithCalls({ id: "call_a" }), toolMessage("call_a"), userMessage("thanks")];
    const before = structuredClone(history);
    validateAnthropicHistory(history);
    expect(history).toEqual(before);
  });
});
