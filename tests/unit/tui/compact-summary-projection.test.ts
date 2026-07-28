import { describe, expect, test } from "bun:test";
import { displayTranscriptFromSnapshot, isEmptySessionTranscript } from "../../../src/tui/session-presenter";
import type { ResumedMessage } from "../../../src/core/session/store";
import type { Message } from "../../../src/tui/types";

describe("compact-summary display projection", () => {
  test("a compact-summary ResumedMessage projects to a typed, conversation-bearing display entry", () => {
    const messages: ResumedMessage[] = [
      { role: "user", content: "[conversation summary]\nEarlier work.", kind: "compact-summary" },
    ];
    const display = displayTranscriptFromSnapshot(messages);
    expect(display).toHaveLength(1);
    expect(display[0]!.kind).toBe("compact-summary");
    expect(display[0]!.content).toContain("Conversation summary");
    // A compact summary is conversation-bearing, so the empty-session Hero
    // invariant must be false — the transcript, not the Hero, owns the region.
    expect(isEmptySessionTranscript(display)).toBe(false);
  });

  test("startup notices alone still satisfy the empty-session Hero invariant", () => {
    const display: Message[] = [
      { role: "system", content: "DANGER: YOLO for this process." },
      { role: "system", content: "Started a fresh session." },
    ];
    expect(isEmptySessionTranscript(display)).toBe(true);
  });

  test("a compact summary plus completion notice stays off the Hero even with no turn after it", () => {
    const display: Message[] = [
      { role: "system", content: "Conversation summary: earlier work.", kind: "compact-summary" },
      { role: "system", content: "Conversation compacted into a summary (61 messages)." },
    ];
    expect(isEmptySessionTranscript(display)).toBe(false);
  });

  test("a user turn after the summary keeps the invariant false", () => {
    const display = displayTranscriptFromSnapshot([
      { role: "user", content: "[conversation summary]\nEarlier work.", kind: "compact-summary" },
      { role: "user", content: "continue from the summary" },
    ]);
    expect(isEmptySessionTranscript(display)).toBe(false);
  });

  test("a resumed checkpoint session projects through the same display path with its transcript intact", () => {
    // Models loadSessionSnapshot() output for a session whose active head is a
    // compact checkpoint followed by a new turn: the replacement (summary +
    // retained tail) replayed plus the suffix. This is the display projection a
    // real resumed session uses, so a compact summary must keep the transcript
    // present and off the Hero.
    const resumed = displayTranscriptFromSnapshot([
      { role: "user", content: "[conversation summary]\nEarlier work on chapter one.", kind: "compact-summary" },
      { role: "user", content: "second" },
      { role: "assistant", content: "answer two" },
      { role: "user", content: "third" },
      { role: "assistant", content: "answer three" },
    ]);
    expect(isEmptySessionTranscript(resumed)).toBe(false);
    expect(resumed.some((message) => message.kind === "compact-summary")).toBe(true);
    expect(resumed.map((message) => message.content)).toContain("answer three");
  });
});
