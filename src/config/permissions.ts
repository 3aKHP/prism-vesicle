import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { permissionModes, type PermissionMode } from "../core/permissions";
import {
  shellInterpreterPreferences,
  type ShellInterpreterPreference,
} from "../core/process/shell-profile";
import { userConfigDirectory } from "./paths";

export type PermissionSettings = {
  defaultMode: PermissionMode;
  shellExec: boolean;
  shellInterpreter: ShellInterpreterPreference;
  path: string;
  exists: boolean;
};

export function permissionSettingsPath(env: NodeJS.ProcessEnv = process.env): string {
  if (env.VESICLE_PERMISSIONS_FILE) return env.VESICLE_PERMISSIONS_FILE;
  return join(userConfigDirectory(env), "permissions.yaml");
}

export async function loadPermissionSettings(env: NodeJS.ProcessEnv = process.env): Promise<PermissionSettings> {
  const path = permissionSettingsPath(env);
  let source: string;
  try {
    source = await readFile(path, "utf8");
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return { defaultMode: "MOMENTUM", shellExec: false, shellInterpreter: "auto", path, exists: false };
    }
    throw error;
  }
  const values = new Map<string, string>();
  for (const [index, raw] of source.split(/\r?\n/).entries()) {
    const line = raw.replace(/\s+#.*$/, "").trim();
    if (!line || line.startsWith("#")) continue;
    const colon = line.indexOf(":");
    if (colon < 1) throw new Error(`permissions.yaml line ${index + 1} must be key: value.`);
    values.set(line.slice(0, colon).trim(), line.slice(colon + 1).trim().replace(/^(['"])(.*)\1$/, "$2"));
  }
  for (const key of values.keys()) {
    if (key !== "version" && key !== "defaultMode" && key !== "shellExec" && key !== "shellInterpreter") {
      throw new Error(`Unknown permissions.yaml field: ${key}.`);
    }
  }
  if (values.get("version") !== "1") throw new Error("permissions.yaml requires version: 1.");
  const mode = (values.get("defaultMode") ?? "MOMENTUM").toUpperCase() as PermissionMode;
  if (!permissionModes.includes(mode)) throw new Error(`Invalid permissions defaultMode: ${mode}.`);
  if (mode === "YOLO") throw new Error("YOLO cannot be configured as defaultMode; enable it interactively or use --dangerously-skip-permissions.");
  const shell = values.get("shellExec") ?? "false";
  if (shell !== "true" && shell !== "false") throw new Error("permissions shellExec must be true or false.");
  const shellInterpreter = values.get("shellInterpreter") ?? "auto";
  if (!shellInterpreterPreferences.includes(shellInterpreter as ShellInterpreterPreference)) {
    throw new Error(`Invalid permissions shellInterpreter: ${shellInterpreter}. Available: ${shellInterpreterPreferences.join(", ")}.`);
  }
  return {
    defaultMode: mode,
    shellExec: shell === "true",
    shellInterpreter: shellInterpreter as ShellInterpreterPreference,
    path,
    exists: true,
  };
}
