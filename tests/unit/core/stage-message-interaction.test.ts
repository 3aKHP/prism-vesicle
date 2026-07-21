import { describe, expect, test } from "bun:test";
import { isStageMessageToggleShortcut, stageMessageToggleShortcut } from "../../../src/tui/stage-message-interaction";

describe("Stage message interaction", () => {
  test("reserves only Ctrl+Alt+S for source-view toggling", () => {
    expect(stageMessageToggleShortcut).toBe("Ctrl+Alt+S");
    expect(isStageMessageToggleShortcut({ name: "s", ctrl: true, meta: true })).toBe(true);
    expect(isStageMessageToggleShortcut({ name: "s", ctrl: true, option: true })).toBe(true);

    expect(isStageMessageToggleShortcut({ name: "enter" })).toBe(false);
    expect(isStageMessageToggleShortcut({ name: "space" })).toBe(false);
    expect(isStageMessageToggleShortcut({ name: "s", ctrl: true })).toBe(false);
    expect(isStageMessageToggleShortcut({ name: "s", option: true })).toBe(false);
  });
});
