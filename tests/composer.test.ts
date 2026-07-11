import { describe, expect, test } from "bun:test";
import { applyComposerKey, insertComposerImage, insertComposerText, setComposerValue } from "../src/tui/composer";

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
  test("backspace edits the draft without submitting", () => {
    const result = applyComposerKey(setComposerValue("runtime"), { name: "backspace" });

    expect(result.handled).toBe(true);
    expect(result.action).toBeUndefined();
    expect(result.state.value).toBe("runtim");
    expect(result.state.cursor).toBe(6);
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
