import { describe, expect, test } from "bun:test";
import { validateOpenAIChatHistory } from "../../../src/providers/openai-chat/invariants";
import { PROVIDER_NATIVE_CHECKPOINT_KIND, type VesicleMessage } from "../../../src/providers/shared/types";

describe("openai-chat history invariants", () => {
  test("empty history is valid", () => {
    expect(validateOpenAIChatHistory([])).toEqual([]);
  });

  test("conversation without tool activity is valid", () => {
    const history: VesicleMessage[] = [
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi", reasoningContent: "internal thought" },
      { role: "user", content: "bye" },
    ];
    expect(validateOpenAIChatHistory(history)).toEqual([]);
  });

  test("multi-round tool use with batched tool-result images is valid", () => {
    const history: VesicleMessage[] = [
      { role: "user", content: "inspect both files" },
      {
        role: "assistant",
        content: "",
        toolCalls: [
          { id: "call-1", name: "read_file", arguments: '{"path":"a"}' },
          { id: "call-2", name: "read_file", arguments: '{"path":"b"}' },
        ],
      },
      { role: "tool", toolCallId: "call-1", content: "body a" },
      {
        role: "tool",
        toolCallId: "call-2",
        content: "body b",
        images: [
          {
            id: "img-1",
            path: "/tmp/img-1.png",
            mediaType: "image/png",
            bytes: 4,
            sha256: "0000",
            source: "mcp",
            data: "AAAA",
          },
        ],
      },
      { role: "assistant", content: "done with both" },
      { role: "user", content: "again" },
      { role: "assistant", content: "", toolCalls: [{ id: "call-3", name: "grep", arguments: "{}" }] },
      { role: "tool", toolCallId: "call-3", content: "matches" },
    ];
    expect(validateOpenAIChatHistory(history)).toEqual([]);
  });

  test("a provider-native checkpoint marker between a carrier and its results is valid", () => {
    const history: VesicleMessage[] = [
      { role: "assistant", content: "", toolCalls: [{ id: "call-1", name: "run", arguments: "{}" }] },
      { role: "user", content: "", kind: PROVIDER_NATIVE_CHECKPOINT_KIND },
      { role: "tool", toolCallId: "call-1", content: "ok" },
    ];
    expect(validateOpenAIChatHistory(history)).toEqual([]);
  });

  test("an interposed non-tool message breaks the required result adjacency", () => {
    const history: VesicleMessage[] = [
      { role: "assistant", content: "", toolCalls: [{ id: "call-1", name: "run", arguments: "{}" }] },
      { role: "assistant", content: "interjected text turn" },
      { role: "tool", toolCallId: "call-1", content: "ok" },
    ];
    const violations = validateOpenAIChatHistory(history);
    expect(violations).toHaveLength(2);
    expect(violations[0]).toContain("no tool result before");
    expect(violations[1]).toContain("with no preceding assistant tool-call message");
  });

  test("call ids may repeat across carrier segments (backend-minted call_0 ids)", () => {
    const history: VesicleMessage[] = [
      { role: "user", content: "go" },
      { role: "assistant", content: "", toolCalls: [{ id: "call_0", name: "run", arguments: "{}" }] },
      { role: "tool", toolCallId: "call_0", content: "first round" },
      { role: "assistant", content: "", toolCalls: [{ id: "call_0", name: "run", arguments: "{}" }] },
      { role: "tool", toolCallId: "call_0", content: "second round" },
    ];
    expect(validateOpenAIChatHistory(history)).toEqual([]);
  });

  test("a tool call left unanswered when the turn moves on is blocking", () => {
    const history: VesicleMessage[] = [
      {
        role: "assistant",
        content: "",
        toolCalls: [
          { id: "call-1", name: "run", arguments: "{}" },
          { id: "call-2", name: "run", arguments: "{}" },
        ],
      },
      { role: "tool", toolCallId: "call-1", content: "ok" },
      { role: "user", content: "never mind the second one" },
    ];
    const violations = validateOpenAIChatHistory(history);
    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain("no tool result before");
    expect(violations[0]).toContain("'call-2'");
  });

  test("a tool call unanswered at the end of the history is blocking", () => {
    const history: VesicleMessage[] = [
      { role: "user", content: "go" },
      { role: "assistant", content: "", toolCalls: [{ id: "call-1", name: "run", arguments: "{}" }] },
    ];
    const violations = validateOpenAIChatHistory(history);
    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain("the end of the history");
  });

  test("tool result answering an id the active carrier did not declare is blocking", () => {
    const history: VesicleMessage[] = [
      { role: "assistant", content: "", toolCalls: [{ id: "call-1", name: "run", arguments: "{}" }] },
      { role: "tool", toolCallId: "call-9", content: "?" },
    ];
    const violations = validateOpenAIChatHistory(history);
    expect(violations).toHaveLength(2);
    expect(violations[0]).toContain("message 1");
    expect(violations[0]).toContain("call-9");
    expect(violations[0]).toContain("message 0");
    expect(violations[1]).toContain("no tool result before the end of the history");
  });

  test("tool result before any assistant tool-call message is blocking", () => {
    const history: VesicleMessage[] = [
      { role: "user", content: "go" },
      { role: "tool", toolCallId: "call-1", content: "?" },
    ];
    const violations = validateOpenAIChatHistory(history);
    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain("message 1");
    expect(violations[0]).toContain("call-1");
    expect(violations[0]).toContain("no preceding assistant tool-call message");
  });

  test("answering one toolCallId twice within a carrier is blocking", () => {
    const history: VesicleMessage[] = [
      { role: "assistant", content: "", toolCalls: [{ id: "call-1", name: "run", arguments: "{}" }] },
      { role: "tool", toolCallId: "call-1", content: "first" },
      { role: "tool", toolCallId: "call-1", content: "second" },
    ];
    const violations = validateOpenAIChatHistory(history);
    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain("message 2");
    expect(violations[0]).toContain("call-1");
    expect(violations[0]).toContain("does not have unanswered");
  });

  test("a stale result replayed after a later carrier is blocking", () => {
    const history: VesicleMessage[] = [
      { role: "assistant", content: "", toolCalls: [{ id: "call-1", name: "run", arguments: "{}" }] },
      { role: "tool", toolCallId: "call-1", content: "first" },
      { role: "assistant", content: "", toolCalls: [{ id: "call-2", name: "run", arguments: "{}" }] },
      { role: "tool", toolCallId: "call-2", content: "second" },
      { role: "tool", toolCallId: "call-1", content: "stale replay" },
    ];
    const violations = validateOpenAIChatHistory(history);
    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain("message 4");
    expect(violations[0]).toContain("call-1");
    expect(violations[0]).toContain("does not have unanswered");
  });

  test("assistant tool call with an empty id is blocking", () => {
    const history: VesicleMessage[] = [
      { role: "assistant", content: "", toolCalls: [{ id: "", name: "read_file", arguments: "{}" }] },
    ];
    const violations = validateOpenAIChatHistory(history);
    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain("message 0");
    expect(violations[0]).toContain("read_file");
  });

  test("tool result without a toolCallId is blocking", () => {
    const history: VesicleMessage[] = [
      { role: "assistant", content: "", toolCalls: [{ id: "call-1", name: "run", arguments: "{}" }] },
      { role: "tool", content: "orphaned" },
    ];
    const violations = validateOpenAIChatHistory(history);
    expect(violations).toHaveLength(2);
    expect(violations[0]).toContain("message 1");
    expect(violations[0]).toContain("toolCallId");
    expect(violations[1]).toContain("no tool result before the end of the history");
  });
});
