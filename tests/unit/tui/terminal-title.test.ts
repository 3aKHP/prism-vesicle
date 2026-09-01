import { describe, expect, test } from "bun:test";
import {
  createTerminalTitleController,
  resolveTerminalTitlePhase,
  sanitizeTerminalTitle,
  TERMINAL_TITLE_FRAME_INTERVAL_MS,
  type TerminalTitleWriter,
} from "../../../src/tui/terminal-title";
import { displayWidth } from "../../../src/tui/format";

function writerFixture(): { writer: TerminalTitleWriter; titles: string[] } {
  const titles: string[] = [];
  return {
    titles,
    writer: { setTerminalTitle: (title) => { titles.push(title); } },
  };
}

describe("terminal title controller", () => {
  test("gives pending user input priority over working state", () => {
    expect(resolveTerminalTitlePhase({ inputRequired: true, busy: true, restoring: true })).toBe("input-required");
    expect(resolveTerminalTitlePhase({ inputRequired: false, busy: true, restoring: false })).toBe("working");
    expect(resolveTerminalTitlePhase({ inputRequired: false, busy: false, restoring: true })).toBe("working");
    expect(resolveTerminalTitlePhase({ inputRequired: false, busy: false, restoring: false })).toBe("idle");
  });

  test("sanitizes terminal controls, format characters, and display width by grapheme", () => {
    expect(sanitizeTerminalTitle("a\u001b]0;bad\u0007\u061c\u200b中é", 3)).toBe("a中");
  });

  test("keeps words separated when control whitespace crosses lines", () => {
    expect(sanitizeTerminalTitle("first\n\tsecond")).toBe("first second");
  });

  test("keeps the composed title within the display-width bound", () => {
    const fixture = writerFixture();
    const controller = createTerminalTitleController({ writer: fixture.writer, isTTY: true });
    controller.setSession("etl", "x".repeat(120));
    expect(displayWidth(fixture.titles.at(-1) ?? "")).toBeLessThanOrEqual(120);
  });

  test("projects durable titles directly and falls back to a safe project basename", () => {
    const fixture = writerFixture();
    const controller = createTerminalTitleController({ writer: fixture.writer, isTTY: true });

    controller.setSession("etl", "Demo");
    expect(fixture.titles).toEqual(["■ Demo"]);
    controller.setSession("etl", undefined, "my-project");
    expect(fixture.titles.at(-1)).toBe("■ Prism Vesicle · my-project");
    controller.setSession("stage");
    expect(fixture.titles.at(-1)).toBe("■ Prism Vesicle · stage");
  });

  test("extracts only the final project path segment for fallback titles", () => {
    const fixture = writerFixture();
    const controller = createTerminalTitleController({ writer: fixture.writer, isTTY: true });

    controller.setSession("etl", undefined, "/home/alice/private/project");
    expect(fixture.titles.at(-1)).toBe("■ Prism Vesicle · project");
    controller.clear();
    const windows = writerFixture();
    const windowsController = createTerminalTitleController({ writer: windows.writer, isTTY: true });
    windowsController.setSession("etl", undefined, "C:\\Users\\alice\\project");
    expect(windows.titles.at(-1)).toBe("■ Prism Vesicle · project");
  });

  test("attaches a renderer after the session context is known", () => {
    const fixture = writerFixture();
    const controller = createTerminalTitleController({ isTTY: true });

    controller.setSession("etl", "Demo");
    controller.attach(fixture.writer);
    expect(fixture.titles).toEqual(["■ Demo"]);
  });

  test("restarts working animation when the renderer writer is replaced", () => {
    const first = writerFixture();
    const second = writerFixture();
    let tick: (() => void) | undefined;
    let intervals = 0;
    let cleared = 0;
    const controller = createTerminalTitleController({
      writer: first.writer,
      isTTY: true,
      timers: {
        setInterval: (handler) => {
          intervals += 1;
          tick = handler;
          return intervals as unknown as ReturnType<typeof setInterval>;
        },
        clearInterval: () => { cleared += 1; },
      },
    });

    controller.setSession("etl", "Demo");
    controller.setPhase("working");
    controller.attach(second.writer);
    tick?.();

    expect(intervals).toBe(2);
    expect(cleared).toBe(1);
    expect(first.titles).toEqual(["■ Demo", "◰ Demo"]);
    expect(second.titles).toEqual(["◰ Demo", "◳ Demo"]);
  });

  test("projects working as a stable-width quadrant pulse and input-required as a fixed marker", () => {
    const fixture = writerFixture();
    let tick: (() => void) | undefined;
    let cleared = 0;
    const controller = createTerminalTitleController({
      writer: fixture.writer,
      isTTY: true,
      timers: {
        setInterval: (handler) => {
          tick = handler;
          return 1 as unknown as ReturnType<typeof setInterval>;
        },
        clearInterval: () => { cleared += 1; },
      },
    });

    controller.setSession("etl", "Demo");
    controller.setPhase("working");
    expect(fixture.titles.at(-1)).toBe("◰ Demo");
    expect(tick).toBeDefined();
    tick?.();
    expect(fixture.titles.at(-1)).toBe("◳ Demo");
    tick?.();
    expect(fixture.titles.at(-1)).toBe("◲ Demo");
    tick?.();
    expect(fixture.titles.at(-1)).toBe("◱ Demo");
    tick?.();
    expect(fixture.titles.at(-1)).toBe("◰ Demo");
    controller.setPhase("input-required");
    expect(fixture.titles.at(-1)).toBe("▣ Demo");
    expect(cleared).toBe(1);
    controller.setPhase("idle");
    expect(fixture.titles.at(-1)).toBe("■ Demo");
  });

  test("reduced motion freezes working at the neutral frame", () => {
    const fixture = writerFixture();
    let intervals = 0;
    const controller = createTerminalTitleController({
      writer: fixture.writer,
      isTTY: true,
      env: { VESICLE_REDUCED_MOTION: "1" },
      timers: {
        setInterval: () => {
          intervals += 1;
          return 1 as unknown as ReturnType<typeof setInterval>;
        },
        clearInterval: () => undefined,
      },
    });

    controller.setSession("etl", "Demo");
    controller.setPhase("working");
    expect(fixture.titles.at(-1)).toBe("◰ Demo");
    expect(intervals).toBe(0);
  });

  test("deduplicates ordinary updates but reprojects explicitly", () => {
    const fixture = writerFixture();
    const controller = createTerminalTitleController({ writer: fixture.writer, isTTY: true });

    controller.setSession("etl", "Demo");
    controller.setSession("etl", "Demo");
    expect(fixture.titles).toEqual(["■ Demo"]);
    controller.reproject();
    expect(fixture.titles).toEqual(["■ Demo", "■ Demo"]);
  });

  test("does not reset or rewrite an unchanged working phase", () => {
    const fixture = writerFixture();
    let tick: (() => void) | undefined;
    const controller = createTerminalTitleController({
      writer: fixture.writer,
      isTTY: true,
      timers: {
        setInterval: (handler) => {
          tick = handler;
          return 1 as unknown as ReturnType<typeof setInterval>;
        },
        clearInterval: () => undefined,
      },
    });

    controller.setSession("etl", "Demo");
    controller.setPhase("working");
    tick?.();
    controller.setPhase("working");
    expect(fixture.titles).toEqual(["■ Demo", "◰ Demo", "◳ Demo"]);
  });

  test("disable is a hard no-write boundary, including shutdown cleanup", () => {
    const fixture = writerFixture();
    let intervals = 0;
    const controller = createTerminalTitleController({
      writer: fixture.writer,
      isTTY: true,
      env: { VESICLE_DISABLE_TERMINAL_TITLE: "1" },
      timers: {
        setInterval: () => {
          intervals += 1;
          return 1 as unknown as ReturnType<typeof setInterval>;
        },
        clearInterval: () => undefined,
      },
    });

    controller.setSession("etl", "Demo");
    controller.clear();
    expect(controller.enabled()).toBe(false);
    expect(controller.current()).toBeUndefined();
    expect(fixture.titles).toEqual([]);
    expect(intervals).toBe(0);
  });

  test("invalid terminal-title mode fails closed", () => {
    const fixture = writerFixture();
    const controller = createTerminalTitleController({
      writer: fixture.writer,
      isTTY: true,
      env: { VESICLE_TERMINAL_TITLE: "unexpected" },
    });

    controller.setSession("etl", "Demo");
    expect(controller.enabled()).toBe(false);
    expect(fixture.titles).toEqual([]);
  });

  test("clear makes the controller inert so stale callbacks cannot resurrect a title", () => {
    const fixture = writerFixture();
    const controller = createTerminalTitleController({ writer: fixture.writer, isTTY: true });

    controller.setSession("etl", "Demo");
    controller.clear();
    controller.setSession("etl", "Stale");
    controller.setPhase("working");
    controller.reproject();

    expect(fixture.titles).toEqual(["■ Demo", ""]);
  });

  test("auto mode is disabled off TTY and setup uses the fixed title", () => {
    const fixture = writerFixture();
    const controller = createTerminalTitleController({ writer: fixture.writer, isTTY: false });
    controller.setSetup();
    expect(controller.enabled()).toBe(false);
    expect(fixture.titles).toEqual([]);

    const tty = writerFixture();
    const setup = createTerminalTitleController({ writer: tty.writer, isTTY: true });
    setup.setSetup();
    expect(tty.titles).toEqual(["Prism Vesicle Setup"]);
  });

  test("setup resets a prior working phase before a later session projection", () => {
    const fixture = writerFixture();
    let intervals = 0;
    const controller = createTerminalTitleController({
      writer: fixture.writer,
      isTTY: true,
      timers: {
        setInterval: () => {
          intervals += 1;
          return 1 as unknown as ReturnType<typeof setInterval>;
        },
        clearInterval: () => undefined,
      },
    });

    controller.setSession("etl", "Demo");
    controller.setPhase("working");
    controller.setSetup();
    controller.setSession("etl", "Next");
    expect(fixture.titles.at(-1)).toBe("■ Next");
    expect(intervals).toBe(1);
  });

  test("uses the configured frame interval", () => {
    expect(TERMINAL_TITLE_FRAME_INTERVAL_MS).toBe(800);
  });
});
