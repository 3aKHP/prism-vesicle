import { describe, expect, test } from "bun:test";
import { displayTextFromThinkingBlocks, isKnownThinkingBlock, reasoningContentFromThinkingBlocks } from "../../../src/providers/shared/thinking";

describe("provider thinking block helpers", () => {
  test("concatenates multiple OpenAI-compatible reasoning blocks", () => {
    expect(reasoningContentFromThinkingBlocks([
      { type: "reasoning", reasoningContent: "first" },
      { type: "thinking", thinking: "native thinking" },
      { type: "reasoning", reasoningContent: "second" },
    ])).toBe("first\nsecond");
  });

  test("extracts display text from supported thinking block types", () => {
    expect(displayTextFromThinkingBlocks([
      { type: "reasoning", reasoningContent: "openai reasoning" },
      { type: "thinking", thinking: "anthropic thinking" },
      { type: "redacted_thinking", data: "opaque" },
      { type: "thought_summary", summary: "gemini summary" },
    ])).toBe([
      "openai reasoning",
      "anthropic thinking",
      "[redacted thinking]",
      "gemini summary",
    ].join("\n"));
  });

  test("isKnownThinkingBlock accepts every persisted block shape", () => {
    const valid: unknown[] = [
      { type: "reasoning", reasoningContent: "r" },
      { type: "thinking", thinking: "t" },
      { type: "redacted_thinking", data: "d" },
      { type: "thought_summary", text: "s" },
      { type: "thought_summary", summary: "s" },
      { type: "gemini_part", part: { thought: true, text: "t", thoughtSignature: "sig" } },
      { type: "gemini_part", part: { functionCall: { id: "call-1", name: "write_file", args: {} }, thoughtSignature: "sig" } },
    ];
    for (const block of valid) expect(isKnownThinkingBlock(block)).toBe(true);
  });

  test("isKnownThinkingBlock rejects malformed and unknown blocks", () => {
    const invalid: unknown[] = [
      { type: "reasoning", reasoningContent: 42 },
      { type: "thinking" },
      { type: "unknown", value: "x" },
      { type: "gemini_part" },
      { type: "gemini_part", part: "sig" },
      { type: "gemini_part", part: null },
      { type: "gemini_part", part: [{ thought: true }] },
      "reasoning",
      null,
      [{ type: "reasoning", reasoningContent: "r" }],
    ];
    for (const block of invalid) expect(isKnownThinkingBlock(block)).toBe(false);
  });
});
