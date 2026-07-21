import { describe, expect, test } from "bun:test";
import { displayTextFromThinkingBlocks, reasoningContentFromThinkingBlocks } from "../../../src/providers/shared/thinking";

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
});
