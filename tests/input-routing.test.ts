import { describe, expect, test } from "bun:test";
import { KeyEvent } from "@opentui/core";
import { consumeKey, createRoutingKey } from "../src/tui/input-routing";

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
    const rawKey = keyEvent("c", true);

    expect(Object.hasOwn(rawKey, "preventDefault")).toBe(false);
    expect(Object.hasOwn(rawKey, "stopPropagation")).toBe(false);

    consumeKey(createRoutingKey(rawKey));

    expect(rawKey.defaultPrevented).toBe(true);
    expect(rawKey.propagationStopped).toBe(true);
  });
});

function keyEvent(name: string, ctrl = false): KeyEvent {
  return new KeyEvent({
    name,
    ctrl,
    meta: false,
    shift: false,
    option: false,
    sequence: "",
    number: false,
    raw: "",
    eventType: "press",
    source: "raw",
  });
}
