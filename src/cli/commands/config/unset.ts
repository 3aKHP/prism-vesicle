// vesicle config unset — remove a key from a flat YAML config file.
// The unset semantics live in the owning config modules; this command only
// routes arguments and reports the JSON envelope.

import {
  projectPreferencesPath,
  unsetProjectPreference,
  PROJECT_PREFERENCE_KEYS,
} from "../../../config/project-preferences";
import { settingsPath, unsetSettingsKey, SETTINGS_KEYS } from "../../../config/settings";

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
  preferences: PROJECT_PREFERENCE_KEYS,
  settings: SETTINGS_KEYS,
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
    case "preferences": {
      const rootDir = process.cwd();
      const path = projectPreferencesPath(rootDir);
      const removed = await unsetProjectPreference(rootDir, key as (typeof PROJECT_PREFERENCE_KEYS)[number]);
      return { ok: true, operation: "unset", file, key, path, removed, restartRequired: false };
    }
    case "settings": {
      const path = settingsPath();
      const removed = await unsetSettingsKey(key as (typeof SETTINGS_KEYS)[number]);
      return { ok: true, operation: "unset", file, key, path, removed, restartRequired: removed };
    }
    default:
      throw new Error(`Unsupported unset file "${file}".`);
  }
}
