import { describe, expect, test } from "bun:test";
import { DoublePressTracker } from "../src/tui/double-press";
import { PromptEscapeController } from "../src/tui/prompt-escape";

describe("double escape timing", () => {
  test("recognizes a second press within the Claude Code 800ms window", () => {
    const tracker = new DoublePressTracker();
    expect(tracker.press(1_000)).toBe("first");
    expect(tracker.press(1_800)).toBe("double");
    expect(tracker.press(1_900)).toBe("first");
  });

  test("an expired second press starts a new pair", () => {
    const tracker = new DoublePressTracker();
    expect(tracker.press(1_000)).toBe("first");
    expect(tracker.press(1_801)).toBe("first");
    expect(tracker.press(2_000)).toBe("double");
  });

  test("matches the Claude Code prompt-state matrix", () => {
    const escapeController = new PromptEscapeController();
    expect(escapeController.press({ busy: true, draft: "", hasSession: true }, 0)).toBe("interrupt");
    expect(escapeController.press({ busy: false, draft: "draft", hasSession: true }, 1_000)).toBe("arm-clear");
    expect(escapeController.press({ busy: false, draft: "draft", hasSession: true }, 1_500)).toBe("clear");
    expect(escapeController.press({ busy: false, draft: "", hasSession: false }, 2_000)).toBe("noop");
    expect(escapeController.press({ busy: false, draft: "", hasSession: true }, 3_000)).toBe("arm-rewind");
    expect(escapeController.press({ busy: false, draft: "", hasSession: true }, 3_500)).toBe("rewind");
  });
});
