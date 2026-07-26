import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { builtinCommands } from "../../../src/tui/commands/builtin";
import type { CommandContext } from "../../../src/tui/commands/types";
import type { ThemePreferenceController } from "../../../src/tui/theme-preference-controller";
import { createThemePreferenceController, parseEnvTheme } from "../../../src/tui/theme-preference-controller";
import { projectPreferencesPath, readProjectThemePreference } from "../../../src/config/project-preferences";
import { reportTerminalThemeMode, setThemePreference, themePreference, themeSource } from "../../../src/tui/theme";
import type { Message } from "../../../src/tui/types";

afterEach(() => {
  setThemePreference("default", "builtin");
  reportTerminalThemeMode(null);
});

describe("/theme command grammar", () => {
  let root: string;
  let controller: ThemePreferenceController;
  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "vesicle-theme-cmd-"));
    controller = createThemePreferenceController({
      rootDir: root,
      envParse: parseEnvTheme("dark"),
      project: {},
    });
    controller.applyStartup();
  });
  afterAll(async () => { await rm(root, { recursive: true, force: true }); });

  function buildContext(): { ctx: CommandContext; messages: () => Message[] } {
    let messages: Message[] = [];
    const ctx = {
      setMessages(updater: (previous: Message[]) => Message[]) { messages = updater(messages); },
      setStatus() {},
      recordActivity() {},
      theme: {
        statusText: () => controller.statusText(),
        applyOverride: (pref: never) => controller.applyOverride(pref),
        clearOverride: () => controller.clearOverride(),
        persistProject: (pref: never) => controller.persistProject(pref),
        unsetProject: () => controller.unsetProject(),
      },
    } as unknown as CommandContext;
    return { ctx, messages: () => messages };
  }

  async function runTheme(args: string): Promise<Message[]> {
    const command = builtinCommands.find((entry) => entry.name === "theme");
    if (!command) throw new Error("Missing /theme command.");
    const { ctx, messages } = buildContext();
    await command.run(ctx, args, args ? `/theme ${args}` : "/theme");
    return messages();
  }

  test("bare /theme reports preference, source, and resolved mode", async () => {
    const messages = await runTheme("");
    const status = messages.at(-1)!.content;
    expect(status).toContain("preference: dark");
    expect(status).toContain("source: env");
    expect(status).toContain("resolved: dark");
  });

  test("a valid transient preference applies without disk mutation", async () => {
    const messages = await runTheme("light");
    expect(themePreference()).toBe("light");
    expect(themeSource()).toBe("session");
    expect(messages.at(-1)!.content).toContain("light");
    await expect(readProjectThemePreference(root)).resolves.toMatchObject({ ok: true });
  });

  test("an unknown preference is a usage error with no mutation", async () => {
    setThemePreference("dark", "env");
    const messages = await runTheme("neon");
    expect(messages.at(-1)!.content).toContain("Usage:");
    expect(themePreference()).toBe("dark");
  });

  test("--persist writes the project file and applies the override", async () => {
    const messages = await runTheme("auto --persist");
    expect(messages.at(-1)!.content).toContain("saved to .vesicle/preferences.yaml");
    expect(themePreference()).toBe("auto");
    expect(themeSource()).toBe("session");
    const read = await readProjectThemePreference(root);
    expect(read.ok && read.theme).toBe("auto");
  });

  test("repeated --persist is a usage error with no mutation", async () => {
    const before = await readFileText(projectPreferencesPath(root));
    const messages = await runTheme("dark --persist --persist");
    expect(messages.at(-1)!.content).toContain("Usage:");
    const after = await readFileText(projectPreferencesPath(root));
    expect(after).toBe(before);
  });

  test("--unset-project combined with a preference is a usage error", async () => {
    const messages = await runTheme("dark --unset-project");
    expect(messages.at(-1)!.content).toContain("Usage:");
  });

  test("--unset-project removes the project theme and clears the override", async () => {
    await runTheme("light --persist");
    const before = await readProjectThemePreference(root);
    expect(before.ok && before.theme).toBe("light");
    const messages = await runTheme("--unset-project");
    expect(messages.at(-1)!.content).toContain("Removed the project theme preference");
    const read = await readProjectThemePreference(root);
    expect(read.ok && read.theme).toBeUndefined();
  });

  test("extra arguments are a usage error", async () => {
    const messages = await runTheme("dark light");
    expect(messages.at(-1)!.content).toContain("Usage:");
  });
});

async function readFileText(path: string): Promise<string | undefined> {
  try {
    const { readFile } = await import("node:fs/promises");
    return await readFile(path, "utf8");
  } catch {
    return undefined;
  }
}
