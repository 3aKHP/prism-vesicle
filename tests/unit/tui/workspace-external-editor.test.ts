import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  resolveEditorCommand,
  runExternalEditor,
  splitCommandLine,
  type EditorRuntime,
} from "../../../src/tui/workspace-external-editor";
import { loadSettings, settingsPath } from "../../../src/config/settings";

describe("splitCommandLine", () => {
  test("splits on whitespace, honouring single and double quotes", () => {
    expect(splitCommandLine("vim")).toEqual(["vim"]);
    expect(splitCommandLine("code --wait")).toEqual(["code", "--wait"]);
    expect(splitCommandLine('"C:\\Program Files\\vim.exe" -f')).toEqual(["C:\\Program Files\\vim.exe", "-f"]);
    expect(splitCommandLine("'my editor' --flag value")).toEqual(["my editor", "--flag", "value"]);
    expect(splitCommandLine("  nano   -B   ")).toEqual(["nano", "-B"]);
    expect(splitCommandLine("")).toEqual([]);
  });
});

describe("resolveEditorCommand priority", () => {
  const baseSettings = { exists: false, path: "<test>" };
  type CaseEnv = { VESICLE_EDITOR?: string; VISUAL?: string; EDITOR?: string };

  function resolve(env: CaseEnv, editor?: string, platform: NodeJS.Platform = "linux") {
    return resolveEditorCommand({
      env,
      settings: editor ? { editor, exists: true, path: "<test>" } : baseSettings,
      platform,
    });
  }

  test("VESICLE_EDITOR wins over everything", () => {
    const r = resolve({ VESICLE_EDITOR: "vim", VISUAL: "emacs", EDITOR: "nano" });
    expect(r.command).toBe("vim");
    expect(r.source).toBe("VESICLE_EDITOR");
  });

  test("settings.yaml editor beats VISUAL / EDITOR", () => {
    const r = resolve({ VISUAL: "emacs", EDITOR: "nano" }, "code --wait");
    expect(r.command).toBe("code");
    expect(r.args).toEqual(["--wait"]);
    expect(r.source).toBe("settings");
  });

  test("VISUAL beats EDITOR", () => {
    const r = resolve({ VISUAL: "emacs -nw", EDITOR: "nano" });
    expect(r.command).toBe("emacs");
    expect(r.args).toEqual(["-nw"]);
    expect(r.source).toBe("VISUAL");
  });

  test("EDITOR is used when nothing else is set", () => {
    const r = resolve({ EDITOR: "nano" });
    expect(r.command).toBe("nano");
    expect(r.source).toBe("EDITOR");
  });

  test("platform fallback: vi on POSIX, notepad on Windows", () => {
    expect(resolve({}, undefined, "linux").command).toBe("vi");
    expect(resolve({}, undefined, "win32").command).toBe("notepad");
  });

  test("a blank VESICLE_EDITOR falls through to the next source", () => {
    const r = resolve({ VESICLE_EDITOR: "   ", EDITOR: "nano" });
    expect(r.command).toBe("nano");
    expect(r.source).toBe("EDITOR");
  });
});

describe("runExternalEditor orchestration", () => {
  test("suspend → spawn (path appended) → resume in order, resume always runs", async () => {
    const calls: string[] = [];
    const runtime: EditorRuntime = {
      suspend: () => { calls.push("suspend"); },
      resume: () => { calls.push("resume"); },
      spawn: async (command, args) => {
        calls.push(`spawn:${command} ${args.join(" ")}`);
        return 0;
      },
    };
    const result = await runExternalEditor({
      absPath: "/tmp/file.md",
      editor: { command: "vim", args: ["-f"], source: "EDITOR" },
      runtime,
    });
    expect(result.exitCode).toBe(0);
    // The file path is appended after the editor's own args.
    expect(calls).toEqual(["suspend", "spawn:vim -f /tmp/file.md", "resume"]);
  });

  test("resume runs even if spawn throws (ENOENT)", async () => {
    const calls: string[] = [];
    const runtime: EditorRuntime = {
      suspend: () => { calls.push("suspend"); },
      resume: () => { calls.push("resume"); },
      spawn: async () => { calls.push("spawn"); throw new Error("ENOENT"); },
    };
    await expect(runExternalEditor({
      absPath: "/tmp/x",
      editor: { command: "no-such-editor", args: [], source: "fallback" },
      runtime,
    })).rejects.toThrow("ENOENT");
    expect(calls).toEqual(["suspend", "spawn", "resume"]);
  });
});

describe("settings.yaml load", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "vesicle-settings-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test("missing file → exists:false, no editor", async () => {
    const s = await loadSettings({ VESICLE_CONFIG_DIR: dir });
    expect(s.exists).toBe(false);
    expect(s.editor).toBeUndefined();
    expect(s.path).toBe(settingsPath({ VESICLE_CONFIG_DIR: dir }));
  });

  test("parses version + editor field, strips quotes, ignores comments", async () => {
    await writeFile(join(dir, "settings.yaml"), [
      "# user settings",
      "version: 1",
      'editor: "code --wait"',
      "",
    ].join("\n"));
    const s = await loadSettings({ VESICLE_CONFIG_DIR: dir });
    expect(s.exists).toBe(true);
    expect(s.editor).toBe("code --wait");
  });

  test("rejects an unsupported version", async () => {
    await writeFile(join(dir, "settings.yaml"), "version: 2\neditor: vim\n");
    await expect(loadSettings({ VESICLE_CONFIG_DIR: dir })).rejects.toThrow(/unsupported version/);
  });
});
