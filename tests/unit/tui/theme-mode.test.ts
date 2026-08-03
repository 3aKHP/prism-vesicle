import { afterEach, describe, expect, test } from "bun:test";
import {
  engineAccent,
  isLocalDaytime,
  nextAutoThemeBoundary,
  palette,
  paletteFor,
  reportTerminalThemeMode,
  resolveThemeMode,
  setThemePreference,
  sharedSyntaxStyle,
  syntaxStyle,
  themeMode,
  themePreference,
  themeSource,
} from "../../../src/tui/theme";

function relativeLuminance(hex: string): number {
  const value = Number.parseInt(hex.slice(1), 16);
  const channel = (shift: number) => {
    const srgb = ((value >> shift) & 0xff) / 255;
    return srgb <= 0.03928 ? srgb / 12.92 : ((srgb + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(16) + 0.7152 * channel(8) + 0.0722 * channel(0);
}

function contrastRatio(foreground: string, background: string): number {
  const [lighter, darker] = [relativeLuminance(foreground), relativeLuminance(background)].sort(
    (a, b) => b - a,
  );
  return (lighter + 0.05) / (darker + 0.05);
}

afterEach(() => {
  setThemePreference("default", "builtin");
  reportTerminalThemeMode(null);
});

describe("resolveThemeMode — preference → mode", () => {
  test("dark and light resolve to themselves regardless of terminal or clock", () => {
    expect(resolveThemeMode("dark", "light", at("06:30"))).toBe("dark");
    expect(resolveThemeMode("light", "dark", at("22:00"))).toBe("light");
  });

  test("default follows the terminal report and falls back to dark", () => {
    expect(resolveThemeMode("default", "light", at("12:00"))).toBe("light");
    expect(resolveThemeMode("default", "dark", at("12:00"))).toBe("dark");
    expect(resolveThemeMode("default", null, at("12:00"))).toBe("dark");
  });

  test("auto ignores the terminal and follows local time", () => {
    expect(resolveThemeMode("auto", "light", at("06:59"))).toBe("dark");
    expect(resolveThemeMode("auto", "dark", at("12:00"))).toBe("light");
    expect(resolveThemeMode("auto", null, at("22:00"))).toBe("dark");
  });
});

describe("auto boundary contract", () => {
  test("06:59:59.999 → dark, 07:00:00.000 → light", () => {
    expect(resolveThemeMode("auto", null, at("06:59:59.999"))).toBe("dark");
    expect(resolveThemeMode("auto", null, at("07:00:00.000"))).toBe("light");
  });

  test("18:59:59.999 → light, 19:00:00.000 → dark", () => {
    expect(resolveThemeMode("auto", null, at("18:59:59.999"))).toBe("light");
    expect(resolveThemeMode("auto", null, at("19:00:00.000"))).toBe("dark");
  });

  test("isLocalDaytime matches the [07:00, 19:00) window", () => {
    expect(isLocalDaytime(at("06:59"))).toBe(false);
    expect(isLocalDaytime(at("07:00"))).toBe(true);
    expect(isLocalDaytime(at("18:59"))).toBe(true);
    expect(isLocalDaytime(at("19:00"))).toBe(false);
  });
});

describe("nextAutoThemeBoundary", () => {
  test("before today's 07:00 → today's 07:00", () => {
    expect(nextAutoThemeBoundary(at("03:00")).getTime()).toBe(at("07:00").getTime());
  });

  test("between 07:00 and 19:00 → today's 19:00", () => {
    expect(nextAutoThemeBoundary(at("12:00")).getTime()).toBe(at("19:00").getTime());
    expect(nextAutoThemeBoundary(at("07:00")).getTime()).toBe(at("19:00").getTime());
  });

  test("at exactly 07:00 the next boundary is 19:00 (strictly after)", () => {
    expect(nextAutoThemeBoundary(at("07:00")).getTime()).toBe(at("19:00").getTime());
  });

  test("at exactly 19:00 the next boundary is tomorrow's 07:00", () => {
    const tomorrowSeven = at("07:00");
    tomorrowSeven.setDate(tomorrowSeven.getDate() + 1);
    expect(nextAutoThemeBoundary(at("19:00")).getTime()).toBe(tomorrowSeven.getTime());
  });

  test("after 19:00 → tomorrow's 07:00", () => {
    const tomorrowSeven = at("07:00");
    tomorrowSeven.setDate(tomorrowSeven.getDate() + 1);
    expect(nextAutoThemeBoundary(at("23:59")).getTime()).toBe(tomorrowSeven.getTime());
  });
});

describe("reactive preference and source", () => {
  test("explicit preference switches palette, engine accents, and syntax style", () => {
    setThemePreference("light", "session");
    expect(themePreference()).toBe("light");
    expect(themeSource()).toBe("session");
    expect(themeMode()).toBe("light");
    expect(palette.bg).toBe("#f5f4f0");
    expect(palette.textPrimary).toBe("#23261f");
    expect(palette.selectionForeground).toBe("#f5f4f0");
    expect(palette.selectionBackground).toBe("#23261f");
    expect(palette.editorCursor).toBe("#266f54");
    expect(engineAccent("stage")).toBe("#7247ce");
    expect(engineAccent("etl")).toBe("#266f54");
    expect(syntaxStyle()).not.toBe(sharedSyntaxStyle);

    setThemePreference("dark", "session");
    expect(themeMode()).toBe("dark");
    expect(palette.bg).toBe("#121415");
    expect(palette.selectionForeground).toBe("#121415");
    expect(palette.selectionBackground).toBe("#e3e5e6");
    expect(palette.editorCursor).toBe("#10b981");
    expect(engineAccent("stage")).toBe("#8b5cf6");
    expect(syntaxStyle()).toBe(sharedSyntaxStyle);
  });

  test("default follows terminal report and falls back to dark", () => {
    setThemePreference("default", "builtin");
    expect(themeMode()).toBe("dark");
    reportTerminalThemeMode("light");
    expect(themeMode()).toBe("light");
    reportTerminalThemeMode("dark");
    expect(themeMode()).toBe("dark");
    reportTerminalThemeMode(null);
    expect(themeMode()).toBe("dark");
  });

  test("terminal reports do not re-render while default is not effective", () => {
    setThemePreference("light", "session");
    reportTerminalThemeMode("dark");
    expect(themeMode()).toBe("light");
  });

  test("auto ignores terminal reports (time-based only)", () => {
    // Use noon so the resolved mode is deterministic regardless of test time.
    setThemePreference("auto", "session");
    const expected = isLocalDaytime(new Date()) ? "light" : "dark";
    reportTerminalThemeMode("light");
    expect(themeMode()).toBe(expected);
    reportTerminalThemeMode("dark");
    expect(themeMode()).toBe(expected);
  });
});

describe("light palette contrast", () => {
  const light = paletteFor("light");
  const textRoles = [
    "textPrimary",
    "textSecondary",
    "textMuted",
    "user",
    "assistant",
    "system",
    "tool",
    "error",
    "success",
    "warn",
    "gateAccent",
    "brand",
    "brandDim",
  ] as const;
  const engineIds = ["etl", "runtime", "evaluate", "weaver", "weaver-orch", "dyad", "stage"] as const;

  test("text roles meet 4.5:1 on the light background", () => {
    for (const role of textRoles) {
      expect(contrastRatio(light[role], light.bg)).toBeGreaterThanOrEqual(4.5);
    }
  });

  test("engine accents meet 4.5:1 on the light background", () => {
    const lightPalette = paletteFor("light");
    setThemePreference("light", "session");
    for (const id of engineIds) {
      expect(contrastRatio(engineAccent(id), lightPalette.bg)).toBeGreaterThanOrEqual(4.5);
    }
  });

  test("selection and editor cursor colors remain visible on light surfaces", () => {
    expect(contrastRatio(light.selectionForeground, light.selectionBackground)).toBeGreaterThanOrEqual(7);
    expect(contrastRatio(light.editorCursor, light.bg)).toBeGreaterThanOrEqual(4.5);
  });
});

/** Build a Date at a local HH:MM[:SS.mmm] on today's date (stable calendar day). */
function at(clock: string): Date {
  const [hms, ms = "0"] = clock.split(".");
  const parts = hms!.split(":").map((part) => Number(part));
  const h = parts[0]!;
  const m = parts[1]!;
  const s = parts[2] ?? 0;
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), now.getDate(), h, m, s, Number(ms));
}
