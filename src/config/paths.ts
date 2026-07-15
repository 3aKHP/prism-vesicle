import { homedir } from "node:os";
import { dirname, join } from "node:path";

/** Resolve Vesicle's user-level configuration directory on the active host. */
export function userConfigDirectory(env: NodeJS.ProcessEnv = process.env): string {
  if (env.VESICLE_PROVIDERS_FILE) return dirname(env.VESICLE_PROVIDERS_FILE);
  if (env.VESICLE_CONFIG_DIR) return env.VESICLE_CONFIG_DIR;
  if (env.APPDATA) return join(env.APPDATA, "prism-vesicle");
  if (env.XDG_CONFIG_HOME) return join(env.XDG_CONFIG_HOME, "prism-vesicle");
  return join(homedir(), ".config", "prism-vesicle");
}
