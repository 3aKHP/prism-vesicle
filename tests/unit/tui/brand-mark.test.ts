import { describe, expect, test } from "bun:test";
import { COMPACT_MARK, PRIMARY_MARK, markRuns, resolveSplashMode, scaleHex } from "../../../src/tui/brand-mark";

describe("brand mark runs", () => {
  test("run concatenation reproduces every source line", () => {
    for (const mark of [PRIMARY_MARK, COMPACT_MARK]) {
      const rows = markRuns(mark);
      expect(rows.length).toBe(mark.length);
      for (const [index, line] of mark.entries()) {
        expect(rows[index]!.map((run) => run.text).join("")).toBe(line);
      }
    }
  });

  test("every non-space ramp cell carries a tint; spaces stay untinted", () => {
    for (const row of markRuns(COMPACT_MARK)) {
      for (const run of row) {
        if (run.text.trim().length === 0) expect(run.fg).toBeUndefined();
        else expect(run.fg).toMatch(/^#[0-9a-f]{6}$/);
      }
    }
  });
});

describe("scaleHex", () => {
  test("factor 1 is identity and factor 0 goes black", () => {
    expect(scaleHex("#10b981", 1)).toBe("#10b981");
    expect(scaleHex("#10b981", 0)).toBe("#000000");
  });

  test("scales channels proportionally for the splash fade-out", () => {
    expect(scaleHex("#34d399", 0.5)).toBe("#1a6a4d");
  });
});

describe("resolveSplashMode degradation ladder", () => {
  test("non-interactive terminals skip the splash entirely", () => {
    expect(resolveSplashMode({ isTty: false, rgb: true, reducedMotion: false })).toBe("skip");
    expect(resolveSplashMode({ isTty: false, rgb: false, reducedMotion: true })).toBe("skip");
  });

  test("reduced motion freezes the frame ahead of any colour check", () => {
    expect(resolveSplashMode({ isTty: true, rgb: true, reducedMotion: true })).toBe("frozen");
    expect(resolveSplashMode({ isTty: true, rgb: false, reducedMotion: true })).toBe("frozen");
  });

  test("no truecolour means a static quantized frame; full caps animate", () => {
    expect(resolveSplashMode({ isTty: true, rgb: false, reducedMotion: false })).toBe("static");
    expect(resolveSplashMode({ isTty: true, rgb: true, reducedMotion: false })).toBe("animated");
  });
});
