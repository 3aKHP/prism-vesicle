import type { Settings } from "../../config/settings";

/**
 * External-editor handoff for the Workspace page (Scope B / #62, milestone
 * B5 §6). Ctrl+X suspends the OpenTUI renderer (it drops raw mode, detaches
 * stdin, disables the mouse), spawns the user's `$EDITOR` over the inherited
 * tty, awaits its exit, and resumes the renderer. Refresh + revalidation back
 * in the controller reacts to whatever the editor did to the file.
 *
 * The renderer primitives (`suspend`, `resume`, `spawn`) are injected so the
 * orchestration is unit-testable without a real terminal; the component wires
 * the real `CliRenderer` and `Bun.spawn`.
 */

export type EditorRuntime = {
  suspend: () => void;
  resume: () => void;
  /** Spawn the resolved editor; resolve to its exit code. Reject on ENOENT. */
  spawn: (command: string, args: string[]) => Promise<number>;
};

export type ResolvedEditor = {
  /** The executable to run. */
  command: string;
  /** Extra argv before the file path (e.g. `["--wait"]` for `code --wait`). */
  args: string[];
  /** Where the resolution came from, for status-line messaging. */
  source: "VESICLE_EDITOR" | "settings" | "VISUAL" | "EDITOR" | "fallback";
};

/**
 * Resolve the external editor command. Order mirrors git's "specific-to-general"
 * convention: an explicit Vesicle override, the user-level settings file, the
 * classic visual/editor vars, then a platform default. Always returns — the
 * fallback is `vi` on POSIX, `notepad` on Windows — so a missing editor shows
 * up as an ENOENT at spawn time, surfaced by the caller.
 */
export function resolveEditorCommand(input: {
  env: NodeJS.ProcessEnv;
  settings: Settings;
  platform?: NodeJS.Platform;
}): ResolvedEditor {
  const { env, settings, platform = process.platform } = input;
  const candidates: Array<{ value: string | undefined; source: ResolvedEditor["source"] }> = [
    { value: env.VESICLE_EDITOR, source: "VESICLE_EDITOR" },
    { value: settings.editor, source: "settings" },
    { value: env.VISUAL, source: "VISUAL" },
    { value: env.EDITOR, source: "EDITOR" },
  ];
  for (const candidate of candidates) {
    const line = candidate.value?.trim();
    if (!line) continue;
    const parts = splitCommandLine(line);
    if (parts.length > 0) return { command: parts[0], args: parts.slice(1), source: candidate.source };
  }
  return platform === "win32"
    ? { command: "notepad", args: [], source: "fallback" }
    : { command: "vi", args: [], source: "fallback" };
}

/**
 * Split an editor command line into argv, honouring single and double quotes so
 * `code --wait`, `"C:\Program Files\vim\vim.exe"`, and `nano -B` all parse.
 * Pure function; no shell is involved (the path is appended as a separate argv
 * element, sidestepping quoting issues entirely).
 */
export function splitCommandLine(line: string): string[] {
  const parts: string[] = [];
  let current = "";
  let quote: '"' | "'" | null = null;
  for (const ch of line) {
    if (quote) {
      if (ch === quote) quote = null;
      else current += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (/\s/.test(ch)) {
      if (current.length > 0) {
        parts.push(current);
        current = "";
      }
    } else {
      current += ch;
    }
  }
  if (current.length > 0) parts.push(current);
  return parts;
}

/**
 * Run the resolved editor over `absPath`: suspend the renderer, spawn the
 * editor with the file path appended, await its exit, then resume (always —
 * the `finally` guarantees the renderer comes back even if the editor never
 * returns). The caller owns refresh + revalidation.
 */
export async function runExternalEditor(input: {
  absPath: string;
  editor: ResolvedEditor;
  runtime: EditorRuntime;
}): Promise<{ exitCode: number }> {
  const { absPath, editor, runtime } = input;
  runtime.suspend();
  try {
    const exitCode = await runtime.spawn(editor.command, [...editor.args, absPath]);
    return { exitCode };
  } finally {
    runtime.resume();
  }
}
