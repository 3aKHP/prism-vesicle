// vesicle config unset — remove a key from a flat YAML config file.
// Currently supports project preferences (theme, mcpOutputPersistence, mcpOutputAutoTruncate)
// and host settings (editor). Removing the last field from preferences removes the file.

import { mkdir, rename, rm, writeFile, unlink, readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname } from "node:path";
import {
  projectPreferencesPath,
  readProjectThemePreference,
  PROJECT_PREFERENCES_VERSION,
} from "../../../config/project-preferences";
import { settingsPath, loadSettings } from "../../../config/settings";

type UnsetResult = {
  ok: true;
  operation: "unset";
  file: string;
  key: string;
  path: string;
  removed: boolean;
  restartRequired: boolean;
};

const UNSETTABLE_FILES: Record<string, readonly string[]> = {
  preferences: ["theme", "mcpOutputPersistence", "mcpOutputAutoTruncate"],
  settings: ["editor"],
};

export async function runUnset(args: string[]): Promise<void> {
  if (args.length !== 2) {
    console.error("Usage: vesicle config unset <file> <key>");
    process.exitCode = 1;
    return;
  }
  const [file, key] = args;
  try {
    const result = await unset(file!, key!);
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

async function unset(file: string, key: string): Promise<UnsetResult> {
  const allowed = UNSETTABLE_FILES[file];
  if (!allowed) {
    throw new Error(`Cannot unset keys on "${file}". Unsettable files: ${Object.keys(UNSETTABLE_FILES).join(", ")}.`);
  }
  if (!allowed.includes(key)) {
    throw new Error(`Key "${key}" is not unsettable on ${file}. Allowed: ${allowed.join(", ")}.`);
  }

  switch (file) {
    case "preferences":
      return unsetPreference(key);
    case "settings":
      return unsetSettings(key);
    default:
      throw new Error(`Unsupported unset file "${file}".`);
  }
}

async function unsetPreference(key: string): Promise<UnsetResult> {
  const rootDir = process.cwd();
  const path = projectPreferencesPath(rootDir);
  const existing = await readProjectThemePreference(rootDir);
  if (!existing.ok) {
    throw new Error(`Refusing to modify malformed preferences: ${existing.diagnostic}`);
  }

  const hasTheme = existing.theme !== undefined;
  const hasPersist = existing.mcpOutputPersistence === true;
  const hasTruncate = existing.mcpOutputAutoTruncate === true;

  const wouldRemove =
    (key === "theme" && hasTheme)
    || (key === "mcpOutputPersistence" && hasPersist)
    || (key === "mcpOutputAutoTruncate" && hasTruncate);

  if (!wouldRemove) {
    return { ok: true, operation: "unset", file: "preferences", key, path, removed: false, restartRequired: false };
  }

  const newTheme = key === "theme" ? undefined : existing.theme;
  const newPersist = key === "mcpOutputPersistence" ? false : hasPersist;
  const newTruncate = key === "mcpOutputAutoTruncate" ? false : hasTruncate;

  if (!newTheme && !newPersist && !newTruncate) {
    await safeUnlink(path);
    return { ok: true, operation: "unset", file: "preferences", key, path, removed: true, restartRequired: false };
  }

  const lines = [`version: ${PROJECT_PREFERENCES_VERSION}`];
  if (newTheme) lines.push(`theme: ${newTheme}`);
  if (newPersist) lines.push("mcpOutputPersistence: true");
  if (newTruncate) lines.push("mcpOutputAutoTruncate: true");
  await atomicWrite(path, `${lines.join("\n")}\n`);

  return { ok: true, operation: "unset", file: "preferences", key, path, removed: true, restartRequired: false };
}

async function unsetSettings(key: string): Promise<UnsetResult> {
  const path = settingsPath();
  const existing = await loadSettings();
  if (key === "editor" && existing.editor === undefined) {
    return { ok: true, operation: "unset", file: "settings", key, path, removed: false, restartRequired: true };
  }

  // Read the existing source and drop only the target key line, preserving
  // any other fields and comments for forward compatibility.
  let source: string;
  try {
    source = await readFile(path, "utf8");
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && (error as { code: string }).code === "ENOENT") {
      return { ok: true, operation: "unset", file: "settings", key, path, removed: false, restartRequired: true };
    }
    throw error;
  }

  const keyPattern = new RegExp(`^\\s*${key}\\s*:`);
  const remaining = source.split(/\r?\n/).filter((line) => !keyPattern.test(line));
  const hasContent = remaining.some((line) => {
    const trimmed = line.trim();
    return trimmed && !trimmed.startsWith("#") && !/^version\s*:/.test(trimmed);
  });

  if (hasContent) {
    await atomicWrite(path, `${remaining.join("\n")}\n`);
  } else {
    await safeUnlink(path);
  }

  return { ok: true, operation: "unset", file: "settings", key, path, removed: true, restartRequired: true };
}

async function atomicWrite(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const staging = `${path}.staging-${randomUUID()}`;
  try {
    await writeFile(staging, content, { encoding: "utf8", flag: "wx", mode: 0o644 });
    await rename(staging, path);
  } finally {
    await rm(staging, { force: true });
  }
}

async function safeUnlink(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && (error as { code: string }).code === "ENOENT") return;
    throw error;
  }
}
