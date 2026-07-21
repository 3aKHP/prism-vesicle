import { describe, expect, test } from "bun:test";
import {
  clampCommandMenuSelection,
  moveCommandMenuSelection,
} from "../../../src/tui/commands/selection";

describe("slash-command selection", () => {
  test("clamps stale and invalid cursors into the current result set", () => {
    expect(clampCommandMenuSelection(-1, 3)).toBe(0);
    expect(clampCommandMenuSelection(7, 3)).toBe(2);
    expect(clampCommandMenuSelection(1, 3)).toBe(1);
  });

  test("keeps empty result sets at a valid neutral cursor", () => {
    expect(moveCommandMenuSelection(0, 1, 0)).toBe(0);
    expect(moveCommandMenuSelection(0, -1, 0)).toBe(0);
  });

  test("moves up and down without escaping the result set", () => {
    expect(moveCommandMenuSelection(0, 1, 3)).toBe(1);
    expect(moveCommandMenuSelection(1, -1, 3)).toBe(0);
    expect(moveCommandMenuSelection(0, -1, 3)).toBe(0);
    expect(moveCommandMenuSelection(2, 1, 3)).toBe(2);
  });
});
