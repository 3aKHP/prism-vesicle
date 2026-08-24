import { describe, expect, test } from "bun:test";
import { validateGeminiHistory } from "../../../src/providers/gemini-generate-content/invariants";
import type { VesicleMessage } from "../../../src/providers/shared/types";

function assistantToolTurn(ids: string[]): VesicleMessage {
  return {
    role: "assistant",
    content: "",
    toolCalls: ids.map((id) => ({ id, name: "read_file", arguments: "{}" })),
  };
}

function toolResult(id: string, content = "ok"): VesicleMessage {
  return { role: "tool", toolCallId: id, content };
}

function userTurn(content: string): VesicleMessage {
  return { role: "user", content };
}

function assistantText(content: string): VesicleMessage {
  return { role: "assistant", content };
}

function mentions(violations: string[], needle: string): boolean {
  return violations.some((violation) => violation.includes(needle));
}

describe("validateGeminiHistory", () => {
  describe("histories the Gemini endpoint accepts", () => {
    test("empty history is valid", () => {
      expect(validateGeminiHistory([])).toEqual([]);
    });

    test("plain conversation without tool activity is valid", () => {
      const history = [userTurn("hello"), assistantText("hi"), userTurn("again"), assistantText("done")];
      expect(validateGeminiHistory(history)).toEqual([]);
    });

    test("a completed single-tool round is valid", () => {
      const history = [userTurn("read it"), assistantToolTurn(["call-a"]), toolResult("call-a"), assistantText("done")];
      expect(validateGeminiHistory(history)).toEqual([]);
    });

    test("parallel tool calls answered in one consecutive batch are valid", () => {
      const history = [userTurn("both"), assistantToolTurn(["call-a", "call-b"]), toolResult("call-a"), toolResult("call-b"), assistantText("done")];
      expect(validateGeminiHistory(history)).toEqual([]);
    });

    test("an assistant tool call with an empty id is a named violation", () => {
      const history: VesicleMessage[] = [
        userTurn("go"),
        { role: "assistant", content: "", toolCalls: [{ id: "", name: "grep_files", arguments: "{}" }] },
        toolResult(""),
      ];
      const violations = validateGeminiHistory(history);
      expect(violations.some((violation) => violation.includes("empty id") && violation.includes("grep_files"))).toBe(true);
    });

    test("a user message after the batch completes is valid", () => {
      const history = [assistantToolTurn(["call-a"]), toolResult("call-a"), userTurn("next")];
      expect(validateGeminiHistory(history)).toEqual([]);
    });

    test("consecutive tool rounds each keep their own batch", () => {
      const history = [
        assistantToolTurn(["call-a"]),
        toolResult("call-a"),
        assistantToolTurn(["call-b"]),
        toolResult("call-b"),
        assistantText("done"),
      ];
      expect(validateGeminiHistory(history)).toEqual([]);
    });

    test("system and checkpoint-marker messages are transparent to the open batch", () => {
      const history: VesicleMessage[] = [
        assistantToolTurn(["call-a"]),
        { role: "system", content: "engine note" },
        { role: "user", content: "", kind: "provider-native-checkpoint" },
        toolResult("call-a"),
      ];
      expect(validateGeminiHistory(history)).toEqual([]);
    });

    test("tool-result images do not affect the batch shape", () => {
      const history: VesicleMessage[] = [
        assistantToolTurn(["call-a"]),
        {
          role: "tool",
          toolCallId: "call-a",
          content: "screenshot taken",
          images: [{
            id: "img-1",
            path: ".vesicle/tmp/mcp-output/img-1.png",
            mediaType: "image/png",
            bytes: 4,
            sha256: "0000000000000000000000000000000000000000000000000000000000000000",
            source: "mcp",
          }],
        },
      ];
      expect(validateGeminiHistory(history)).toEqual([]);
    });

    test("an assistant turn with replay thinking blocks still counts its recorded tool calls", () => {
      const history: VesicleMessage[] = [
        userTurn("go"),
        {
          role: "assistant",
          content: "",
          thinkingBlocks: [{ type: "gemini_part", part: { text: "thought" } }],
          toolCalls: [{ id: "call-a", name: "read_file", arguments: "{}" }],
        },
        toolResult("call-a"),
      ];
      expect(validateGeminiHistory(history)).toEqual([]);
    });

    test("an assistant turn with an empty toolCalls array is a plain turn", () => {
      const history: VesicleMessage[] = [userTurn("go"), { role: "assistant", content: "no tools", toolCalls: [] }, userTurn("ok")];
      expect(validateGeminiHistory(history)).toEqual([]);
    });

    test("parallel calls sharing one id are matched by count, not by uniqueness", () => {
      const history = [assistantToolTurn(["call-a", "call-a"]), toolResult("call-a"), toolResult("call-a")];
      expect(validateGeminiHistory(history)).toEqual([]);
    });
  });

  describe("histories the Gemini endpoint rejects", () => {
    test("a tool call left unanswered at the end of history is reported with its assistant index and id", () => {
      const history = [userTurn("both"), assistantToolTurn(["call-a", "call-b"]), toolResult("call-a")];
      const violations = validateGeminiHistory(history);
      expect(violations).toHaveLength(1);
      expect(violations[0]).toContain("index 1");
      expect(violations[0]).toContain('"call-b"');
    });

    test("a user message appearing before the batch completes is rejected", () => {
      const history = [assistantToolTurn(["call-a"]), userTurn("changed my mind")];
      const violations = validateGeminiHistory(history);
      expect(violations).toHaveLength(1);
      expect(violations[0]).toContain("User message at index 1");
      expect(violations[0]).toContain("assistant message at index 0");
      expect(violations[0]).toContain('"call-a"');
    });

    test("an assistant message appearing before the batch completes is rejected", () => {
      const history = [assistantToolTurn(["call-a"]), assistantText("moving on")];
      const violations = validateGeminiHistory(history);
      expect(violations).toHaveLength(1);
      expect(violations[0]).toContain("Assistant message at index 1");
      expect(violations[0]).toContain('"call-a"');
    });

    test("splitting a parallel batch with an intervening user message is reported once, naming the displaced call", () => {
      const history = [assistantToolTurn(["call-a", "call-b"]), toolResult("call-a"), userTurn("mid"), toolResult("call-b")];
      const violations = validateGeminiHistory(history);
      expect(violations).toHaveLength(1);
      expect(violations[0]).toContain("index 2");
      expect(violations[0]).toContain('"call-b"');
    });

    test("a result whose id the assistant never issued is reported together with the unanswered call", () => {
      const history = [assistantToolTurn(["call-a"]), toolResult("call-x")];
      const violations = validateGeminiHistory(history);
      expect(violations).toHaveLength(2);
      expect(mentions(violations, 'at index 1 ("call-x")')).toBe(true);
      expect(mentions(violations, 'tool call "call-a"')).toBe(true);
    });

    test("a duplicate result for an already answered call is reported", () => {
      const history = [assistantToolTurn(["call-a"]), toolResult("call-a"), toolResult("call-a")];
      const violations = validateGeminiHistory(history);
      expect(violations).toHaveLength(1);
      expect(violations[0]).toContain("index 2");
      expect(violations[0]).toContain('"call-a"');
    });

    test("a tool result with no preceding assistant tool-call turn is reported", () => {
      const history = [userTurn("hello"), toolResult("call-a")];
      const violations = validateGeminiHistory(history);
      expect(violations).toHaveLength(1);
      expect(violations[0]).toContain("index 1");
      expect(violations[0]).toContain('"call-a"');
    });

    test("a tool result without a toolCallId cannot answer its call", () => {
      const history: VesicleMessage[] = [assistantToolTurn(["call-a"]), { role: "tool", content: "orphan payload" }];
      const violations = validateGeminiHistory(history);
      expect(violations).toHaveLength(2);
      expect(mentions(violations, "index 1 has no toolCallId")).toBe(true);
      expect(mentions(violations, 'tool call "call-a"')).toBe(true);
    });

    test("history ending on an unanswered assistant tool-call turn is reported", () => {
      const history = [userTurn("go"), assistantToolTurn(["call-a"])];
      const violations = validateGeminiHistory(history);
      expect(violations).toHaveLength(1);
      expect(violations[0]).toContain("index 1");
      expect(violations[0]).toContain('"call-a"');
    });
  });

  test("validation does not mutate the input history", () => {
    const history: VesicleMessage[] = [
      userTurn("start"),
      assistantToolTurn(["call-a", "call-b"]),
      toolResult("call-a"),
      userTurn("interrupt"),
      toolResult("call-b"),
      assistantText("done"),
    ];
    const before = JSON.stringify(history);
    validateGeminiHistory(history);
    expect(JSON.stringify(history)).toBe(before);
  });
});
