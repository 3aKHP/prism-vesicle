import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { userConfigDirectory } from "./paths";
import { atomicWrite, safeUnlink } from "./atomic-write";

/**
 * User-level `settings.yaml` — a new, deliberately tiny user config file that
 * holds host preferences not tied to a provider or a permission. It uses the
 * same key:value line-reader as `providers.yaml` / `permissions.yaml`
 * (comments with `#`, values may be quoted). B5 reads only `editor`; the file
 * is the reserved home for future user settings (#86 theme persistence, …),
 * so unknown fields are ignored rather than rejected.
 */

/** Settings fields the CLI may set/unset; shared by set and unset commands. */
export const SETTINGS_KEYS = ["editor", "sessionTitle"] as const;
export type SettingsKey = (typeof SETTINGS_KEYS)[number];
export type SessionTitlePreference = "auto" | "off";

export type Settings = {
  /** Raw external-editor command line (e.g. `code --wait`, `nano`), if set. */
  editor?: string;
  /** Automatic first-turn session title generation. Defaults to auto. */
  sessionTitle?: SessionTitlePreference;
  /** Whether the file existed on disk (false → no settings.yaml yet). */
  exists: boolean;
  path: string;
};

export function settingsPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(userConfigDirectory(env), "settings.yaml");
}

export async function loadSettings(env: NodeJS.ProcessEnv = process.env): Promise<Settings> {
  const path = settingsPath(env);
  let source: string;
  try {
    source = await readFile(path, "utf8");
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && (error as { code: string }).code === "ENOENT") {
      return { exists: false, sessionTitle: "auto", path };
    }
    throw error;
  }
  const values = new Map<string, string>();
  for (const [index, raw] of source.split(/\r?\n/).entries()) {
    const line = raw.replace(/\s+#.*$/, "").trim();
    if (!line || line.startsWith("#")) continue;
    const colon = line.indexOf(":");
    if (colon < 1) throw new Error(`settings.yaml line ${index + 1} must be key: value.`);
    const key = line.slice(0, colon).trim();
    const value = line.slice(colon + 1).trim().replace(/^(['"])(.*)\1$/, "$2");
    values.set(key, value);
  }
  const version = values.get("version");
  if (version !== undefined && version !== "1") {
    throw new Error(`settings.yaml: unsupported version "${version}" (expected "1").`);
  }
  const editor = values.get("editor");
  const rawTitle = values.get("sessionTitle");
  if (rawTitle !== undefined && rawTitle !== "auto" && rawTitle !== "off") {
    throw new Error(`settings.yaml: sessionTitle must be auto or off (found "${rawTitle}").`);
  }
  return { editor: editor && editor.length > 0 ? editor : undefined, sessionTitle: (rawTitle as SessionTitlePreference | undefined) ?? "auto", exists: true, path };
}

/**
 * Remove one settings key by dropping only its line, preserving every other
 * field and comment for forward compatibility. The file is removed when no
 * non-version content remains. Returns true when the key was present with a
 * value and removed, false when it was absent or empty (a no-op). Malformed
 * or unsupported-version files are refused via loadSettings.
 */
export async function unsetSettingsKey(key: SettingsKey, env: NodeJS.ProcessEnv = process.env): Promise<boolean> {
  const path = settingsPath(env);
  // Refuse to touch a malformed or unsupported-version file (e.g. written by
  // a newer Vesicle): parse first and let loadSettings throw.
  const settings = await loadSettings(env);
  if (!settings.exists) return false;
  if (settings[key] === undefined) return false;

  const source = await readFile(path, "utf8");
  const keyPattern = new RegExp(`^\\s*${key}\\s*:`);
  const remaining = source.split(/\r?\n/).filter((line) => !keyPattern.test(line));

  const hasContent = remaining.some((line) => {
    const trimmed = line.trim();
    return trimmed && !trimmed.startsWith("#") && !/^version\s*:/.test(trimmed);
  });
  if (!hasContent) {
    await safeUnlink(path);
    return true;
  }

  await atomicWrite(path, `${remaining.join("\n")}\n`);
  return true;
}
