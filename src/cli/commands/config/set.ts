// vesicle config set — simple key-value writes for flat YAML config files.
// Each file type has a whitelist of settable keys. After writing, the file is
// re-parsed by its owning parser to confirm validity. All writes are atomic
// (temp file + rename) and output a single JSON result envelope.

import { readFile } from "node:fs/promises";
import { permissionSettingsPath, loadPermissionSettings } from "../../../config/permissions";
import { settingsPath, loadSettings, SETTINGS_KEYS } from "../../../config/settings";
import type { ProviderProfile } from "../../../config/providers";
import {
  readProtocol,
  readAuthMethod,
  readResponsesProfile,
  readResponsesTransport,
  readUserAgent,
} from "../../../config/providers";
import { replaceDefaultSelectionInSource, replaceProviderFieldInSource } from "../../../config/provider-source-edit";
import { yamlScalar } from "../../../config/yaml-writer";
import { editProviderRegistrySource } from "../../../setup/config-writer";
import { atomicWrite } from "../../../config/atomic-write";
import { loadExperimentalQualitySettings, writeExperimentalQualitySettings } from "../../../config/quality";
import type { ExperimentalQualityMode } from "../../../config/quality";
import { projectPreferencesPath, readProjectThemePreference, PROJECT_PREFERENCE_KEYS } from "../../../config/project-preferences";
import { permissionModes } from "../../../core/permissions";
import type { ThemePreference } from "../../../tui/theme";

type SettableFile = "permissions" | "preferences" | "quality" | "settings" | "providers";

const SETTABLE_KEYS: Record<SettableFile, readonly string[]> = {
  permissions: ["defaultMode", "shellExec"],
  preferences: PROJECT_PREFERENCE_KEYS,
  quality: ["mode"],
  settings: SETTINGS_KEYS,
  providers: ["default.provider", "default.model", "providers.<id>.<field>"],
};

const PROVIDER_ID_PATTERN = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;

export async function runSet(args: string[]): Promise<void> {
  const [file, key, ...valueParts] = args;
  const value = valueParts.join(" ");
  if (!file || !key || !value) {
    console.error("Usage: vesicle config set <file> <key> <value>");
    process.exitCode = 1;
    return;
  }
  if (!isSettableFile(file)) {
    console.error(`Cannot set keys on "${file}". Settable files: ${Object.keys(SETTABLE_KEYS).join(", ")}.`);
    process.exitCode = 1;
    return;
  }
  const allowed = SETTABLE_KEYS[file];
  if (!allowed.includes(key) && !(file === "providers" && isProviderFieldKey(key))) {
    console.error(`Key "${key}" is not settable on ${file}. Allowed: ${allowed.join(", ")}.`);
    process.exitCode = 1;
    return;
  }

  try {
    const result = await applySet(file, key, value);
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

function isProviderFieldKey(key: string): boolean {
  if (!key.startsWith("providers.")) return false;
  const rest = key.slice("providers.".length);
  const dotIndex = rest.indexOf(".");
  if (dotIndex <= 0) return false;
  const providerId = rest.slice(0, dotIndex);
  const field = rest.slice(dotIndex + 1);
  return PROVIDER_ID_PATTERN.test(providerId) && field.length > 0;
}

function isSettableFile(file: string): file is SettableFile {
  return file in SETTABLE_KEYS;
}

type SetResult = {
  ok: true;
  operation: "set";
  file: string;
  key: string;
  value: string;
  path: string;
  restartRequired: boolean;
};

async function applySet(file: SettableFile, key: string, value: string): Promise<SetResult> {
  switch (file) {
    case "permissions":
      return setPermissions(key, value);
    case "preferences":
      return setPreferences(key, value);
    case "quality":
      return setQuality(key, value);
    case "settings":
      return setSettings(key, value);
    case "providers":
      return setProviders(key, value);
  }
}

async function setPermissions(key: string, value: string): Promise<SetResult> {
  const path = permissionSettingsPath();
  if (key === "defaultMode") {
    const mode = value.toUpperCase();
    if (!permissionModes.includes(mode as (typeof permissionModes)[number])) {
      throw new Error(`Invalid defaultMode "${value}". Available: ${permissionModes.join(", ")}.`);
    }
    if (mode === "YOLO") {
      throw new Error("YOLO cannot be configured as defaultMode; enable it interactively or use --dangerously-skip-permissions.");
    }
  }
  if (key === "shellExec" && value !== "true" && value !== "false") {
    throw new Error("shellExec must be true or false.");
  }

  const current = await loadPermissionSettings();
  const source = [
    "version: 1",
    `defaultMode: ${key === "defaultMode" ? value.toUpperCase() : current.defaultMode}`,
    `shellExec: ${key === "shellExec" ? value : String(current.shellExec)}`,
    `shellInterpreter: ${current.shellInterpreter}`,
    "",
  ].join("\n");
  await atomicWrite(path, source);
  // Verify round-trip.
  await loadPermissionSettings();
  return { ok: true, operation: "set", file: "permissions", key, value, path, restartRequired: true };
}

async function setPreferences(key: string, value: string): Promise<SetResult> {
  const rootDir = process.cwd();
  const path = projectPreferencesPath(rootDir);
  const existing = await readProjectThemePreference(rootDir);
  if (!existing.ok) {
    throw new Error(`Refusing to modify malformed preferences: ${existing.diagnostic}`);
  }

  const VALID_THEMES: readonly string[] = ["dark", "light", "default", "auto"];
  let theme = existing.theme;
  let mcpOutputPersistence = existing.mcpOutputPersistence === true;
  let mcpOutputAutoTruncate = existing.mcpOutputAutoTruncate === true;

  if (key === "theme") {
    if (!VALID_THEMES.includes(value)) {
      throw new Error(`Invalid theme "${value}". Expected one of: ${VALID_THEMES.join(", ")}.`);
    }
    theme = value as ThemePreference;
  } else if (key === "mcpOutputPersistence") {
    if (value !== "true" && value !== "false") throw new Error("mcpOutputPersistence must be true or false.");
    mcpOutputPersistence = value === "true";
  } else if (key === "mcpOutputAutoTruncate") {
    if (value !== "true" && value !== "false") throw new Error("mcpOutputAutoTruncate must be true or false.");
    mcpOutputAutoTruncate = value === "true";
  }

  const lines = ["version: 1"];
  if (theme) lines.push(`theme: ${theme}`);
  if (mcpOutputPersistence) lines.push("mcpOutputPersistence: true");
  if (mcpOutputAutoTruncate) lines.push("mcpOutputAutoTruncate: true");
  await atomicWrite(path, `${lines.join("\n")}\n`);
  // Verify round-trip.
  const verify = await readProjectThemePreference(rootDir);
  if (!verify.ok) throw new Error(`Post-write validation failed: ${verify.diagnostic}`);
  return { ok: true, operation: "set", file: "preferences", key, value, path, restartRequired: false };
}

async function setQuality(key: string, value: string): Promise<SetResult> {
  if (key !== "mode") throw new Error(`Unknown quality key "${key}".`);
  const mode = value as ExperimentalQualityMode;
  if (mode !== "off" && mode !== "observe" && mode !== "rewrite") {
    throw new Error(`Invalid quality mode "${value}". Available: off, observe, rewrite.`);
  }
  const current = await loadExperimentalQualitySettings();
  if (mode !== "off" && (!current.providerAlias || !current.modelId || !current.judgeTimeoutMs)) {
    throw new Error(
      `Cannot set quality mode to "${mode}" without a Judge provider, model, and timeout. `
      + `Configure providerAlias, modelId, and judgeTimeoutMs in quality.yaml first, or use the /quality TUI command.`,
    );
  }
  await writeExperimentalQualitySettings({
    mode,
    providerAlias: current.providerAlias,
    modelId: current.modelId,
    judgeTimeoutMs: current.judgeTimeoutMs,
  });
  return { ok: true, operation: "set", file: "quality", key, value, path: current.path, restartRequired: true };
}

async function setSettings(key: string, value: string): Promise<SetResult> {
  if (key !== "editor" && key !== "sessionTitle") throw new Error(`Unknown settings key "${key}".`);
  if (key === "sessionTitle" && value !== "auto" && value !== "off") {
    throw new Error(`sessionTitle must be auto or off (found "${value}").`);
  }
  const path = settingsPath();
  const current = await loadSettings();
  const source = current.exists ? await readFile(path, "utf8") : "version: 1\n";
  const lines = source.split(/\r?\n/);
  const pattern = new RegExp(`^(\\s*)${key}(\\s*:)`);
  let replaced = false;
  const updated = lines.map((line) => {
    if (!pattern.test(line)) return line;
    replaced = true;
    return `${key}: ${value}`;
  });
  if (!replaced) {
    const insertAt = updated.length > 0 && updated.at(-1) === "" ? updated.length - 1 : updated.length;
    updated.splice(insertAt, 0, `${key}: ${value}`);
  }
  await atomicWrite(path, `${updated.join("\n").replace(/\n*$/, "")}\n`);
  // Verify round-trip.
  await loadSettings();
  return { ok: true, operation: "set", file: "settings", key, value, path, restartRequired: true };
}

async function setProviders(key: string, value: string): Promise<SetResult> {
  if (key === "default.provider" || key === "default.model") {
    return setProvidersDefault(key, value);
  }

  const match = /^providers\.([a-z0-9](?:[a-z0-9-]*[a-z0-9])?)\.(.+)$/.exec(key);
  if (!match) {
    throw new Error(`Key "${key}" is not settable on providers. Allowed: ${SETTABLE_KEYS.providers.join(", ")}.`);
  }
  const providerId = match[1]!;
  const field = match[2]!;
  return setProviderField(providerId, field, value);
}

const SETTABLE_PROVIDER_FIELDS: readonly string[] = [
  "protocol",
  "baseUrl",
  "apiKeyEnv",
  "authMethod",
  "responsesProfile",
  "responsesTransport",
  "userAgent",
  "defaultModel",
];

const PROTECTED_PROVIDER_FIELDS: readonly string[] = ["id", "models", "apiKey"];

async function setProviderField(providerId: string, field: string, value: string): Promise<SetResult> {
  const path = await editProviderRegistrySource((source, registry) => {
    const provider = registry.providers.find((entry) => entry.id === providerId);
    if (!provider) {
      throw new Error(`Unknown provider "${providerId}". Available: ${registry.providers.map((entry) => entry.id).join(", ")}.`);
    }
    const normalizedValue = normalizeProviderField(provider, field, value);
    let candidate = replaceProviderFieldInSource(source, providerId, field, yamlScalar(normalizedValue));
    if (field === "defaultModel" && registry.default.provider === providerId) {
      candidate = replaceDefaultSelectionInSource(candidate, "model", yamlScalar(value));
    }
    return candidate;
  });

  return {
    ok: true,
    operation: "set",
    file: "providers",
    key: `providers.${providerId}.${field}`,
    value,
    path,
    restartRequired: true,
  };
}

function normalizeProviderField(provider: ProviderProfile, field: string, value: string): string {
  const fieldLabel = `provider "${provider.id}"`;
  switch (field) {
    case "protocol":
      return readProtocol(value, fieldLabel);
    case "baseUrl": {
      let parsed: URL;
      try {
        parsed = new URL(value);
      } catch {
        throw new Error(`Invalid baseUrl "${value}". Must be a complete URL.`);
      }
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        throw new Error(`baseUrl must use http:// or https://.`);
      }
      if (parsed.username || parsed.password) {
        throw new Error(`baseUrl must not contain credentials. providers.yaml is a non-secret file.`);
      }
      return value.replace(/\/+$/, "");
    }
    case "apiKeyEnv": {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) {
        throw new Error(`Invalid apiKeyEnv "${value}". Must be a valid environment variable name.`);
      }
      return value;
    }
    case "authMethod":
      return readAuthMethod(value, fieldLabel);
    case "responsesProfile":
      return readResponsesProfile(value, fieldLabel);
    case "responsesTransport":
      return readResponsesTransport(value, fieldLabel);
    case "userAgent":
      return readUserAgent(value, fieldLabel);
    case "defaultModel": {
      if (!provider.models.some((model) => model.id === value)) {
        throw new Error(
          `Provider "${provider.id}" does not declare model "${value}". `
          + `Available: ${provider.models.map((model) => model.id).join(", ")}.`,
        );
      }
      return value;
    }
    default:
      if (PROTECTED_PROVIDER_FIELDS.includes(field)) {
        throw new Error(`Field "${field}" cannot be modified directly.`);
      }
      throw new Error(`Unknown provider field "${field}". Supported fields: ${SETTABLE_PROVIDER_FIELDS.join(", ")}.`);
  }
}

async function setProvidersDefault(key: string, value: string): Promise<SetResult> {
  const path = await editProviderRegistrySource((source, registry) => {
    if (key === "default.provider") {
      if (!registry.providers.some((provider) => provider.id === value)) {
        throw new Error(`Unknown provider "${value}". Available: ${registry.providers.map((provider) => provider.id).join(", ")}.`);
      }
      registry.default.provider = value;
      const provider = registry.providers.find((entry) => entry.id === value)!;
      if (provider.defaultModel && provider.models.some((model) => model.id === provider.defaultModel)) {
        registry.default.model = provider.defaultModel;
      } else if (!provider.models.some((model) => model.id === registry.default.model)) {
        registry.default.model = provider.models[0]?.id ?? registry.default.model;
      }
      const withProvider = replaceDefaultSelectionInSource(source, "provider", yamlScalar(registry.default.provider));
      return replaceDefaultSelectionInSource(withProvider, "model", yamlScalar(registry.default.model));
    }
    const provider = registry.providers.find((entry) => entry.id === registry.default.provider);
    if (!provider) throw new Error(`Default provider "${registry.default.provider}" not found.`);
    if (!provider.models.some((model) => model.id === value)) {
      throw new Error(
        `Provider "${registry.default.provider}" does not declare model "${value}". `
        + `Available: ${provider.models.map((model) => model.id).join(", ")}.`,
      );
    }
    return replaceDefaultSelectionInSource(source, "model", yamlScalar(value));
  });
  return { ok: true, operation: "set", file: "providers", key, value, path, restartRequired: true };
}
