import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { userConfigDirectory } from "./paths";

/**
 * User-level `settings.yaml` — a new, deliberately tiny user config file that
 * holds host preferences not tied to a provider or a permission. It uses the
 * same key:value line-reader as `providers.yaml` / `permissions.yaml`
 * (comments with `#`, values may be quoted). B5 reads only `editor`; the file
 * is the reserved home for future user settings (#86 theme persistence, …),
 * so unknown fields are ignored rather than rejected.
 */

export type Settings = {
  /** Raw external-editor command line (e.g. `code --wait`, `nano`), if set. */
  editor?: string;
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
      return { exists: false, path };
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
  return { editor: editor && editor.length > 0 ? editor : undefined, exists: true, path };
}
