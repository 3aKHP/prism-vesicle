import { lstat, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import type { Stats } from "node:fs";
import { dirname, join } from "node:path";
import { readYamlKeyValue, readYamlLines } from "./yaml-line-reader";
import type { ThemePreference } from "../tui/theme";

/**
 * Project-local `.vesicle/preferences.yaml` — version 1. This is local ignored
 * host state (not tracked collaborative configuration): it holds UI preferences
 * tied to a working directory. Version 1 stores the `theme` field and the
 * optional `mcpOutputPersistence` field.
 *
 * Schema rules (plan §8.1):
 *   - `version: 1` is required when the file exists.
 *   - `theme` is optional and accepts exactly dark, light, default, or auto.
 *   - An absent `theme` means no project override.
 *   - `mcpOutputPersistence` is optional (true/false, defaults false) and enables
 *     persisting MCP tool-call outputs under `tmp/mcp-output/<sessionId>/`.
 *   - No secrets, URLs, provider definitions, permissions, shell settings, or
 *     arbitrary environment values.
 *   - Unknown fields are invalid: startup warns and falls back; write commands
 *     refuse to clobber an invalid existing file.
 *
 * Path/symlink/atomic-write behaviour (plan §8.3):
 *   - A symlink at the exact preference path is rejected on read and write.
 *   - Writes create `.vesicle/` when needed, write a sibling temp, and rename.
 *   - Removing the last supported field may remove the file; `.vesicle/` itself
 *     and unrelated project state are never removed.
 */

export const PROJECT_PREFERENCES_VERSION = 1;
const VALID_THEMES: readonly ThemePreference[] = ["dark", "light", "default", "auto"];

export type ProjectPreferencesRead =
  | { ok: true; theme?: ThemePreference; mcpOutputPersistence?: boolean; path: string }
  | { ok: false; diagnostic: string; path: string };

export function projectPreferencesPath(rootDir: string): string {
  return join(rootDir, ".vesicle", "preferences.yaml");
}

/**
 * Read the project theme preference. A missing file is `ok` with no theme
 * (no override); a symlink, malformed, unsupported-version, unknown-field, or
 * invalid-theme file is `ok: false` with one bounded diagnostic so the caller
 * can surface it and fall back to lower-priority sources.
 */
export async function readProjectThemePreference(rootDir: string): Promise<ProjectPreferencesRead> {
  const path = projectPreferencesPath(rootDir);
  let stats: Stats;
  try {
    stats = await lstat(path);
  } catch (error) {
    if (isEnoent(error)) return { ok: true, path };
    // A permission/loop error on the project preference path must not crash
    // TUI startup (plan §6.3: project config is optional and recoverable).
    return { ok: false, diagnostic: `Could not stat ${rel(path, rootDir)}: ${messageOf(error)}.`, path };
  }
  if (stats.isSymbolicLink()) {
    return { ok: false, diagnostic: `${rel(path, rootDir)} is a symbolic link; ignoring project theme preference.`, path };
  }
  let source: string;
  try {
    source = await readFile(path, "utf8");
  } catch (error) {
    if (isEnoent(error)) return { ok: true, path };
    return { ok: false, diagnostic: `Could not read ${rel(path, rootDir)}: ${messageOf(error)}.`, path };
  }
  const parsed = parsePreferencesSource(source, path, rootDir);
  return parsed;
}

function parsePreferencesSource(source: string, path: string, rootDir: string): ProjectPreferencesRead {
  const display = rel(path, rootDir);
  const lines = readYamlLines(source);
  const map = new Map<string, { value: string; line: number }>();
  try {
    for (const line of lines) {
      const [key, value] = readYamlKeyValue(line.text, line.number, path, "preferences.yaml");
      if (map.has(key)) {
        return { ok: false, diagnostic: `${display} line ${line.number}: duplicate field "${key}".`, path };
      }
      map.set(key, { value, line: line.number });
    }
  } catch (error) {
    return { ok: false, diagnostic: messageOf(error), path };
  }
  for (const key of map.keys()) {
    if (key !== "version" && key !== "theme" && key !== "mcpOutputPersistence") {
      return { ok: false, diagnostic: `${display}: unknown field "${key}". Only "version", "theme", and "mcpOutputPersistence" are allowed.`, path };
    }
  }
  const version = map.get("version");
  if (version === undefined) {
    return { ok: false, diagnostic: `${display}: missing required "version: 1".`, path };
  }
  if (version.value !== String(PROJECT_PREFERENCES_VERSION)) {
    return { ok: false, diagnostic: `${display}: unsupported version "${version.value}" (expected "${PROJECT_PREFERENCES_VERSION}").`, path };
  }
  const theme = map.get("theme");
  if (theme && !VALID_THEMES.includes(theme.value as ThemePreference)) {
    return { ok: false, diagnostic: `${display}: invalid theme "${theme.value}". Expected one of dark, light, default, auto.`, path };
  }
  const mcpOutputPersistence = map.get("mcpOutputPersistence");
  if (mcpOutputPersistence && mcpOutputPersistence.value !== "true" && mcpOutputPersistence.value !== "false") {
    return { ok: false, diagnostic: `${display}: invalid mcpOutputPersistence "${mcpOutputPersistence.value}". Expected true or false.`, path };
  }
  return {
    ok: true,
    path,
    theme: theme?.value as ThemePreference | undefined,
    mcpOutputPersistence: mcpOutputPersistence?.value === "true",
  };
}

/**
 * Atomically write the project theme preference. Refuses a symlink target,
 * refuses to clobber a malformed/invalid existing file, and creates `.vesicle/`
 * when needed. The temp name is unique per process so two Vesicle instances do
 * not collide; last-atomic-rename-wins is the documented race semantics.
 */
export async function writeProjectThemePreference(rootDir: string, theme: ThemePreference): Promise<void> {
  const path = projectPreferencesPath(rootDir);
  await rejectSymlinkTarget(path, rootDir);
  const existing = await readProjectThemePreference(rootDir);
  if (!existing.ok) {
    throw new Error(`Refusing to overwrite malformed ${rel(path, rootDir)}: ${existing.diagnostic}`);
  }
  // Round-trip mcpOutputPersistence: writing the theme must not wipe an
  // existing MCP-output-persistence toggle (users edit the file by hand).
  const lines = [`version: ${PROJECT_PREFERENCES_VERSION}`, `theme: ${theme}`];
  if (existing.mcpOutputPersistence) lines.push("mcpOutputPersistence: true");
  await atomicWrite(path, `${lines.join("\n")}\n`);
}

/**
 * Read the project MCP-output-persistence toggle. Absent, malformed, or
 * unreadable preferences default to off (persistence is opt-in). Used by the
 * agent-loop bootstrap paths to gate MCP tool-result spill (#137B).
 */
export async function readMcpOutputPersistence(rootDir: string): Promise<boolean> {
  const read = await readProjectThemePreference(rootDir);
  return read.ok ? read.mcpOutputPersistence === true : false;
}

/**
 * Remove the project theme preference. Other preference fields (e.g.
 * `mcpOutputPersistence`) are preserved: the file is removed only when no
 * preference field remains. The `.vesicle/` directory and unrelated state are
 * left untouched. Refuses to modify a malformed file. Removing an already-absent
 * theme is a no-op.
 */
export async function unsetProjectThemePreference(rootDir: string): Promise<void> {
  const path = projectPreferencesPath(rootDir);
  const existing = await readProjectThemePreference(rootDir);
  if (!existing.ok) {
    throw new Error(`Refusing to modify malformed ${rel(path, rootDir)}: ${existing.diagnostic}`);
  }
  if (existing.theme === undefined) return;
  if (existing.mcpOutputPersistence) {
    await rejectSymlinkTarget(path, rootDir);
    await atomicWrite(path, `version: ${PROJECT_PREFERENCES_VERSION}\nmcpOutputPersistence: true\n`);
    return;
  }
  await safeUnlink(path);
}

async function rejectSymlinkTarget(path: string, rootDir: string): Promise<void> {
  try {
    const info = await lstat(path);
    if (info.isSymbolicLink()) {
      throw new Error(`Refusing to write: ${rel(path, rootDir)} is a symbolic link.`);
    }
  } catch (error) {
    if (!isEnoent(error)) throw error;
  }
}

async function atomicWrite(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  await writeFile(tmp, content, "utf8");
  try {
    await rename(tmp, path);
  } catch (error) {
    await safeUnlink(tmp);
    throw error;
  }
}

async function safeUnlink(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch (error) {
    if (isEnoent(error)) return;
    throw error;
  }
}

function isEnoent(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && (error as { code: string }).code === "ENOENT");
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function rel(path: string, rootDir: string): string {
  return path.startsWith(`${rootDir}/`) ? path.slice(rootDir.length + 1) : path;
}
