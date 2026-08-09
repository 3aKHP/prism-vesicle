// vesicle config show / path / validate — read-only operations.
// `show env` sanitizes all values: every variable is reported as <set> or
// <empty>; the proxy URL shows structure without credentials. No secret value
// ever reaches stdout.

import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { userConfigDirectory } from "../../../config/paths";
import { providerConfigPathFromEnv, loadProviderRegistry } from "../../../config/providers";
import { permissionSettingsPath, loadPermissionSettings } from "../../../config/permissions";
import { qualitySettingsPath, loadExperimentalQualitySettings } from "../../../config/quality";
import { settingsPath, loadSettings } from "../../../config/settings";
import { projectPreferencesPath, readProjectThemePreference } from "../../../config/project-preferences";
import { mcpConfigPathFromEnv, loadMcpConfig } from "../../../mcp/config";

const SHOW_TARGETS = ["providers", "env", "permissions", "mcp", "quality", "settings", "preferences"] as const;
type ShowTarget = (typeof SHOW_TARGETS)[number];

export function runPath(): void {
  console.log(userConfigDirectory());
}

export async function runShow(target: string): Promise<void> {
  if (!SHOW_TARGETS.includes(target as ShowTarget)) {
    console.error(`Unknown config target "${target}". Available: ${SHOW_TARGETS.join(", ")}.`);
    process.exitCode = 1;
    return;
  }
  switch (target as ShowTarget) {
    case "providers":
      await showFile("providers.yaml", providerConfigPathFromEnv());
      break;
    case "env":
      await showEnvSanitized();
      break;
    case "permissions":
      await showFile("permissions.yaml", permissionSettingsPath());
      break;
    case "mcp":
      await showFile("mcp.yaml", mcpConfigPathFromEnv());
      break;
    case "quality":
      await showFile("quality.yaml", qualitySettingsPath());
      break;
    case "settings":
      await showFile("settings.yaml", settingsPath());
      break;
    case "preferences":
      await showFile("preferences.yaml (project)", projectPreferencesPath(process.cwd()));
      break;
  }
}

async function showFile(label: string, path: string): Promise<void> {
  let source: string;
  try {
    source = await readFile(path, "utf8");
  } catch (error) {
    if (isEnoent(error)) {
      console.log(`# ${label}: not configured (${path})`);
      return;
    }
    throw error;
  }
  console.log(`# ${label} (${path})`);
  console.log(source);
}

async function showEnvSanitized(): Promise<void> {
  const envPath = join(dirname(providerConfigPathFromEnv()), ".env");
  let source: string;
  try {
    source = await readFile(envPath, "utf8");
  } catch (error) {
    if (isEnoent(error)) {
      console.log(`# .env: not configured (${envPath})`);
      return;
    }
    throw error;
  }
  console.log(`# .env — sanitized view (${envPath})`);
  console.log("# Secret values are never displayed. <set> = has value, <empty> = no value.");
  console.log("");
  for (const raw of source.split(/\r?\n/)) {
    const trimmed = raw.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      console.log(raw);
      continue;
    }
    const equals = trimmed.indexOf("=");
    if (equals === -1) {
      console.log(raw);
      continue;
    }
    const key = trimmed.slice(0, equals).trim();
    const value = trimmed.slice(equals + 1).trim();
    if (key === "VESICLE_PROVIDER_PROXY") {
      console.log(value ? `${key}=${maskProxyUrl(value)}` : `${key}=<empty>`);
    } else {
      console.log(value ? `${key}=<set>` : `${key}=<empty>`);
    }
  }
}

function maskProxyUrl(url: string): string {
  try {
    const parsed = new URL(url);
    const auth = parsed.username ? "<credentials>@" : "";
    return `${parsed.protocol}//${auth}${parsed.host}`;
  } catch {
    return "<invalid-url>";
  }
}

export async function runValidate(): Promise<void> {
  const results: Array<{ file: string; ok: boolean; detail: string }> = [];

  try {
    const registry = await loadProviderRegistry();
    results.push({ file: "providers.yaml", ok: true, detail: `${registry.providers.length} provider(s), default: ${registry.default.provider}/${registry.default.model}` });
  } catch (error) {
    results.push({ file: "providers.yaml", ok: false, detail: messageOf(error) });
  }

  try {
    const envPath = join(dirname(providerConfigPathFromEnv()), ".env");
    const source = await readFile(envPath, "utf8").catch((error: unknown) => {
      if (isEnoent(error)) return undefined;
      throw error;
    });
    if (source === undefined) {
      results.push({ file: ".env", ok: true, detail: "not configured" });
    } else {
      const keys = source.split(/\r?\n/).filter((line) => /^[A-Za-z_][A-Za-z0-9_]*=/.test(line.trim())).length;
      results.push({ file: ".env", ok: true, detail: `${keys} variable(s) defined` });
    }
  } catch (error) {
    results.push({ file: ".env", ok: false, detail: messageOf(error) });
  }

  try {
    const settings = await loadPermissionSettings();
    results.push({
      file: "permissions.yaml",
      ok: true,
      detail: settings.exists
        ? `defaultMode=${settings.defaultMode}, shellExec=${settings.shellExec}, shellInterpreter=${settings.shellInterpreter}`
        : "not configured (using defaults)",
    });
  } catch (error) {
    results.push({ file: "permissions.yaml", ok: false, detail: messageOf(error) });
  }

  try {
    const mcp = await loadMcpConfig();
    results.push({
      file: "mcp.yaml",
      ok: true,
      detail: mcp.configured ? `${mcp.config.servers.length} server(s)` : "not configured",
    });
  } catch (error) {
    results.push({ file: "mcp.yaml", ok: false, detail: messageOf(error) });
  }

  try {
    const quality = await loadExperimentalQualitySettings();
    results.push({
      file: "quality.yaml",
      ok: true,
      detail: quality.exists ? `mode=${quality.mode}` : "not configured (mode=off)",
    });
  } catch (error) {
    results.push({ file: "quality.yaml", ok: false, detail: messageOf(error) });
  }

  try {
    const settings = await loadSettings();
    results.push({
      file: "settings.yaml",
      ok: true,
      detail: settings.exists ? (settings.editor ? `editor=${settings.editor}` : "configured, no editor set") : "not configured",
    });
  } catch (error) {
    results.push({ file: "settings.yaml", ok: false, detail: messageOf(error) });
  }

  try {
    const prefs = await readProjectThemePreference(process.cwd());
    if (prefs.ok) {
      const parts: string[] = [];
      if (prefs.theme) parts.push(`theme=${prefs.theme}`);
      if (prefs.mcpOutputPersistence) parts.push("mcpOutputPersistence=true");
      if (prefs.mcpOutputAutoTruncate) parts.push("mcpOutputAutoTruncate=true");
      results.push({ file: "preferences.yaml (project)", ok: true, detail: parts.length > 0 ? parts.join(", ") : "not configured" });
    } else {
      results.push({ file: "preferences.yaml (project)", ok: false, detail: prefs.diagnostic });
    }
  } catch (error) {
    results.push({ file: "preferences.yaml (project)", ok: false, detail: messageOf(error) });
  }

  const failed = results.filter((result) => !result.ok);
  const envelope = {
    ok: failed.length === 0,
    configDir: userConfigDirectory(),
    results,
    ...(failed.length > 0 ? { failedCount: failed.length } : {}),
  };
  console.log(JSON.stringify(envelope, null, 2));
  if (failed.length > 0) process.exitCode = 1;
}

function isEnoent(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && (error as { code: string }).code === "ENOENT");
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
