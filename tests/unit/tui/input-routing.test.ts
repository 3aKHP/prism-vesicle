import { describe, expect, test } from "bun:test";
import { KeyEvent } from "@opentui/core";
import { consumeKey, createRoutingKey, isClipboardImagePasteKey } from "../../../src/tui/input-routing";

describe("TUI input routing", () => {
  test("preserves original OpenTUI event consumption through normalized key routing", () => {
    const rawKey = keyEvent("UP");

    const key = createRoutingKey(rawKey);
    consumeKey(key);

    expect(key.name).toBe("up");
    expect(rawKey.defaultPrevented).toBe(true);
    expect(rawKey.propagationStopped).toBe(true);
  });

  test("keeps OpenTUI prototype methods callable when they are not otherwise enumerable", () => {
    const rawKey = keyEvent("c", { ctrl: true });

    expect(Object.hasOwn(rawKey, "preventDefault")).toBe(false);
    expect(Object.hasOwn(rawKey, "stopPropagation")).toBe(false);

    consumeKey(createRoutingKey(rawKey));

    expect(rawKey.defaultPrevented).toBe(true);
    expect(rawKey.propagationStopped).toBe(true);
  });

  test.each([
    ["raw Ctrl+V control byte", keyEvent("v", { ctrl: true, sequence: "\x16", raw: "\x16" })],
    ["Ctrl+Alt+V", keyEvent("v", { ctrl: true, meta: true })],
    ["Alt+V", keyEvent("v", { meta: true })],
    ["Option+V", keyEvent("v", { option: true })],
  ])("recognizes %s as a clipboard-image paste key", (_label, rawKey) => {
    expect(isClipboardImagePasteKey(createRoutingKey(rawKey))).toBe(true);
  });

  test.each([
    ["plain v", keyEvent("v")],
    ["Ctrl+Shift+V text-paste shortcut", keyEvent("v", { ctrl: true, shift: true })],
    ["unrelated Ctrl key", keyEvent("x", { ctrl: true })],
  ])("does not treat %s as a clipboard-image paste key", (_label, rawKey) => {
    expect(isClipboardImagePasteKey(createRoutingKey(rawKey))).toBe(false);
  });
});

function keyEvent(name: string, modifiers: {
  ctrl?: boolean;
  meta?: boolean;
  shift?: boolean;
  option?: boolean;
  sequence?: string;
  raw?: string;
} = {}): KeyEvent {
  return new KeyEvent({
    name,
    ctrl: modifiers.ctrl ?? false,
    meta: modifiers.meta ?? false,
    shift: modifiers.shift ?? false,
    option: modifiers.option ?? false,
    sequence: modifiers.sequence ?? "",
    number: false,
    raw: modifiers.raw ?? "",
    eventType: "press",
    source: "raw",
  });
}
