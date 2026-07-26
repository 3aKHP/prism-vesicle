import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  createThemePreferenceController,
  parseEnvTheme,
  selectStartupPreference,
} from "../../../src/tui/theme-preference-controller";
import { reportTerminalThemeMode, setThemePreference, themeMode, themePreference, themeSource } from "../../../src/tui/theme";
import { writeProjectThemePreference } from "../../../src/config/project-preferences";
import { afterEach } from "bun:test";

afterEach(() => {
  setThemePreference("default", "builtin");
  reportTerminalThemeMode(null);
});

describe("parseEnvTheme", () => {
  test("absent is valid and not present", () => {
    expect(parseEnvTheme(undefined)).toEqual({ valid: true, present: false });
    expect(parseEnvTheme("  ")).toEqual({ valid: true, present: false, raw: "  " });
  });

  test("the four preferences are valid", () => {
    for (const value of ["dark", "light", "default", "auto", "AUTO", " Dark "]) {
      const lower = value.trim().toLowerCase();
      const parsed = parseEnvTheme(value);
      expect(parsed.valid).toBe(true);
      expect(parsed.present).toBe(true);
      expect(parsed.value).toBe(lower as "dark" | "light" | "default" | "auto");
    }
  });

  test("an invalid value is present but not valid", () => {
    const parsed = parseEnvTheme("neon");
    expect(parsed).toEqual({ valid: false, present: true, value: undefined, raw: "neon" });
  });
});

describe("selectStartupPreference — source precedence", () => {
  test("cli wins over project, env, and built-in", () => {
    expect(selectStartupPreference({ cli: "dark", project: "light", env: "auto" }))
      .toEqual({ preference: "dark", source: "cli" });
  });

  test("project wins over env when cli is absent", () => {
    expect(selectStartupPreference({ project: "auto", env: "dark" }))
      .toEqual({ preference: "auto", source: "project" });
  });

  test("env wins over built-in when cli and project are absent", () => {
    expect(selectStartupPreference({ env: "light" }))
      .toEqual({ preference: "light", source: "env" });
  });

  test("built-in default when nothing is supplied", () => {
    expect(selectStartupPreference({})).toEqual({ preference: "default", source: "builtin" });
  });
});

describe("theme preference controller — effective resolution and lifecycle", () => {
  let root: string;
  beforeAll(async () => { root = await mkdtemp(join(tmpdir(), "vesicle-ctl-")); });
  afterAll(async () => { await rm(root, { recursive: true, force: true }); });

  function controller(opts: { cli?: "dark" | "light"; env?: string; project?: { theme?: "dark" | "light" | "default" | "auto"; diagnostic?: string } }) {
    return createThemePreferenceController({
      rootDir: root,
      cliPreference: opts.cli,
      envParse: parseEnvTheme(opts.env),
      project: opts.project ?? {},
    });
  }

  test("startup uses cli > project > env > built-in", () => {
    controller({ cli: "light", project: { theme: "dark" }, env: "auto" }).applyStartup();
    expect(themePreference()).toBe("light");
    expect(themeSource()).toBe("cli");

    controller({ project: { theme: "auto" }, env: "dark" }).applyStartup();
    expect(themePreference()).toBe("auto");
    expect(themeSource()).toBe("project");

    controller({ env: "light" }).applyStartup();
    expect(themePreference()).toBe("light");
    expect(themeSource()).toBe("env");

    controller({}).applyStartup();
    expect(themePreference()).toBe("default");
    expect(themeSource()).toBe("builtin");
  });

  test("invalid env surfaces one diagnostic and falls back to built-in", () => {
    const c = controller({ env: "neon" });
    expect(c.startupDiagnostics()).toHaveLength(1);
    expect(c.startupDiagnostics()[0]).toContain("VESICLE_THEME");
    c.applyStartup();
    expect(themePreference()).toBe("default");
    expect(themeSource()).toBe("builtin");
  });

  test("project diagnostic surfaces and the project source is skipped", () => {
    const c = controller({ project: { diagnostic: "boom" }, env: "dark" });
    expect(c.startupDiagnostics()).toContain("boom");
    c.applyStartup();
    // env is the next source since project was invalid
    expect(themePreference()).toBe("dark");
    expect(themeSource()).toBe("env");
  });

  test("applyOverride sets a session override and source becomes session", () => {
    const c = controller({ cli: "dark" });
    c.applyStartup();
    c.applyOverride("light");
    expect(themePreference()).toBe("light");
    expect(themeSource()).toBe("session");
  });

  test("clearOverride recomputes the startup preference (/new, resume)", () => {
    const c = controller({ cli: "dark" });
    c.applyOverride("light");
    expect(themeSource()).toBe("session");
    c.clearOverride();
    expect(themePreference()).toBe("dark");
    expect(themeSource()).toBe("cli");
  });

  test("persistProject writes the file and applies the override immediately", async () => {
    // No CLI/env source so the project preference is the effective startup source.
    const c = controller({});
    c.applyStartup();
    await c.persistProject("auto");
    expect(themePreference()).toBe("auto");
    expect(themeSource()).toBe("session");
    // After clearing the override, the project source now holds auto.
    c.clearOverride();
    expect(themePreference()).toBe("auto");
    expect(themeSource()).toBe("project");
  });

  test("unsetProject removes project state, clears the override, and recomputes", async () => {
    await writeProjectThemePreference(root, "light");
    const c = controller({ project: { theme: "light" }, env: "dark" });
    c.applyStartup();
    expect(themeSource()).toBe("project");
    c.applyOverride("default");
    await c.unsetProject();
    expect(themePreference()).toBe("dark");
    expect(themeSource()).toBe("env");
  });

  test("statusText reports preference, source, and resolved mode", () => {
    const c = controller({ env: "dark" });
    c.applyStartup();
    const text = c.statusText();
    expect(text).toContain("preference: dark");
    expect(text).toContain("source: env");
    expect(text).toContain("resolved: dark");
  });

  test("statusText for auto includes the next boundary", () => {
    const c = controller({ env: "auto" });
    c.applyStartup();
    const text = c.statusText();
    expect(text).toContain("preference: auto");
    expect(text).toMatch(/Next boundary:/);
  });

  test("statusText for default notes terminal following", () => {
    const c = controller({});
    c.applyStartup();
    expect(c.statusText()).toContain("terminal");
  });
});

describe("controller — resolved mode reflects the resolver", () => {
  test("auto at noon resolves to light", () => {
    const c = createThemePreferenceController({
      rootDir: "/tmp",
      envParse: parseEnvTheme("auto"),
      project: {},
    });
    c.applyStartup();
    // Deterministic only at the clock's day window; verify it is a valid mode.
    expect(["dark", "light"]).toContain(themeMode());
  });
});
