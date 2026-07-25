import { afterEach, describe, expect, test } from "bun:test";
import {
  engineAccent,
  palette,
  paletteFor,
  reportTerminalThemeMode,
  setThemePreference,
  sharedSyntaxStyle,
  syntaxStyle,
  themeMode,
  themePreference,
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
  setThemePreference("dark");
  reportTerminalThemeMode(null);
});

describe("theme mode", () => {
  test("defaults to dark palette under auto without terminal report", () => {
    setThemePreference("auto");
    expect(themePreference()).toBe("auto");
    expect(themeMode()).toBe("dark");
    expect(palette.bg).toBe("#121415");
    expect(engineAccent("stage")).toBe("#8b5cf6");
  });

  test("explicit light preference switches palette, engine accents, and syntax style", () => {
    setThemePreference("light");
    expect(themeMode()).toBe("light");
    expect(palette.bg).toBe("#f5f4f0");
    expect(palette.textPrimary).toBe("#23261f");
    expect(engineAccent("stage")).toBe("#7247ce");
    expect(engineAccent("etl")).toBe("#266f54");
    expect(syntaxStyle()).not.toBe(sharedSyntaxStyle);

    setThemePreference("dark");
    expect(themeMode()).toBe("dark");
    expect(palette.bg).toBe("#121415");
    expect(engineAccent("stage")).toBe("#8b5cf6");
    expect(syntaxStyle()).toBe(sharedSyntaxStyle);
  });

  test("auto preference follows terminal report and falls back to dark", () => {
    setThemePreference("auto");
    reportTerminalThemeMode("light");
    expect(themeMode()).toBe("light");
    expect(palette.bg).toBe("#f5f4f0");
    reportTerminalThemeMode("dark");
    expect(themeMode()).toBe("dark");
    reportTerminalThemeMode("light");
    reportTerminalThemeMode(null);
    expect(themeMode()).toBe("dark");
  });

  test("explicit preference wins over terminal report", () => {
    setThemePreference("light");
    reportTerminalThemeMode("dark");
    expect(themeMode()).toBe("light");
    setThemePreference("dark");
    reportTerminalThemeMode("light");
    expect(themeMode()).toBe("dark");
  });
});

describe("light palette contrast", () => {
  const light = paletteFor("light");
  // Text-level roles must hold WCAG AA 4.5:1 against the day background.
  // Decorative roles (textDim, gateBorder, lane*) are exempt by design.
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
    setThemePreference("light");
    for (const id of engineIds) {
      expect(contrastRatio(engineAccent(id), lightPalette.bg)).toBeGreaterThanOrEqual(4.5);
    }
  });
});
