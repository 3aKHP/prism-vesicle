import { describe, expect, test } from "bun:test";
import { applyComposerKey, insertComposerImage, insertComposerText, setComposerValue } from "../../../src/tui/composer";

describe("TUI prompt composer", () => {
  test("treats image placeholders as atomic editable elements", () => {
    const attached = insertComposerImage(setComposerValue("look "), "img_1", "[Image #1]");
    expect(attached.elements).toEqual([{
      type: "image",
      attachmentId: "img_1",
      placeholder: "[Image #1]",
      start: 5,
      end: 15,
    }]);

    const movedLeft = applyComposerKey(attached, { name: "left" });
    expect(movedLeft.state.cursor).toBe(5);
    const deleted = applyComposerKey(attached, { name: "backspace" });
    expect(deleted.state.value).toBe("look ");
    expect(deleted.state.elements).toEqual([]);

    const before = applyComposerKey(attached, { name: "b", meta: true });
    expect(before.state.cursor).toBe(5);
    const after = applyComposerKey({ ...attached, cursor: 5 }, { name: "f", meta: true });
    expect(after.state.cursor).toBe(15);

    const first = insertComposerImage(setComposerValue(""), "img_1", "[Image #1]");
    const separated = insertComposerText(first, " ");
    const second = insertComposerImage(separated, "img_2", "[Image #2]");
    const removedFirst = applyComposerKey({ ...second, cursor: first.elements![0].end }, { name: "backspace" });
    expect(removedFirst.state.value).toBe(" [Image #1]");
    expect(removedFirst.state.elements).toEqual([expect.objectContaining({ attachmentId: "img_2", placeholder: "[Image #1]" })]);
  });
  test("reverse-order image insertion renumbers placeholders to match visual order", () => {
    // Paste first image at the end of a multiline draft.
    let state = setComposerValue("first line\nsecond line", 22);
    state = insertComposerImage(state, "img_first", "[Image #0]");
    expect(state.elements).toHaveLength(1);
    expect(state.elements![0].placeholder).toBe("[Image #1]");

    // Move cursor to the beginning and paste a second image there.
    state = { ...state, cursor: 0 };
    state = insertComposerImage(state, "img_second", "[Image #0]");
    expect(state.elements).toHaveLength(2);

    // Visual order: img_second is earlier → #1, img_first is later → #2.
    expect(state.elements![0].attachmentId).toBe("img_second");
    expect(state.elements![0].placeholder).toBe("[Image #1]");
    expect(state.elements![1].attachmentId).toBe("img_first");
    expect(state.elements![1].placeholder).toBe("[Image #2]");

    // The text contains correctly ordered placeholders.
    expect(state.value).toContain("[Image #1]");
    expect(state.value).toContain("[Image #2]");
    expect(state.value.indexOf("[Image #1]")).toBeLessThan(state.value.indexOf("[Image #2]"));
  });

  test("pasting the same image twice reuses its id but keeps distinct, correctly numbered elements", () => {
    // Attachment ids are content-hash derived, so an identical image pasted
    // twice yields the same attachmentId for both elements.
    let state = setComposerValue("a b", 1);
    state = insertComposerImage(state, "img_same", "[Image #0]");
    state = { ...state, cursor: state.value.length };
    state = insertComposerImage(state, "img_same", "[Image #0]");

    expect(state.elements).toHaveLength(2);
    expect(state.elements![0].attachmentId).toBe("img_same");
    expect(state.elements![1].attachmentId).toBe("img_same");
    expect(state.elements![0].placeholder).toBe("[Image #1]");
    expect(state.elements![1].placeholder).toBe("[Image #2]");
    // The two placeholders occupy distinct, ordered ranges.
    expect(state.elements![0].start).toBeLessThan(state.elements![1].start);
  });

  test("inserting at an existing placeholder's start pushes it right and numbers the new image #1", () => {
    let state = setComposerValue("X");
    state = insertComposerImage({ ...state, cursor: 1 }, "img_a", "[Image #0]");
    // value: "X[Image #1]", element img_a at [1, 11).
    expect(state.elements![0].attachmentId).toBe("img_a");

    // Cursor at the exact start of img_a's placeholder.
    state = { ...state, cursor: state.elements![0].start };
    state = insertComposerImage(state, "img_b", "[Image #0]");

    // img_b lands before img_a, which shifts right.
    expect(state.elements).toHaveLength(2);
    expect(state.elements![0].attachmentId).toBe("img_b");
    expect(state.elements![0].placeholder).toBe("[Image #1]");
    expect(state.elements![1].attachmentId).toBe("img_a");
    expect(state.elements![1].placeholder).toBe("[Image #2]");
  });

  test("backspace edits the draft without submitting", () => {
    const result = applyComposerKey(setComposerValue("runtime"), { name: "backspace" });

    expect(result.handled).toBe(true);
    expect(result.action).toBeUndefined();
    expect(result.state.value).toBe("runtim");
    expect(result.state.cursor).toBe(6);
  });

  test("moves across and deletes whole grapheme clusters", () => {
    const family = "👨‍👩‍👧‍👦";
    const value = `A${family}B`;
    const afterB = applyComposerKey(setComposerValue(value), { name: "left" });
    const beforeFamily = applyComposerKey(afterB.state, { name: "left" });
    const afterFamily = applyComposerKey(beforeFamily.state, { name: "right" });

    expect(afterB.state.cursor).toBe(value.length - 1);
    expect(beforeFamily.state.cursor).toBe(1);
    expect(afterFamily.state.cursor).toBe(1 + family.length);
    expect(applyComposerKey(afterFamily.state, { name: "backspace" }).state.value).toBe("AB");
    expect(applyComposerKey(beforeFamily.state, { name: "delete" }).state.value).toBe("AB");
    expect(setComposerValue(value, 3).cursor).toBe(1 + family.length);
  });

  test("plain enter submits, shift enter is inert, and ctrl enter inserts newlines", () => {
    const shift = applyComposerKey(setComposerValue("line one"), { name: "enter", shift: true });
    expect(shift.handled).toBe(true);
    expect(shift.action).toBeUndefined();
    expect(shift.state.value).toBe("line one");

    const shiftLinefeed = applyComposerKey(setComposerValue("line one"), { name: "linefeed", shift: true });
    expect(shiftLinefeed.handled).toBe(true);
    expect(shiftLinefeed.action).toBeUndefined();
    expect(shiftLinefeed.state.value).toBe("line one");

    const ctrl = applyComposerKey(setComposerValue("line one"), { name: "enter", ctrl: true });
    expect(ctrl.action).toBeUndefined();
    expect(ctrl.state.value).toBe("line one\n");

    const linefeed = applyComposerKey(setComposerValue("line one"), { name: "linefeed", sequence: "\n" });
    expect(linefeed.action).toBeUndefined();
    expect(linefeed.state.value).toBe("line one\n");

    const ctrlJ = applyComposerKey(setComposerValue("line one"), { name: "j", ctrl: true });
    expect(ctrlJ.action).toBeUndefined();
    expect(ctrlJ.state.value).toBe("line one\n");

    const submit = applyComposerKey(setComposerValue("line one"), { name: "enter" });
    expect(submit.action).toEqual({ type: "submit", value: "line one" });
    expect(submit.state.value).toBe("line one");
  });

  test("recognizes enhanced ctrl enter newline sequences without enabling shift enter", () => {
    const shiftCsiu = applyComposerKey(setComposerValue("line one"), { sequence: "\x1b[13;2u" });
    expect(shiftCsiu.handled).toBe(false);
    expect(shiftCsiu.state.value).toBe("line one");

    const ctrlCsiu = applyComposerKey(setComposerValue("line one"), { sequence: "\x1b[13;5u" });
    expect(ctrlCsiu.action).toBeUndefined();
    expect(ctrlCsiu.state.value).toBe("line one\n");

    const ctrlShiftCsiu = applyComposerKey(setComposerValue("line one"), { sequence: "\x1b[13;6u" });
    expect(ctrlShiftCsiu.action).toBeUndefined();
    expect(ctrlShiftCsiu.state.value).toBe("line one\n");
  });

  test("backslash enter inserts a newline like Claude Code", () => {
    const result = applyComposerKey(setComposerValue("one\\"), { name: "enter" });

    expect(result.action).toBeUndefined();
    expect(result.state.value).toBe("one\n");
    expect(result.state.cursor).toBe(4);
  });

  test("up and down move within multiline input before falling through to history", () => {
    const top = setComposerValue("abc\ndef", 5);
    const movedUp = applyComposerKey(top, { name: "up" });

    expect(movedUp.action).toBeUndefined();
    expect(movedUp.state.cursor).toBe(1);

    const historyUp = applyComposerKey(movedUp.state, { name: "up" });
    expect(historyUp.action).toEqual({ type: "history_up" });

    const movedDown = applyComposerKey(movedUp.state, { name: "down" });
    expect(movedDown.action).toBeUndefined();
    expect(movedDown.state.cursor).toBe(5);

    const historyDown = applyComposerKey(movedDown.state, { name: "down" });
    expect(historyDown.action).toEqual({ type: "history_down" });
  });

  test("up and down move within soft-wrapped visual lines before history fallback", () => {
    const end = setComposerValue("abcdefghi", 9);
    const movedUp = applyComposerKey(end, { name: "up" }, { columns: 4 });

    expect(movedUp.action).toBeUndefined();
    expect(movedUp.state.cursor).toBe(5);

    const movedUpAgain = applyComposerKey(movedUp.state, { name: "up" }, { columns: 4 });
    expect(movedUpAgain.action).toBeUndefined();
    expect(movedUpAgain.state.cursor).toBe(1);

    const historyUp = applyComposerKey(movedUpAgain.state, { name: "up" }, { columns: 4 });
    expect(historyUp.action).toEqual({ type: "history_up" });

    const movedDown = applyComposerKey(movedUpAgain.state, { name: "down" }, { columns: 4 });
    expect(movedDown.action).toBeUndefined();
    expect(movedDown.state.cursor).toBe(5);
  });

  test("readline editing shortcuts follow the Claude Code core set", () => {
    const start = setComposerValue("hello world", 11);
    const wordDeleted = applyComposerKey(start, { name: "w", ctrl: true });
    expect(wordDeleted.state.value).toBe("hello ");
    expect(wordDeleted.state.killBuffer).toBe("world");

    const lineStart = applyComposerKey(setComposerValue("hello\nworld", 11), { name: "a", ctrl: true });
    expect(lineStart.state.cursor).toBe(6);

    const lineEnd = applyComposerKey(lineStart.state, { name: "e", ctrl: true });
    expect(lineEnd.state.cursor).toBe(11);

    const pasted = insertComposerText(setComposerValue("a"), "b\r\nc");
    expect(pasted.value).toBe("ab\nc");
  });
});
