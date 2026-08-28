import { describe, expect, test } from "bun:test";
import { createTerminalTitleController, oscTitleSequence, sanitizeTerminalTitle } from "../../../src/tui/terminal-title";

describe("terminal title controller", () => {
  test("encodes OSC 0 and OSC 2", () => {
    expect(oscTitleSequence("Prism")).toBe("\u001b]0;Prism\u0007\u001b]2;Prism\u0007");
  });

  test("removes control and bidi characters and bounds display width", () => {
    expect(sanitizeTerminalTitle("a\u001b]0;bad\u0007\u061c中", 4)).toBe("a中");
  });

  test("writes only on TTY and deduplicates", () => {
    let output = "";
    const controller = createTerminalTitleController({ stdout: { isTTY: true, write: (value: string) => { output += value; return true; } } });
    controller.setSession("etl", "Demo");
    controller.setSession("etl", "Demo");
    expect(output).toBe(oscTitleSequence("Demo"));
    controller.clear();
    expect(output.endsWith(oscTitleSequence(""))).toBe(true);
  });

  test("uses the product and engine only as the untitled fallback", () => {
    let output = "";
    const controller = createTerminalTitleController({ stdout: { isTTY: true, write: (value: string) => { output += value; return true; } } });
    controller.setSession("stage");
    expect(output).toBe(oscTitleSequence("Prism Vesicle · stage"));
  });

  test("auto mode is disabled off TTY", () => {
    let writes = 0;
    const controller = createTerminalTitleController({ stdout: { isTTY: false, write: () => { writes += 1; return true; } } });
    controller.set("Demo");
    expect(controller.enabled()).toBe(false);
    expect(writes).toBe(0);
  });
});
