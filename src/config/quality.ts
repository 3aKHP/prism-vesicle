import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { userConfigDirectory } from "./paths";
import { loadConfigForSelection } from "./providers";
import { createProvider } from "../providers";
import type { VesicleConfig } from "./env";
import type { ProviderAdapter } from "../providers/shared/types";
import type { QualityRuntimeContext } from "../core/quality/types";

export const experimentalQualityModes = ["off", "observe", "rewrite"] as const;
export type ExperimentalQualityMode = typeof experimentalQualityModes[number];

export const defaultExperimentalQualityTimeoutMs = 15_000;
export const minExperimentalQualityTimeoutMs = 1_000;
export const maxExperimentalQualityTimeoutMs = 180_000;

export type ExperimentalQualitySettings = {
  mode: ExperimentalQualityMode;
  providerAlias?: string;
  modelId?: string;
  judgeTimeoutMs?: number;
  path: string;
  exists: boolean;
  identity: string;
};

/** A resolved, secret-free snapshot used for one Runtime turn. */
export type ExperimentalQualityProfile = {
  mode: Exclude<ExperimentalQualityMode, "off">;
  provider: ProviderAdapter;
  providerId: string;
  modelId: string;
  protocol: VesicleConfig["provider"];
  judgeTimeoutMs: number;
  configIdentity: string;
  settingsPath: string;
  temperatureSupported: boolean;
  reasoningTierSupported: boolean;
};

export function qualitySettingsPath(env: NodeJS.ProcessEnv = process.env): string {
  if (env.VESICLE_QUALITY_FILE) return env.VESICLE_QUALITY_FILE;
  return join(userConfigDirectory(env), "quality.yaml");
}

export async function loadExperimentalQualitySettings(
  env: NodeJS.ProcessEnv = process.env,
): Promise<ExperimentalQualitySettings> {
  const path = qualitySettingsPath(env);
  let source: string;
  try {
    source = await readFile(path, "utf8");
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return disabledSettings(path, false);
    }
    throw error;
  }
  return parseExperimentalQualitySettings(source, path);
}

/**
 * Resolve the opt-in Judge only after both user configuration and the active
 * Harness contract are present. This intentionally never falls back to the
 * generation model or to an inactive calibrated Policy.
 */
export async function loadExperimentalQualityProfile(
  quality: QualityRuntimeContext | undefined,
  env: NodeJS.ProcessEnv = process.env,
): Promise<ExperimentalQualityProfile | undefined> {
  const settings = await loadExperimentalQualitySettings(env);
  if (settings.mode === "off") return undefined;
  if (!quality?.judge) {
    throw new Error("Experimental Semantic Judge cannot be enabled because the active Harness has no Judge contract.");
  }
  const config = await loadConfigForSelection({ provider: settings.providerAlias, model: settings.modelId }, env);
  if (!config.apiKey) {
    throw new Error(`Experimental Semantic Judge provider ${settings.providerAlias} is missing ${config.apiKeyLabel ?? "its API key"}.`);
  }
  return {
    mode: settings.mode,
    provider: createProvider(config),
    providerId: config.providerId,
    modelId: config.model,
    protocol: config.provider,
    judgeTimeoutMs: settings.judgeTimeoutMs!,
    configIdentity: resolvedProfileIdentity(settings, config),
    settingsPath: settings.path,
    temperatureSupported: config.capabilities?.temperature !== false,
    reasoningTierSupported: config.capabilities?.reasoningTier === true,
  };
}

export function parseExperimentalQualitySettings(source: string, path = "quality.yaml"): ExperimentalQualitySettings {
  const values = new Map<string, string>();
  for (const [index, raw] of source.split(/\r?\n/).entries()) {
    const line = raw.replace(/\s+#.*$/, "").trim();
    if (!line || line.startsWith("#")) continue;
    const colon = line.indexOf(":");
    if (colon < 1) throw new Error(`quality.yaml line ${index + 1} must be key: value.`);
    const key = line.slice(0, colon).trim();
    if (values.has(key)) throw new Error(`quality.yaml duplicates field: ${key}.`);
    values.set(key, unquote(line.slice(colon + 1).trim()));
  }
  for (const key of values.keys()) {
    if (key !== "version" && key !== "mode" && key !== "providerAlias" && key !== "modelId" && key !== "judgeTimeoutMs") {
      throw new Error(`Unknown quality.yaml field: ${key}.`);
    }
  }
  if (values.get("version") !== "1") throw new Error("quality.yaml requires version: 1.");
  const mode = values.get("mode") as ExperimentalQualityMode | undefined;
  if (!mode || !experimentalQualityModes.includes(mode)) {
    throw new Error(`Invalid quality mode. Available: ${experimentalQualityModes.join(", ")}.`);
  }
  const providerAlias = values.get("providerAlias");
  const modelId = values.get("modelId");
  const timeoutValue = values.get("judgeTimeoutMs");
  if (mode === "off") {
    if (providerAlias || modelId || timeoutValue) {
      throw new Error("quality.yaml mode off cannot retain a Judge provider, model, or timeout.");
    }
    return disabledSettings(path, true, source);
  }
  if (!providerAlias) throw new Error("quality.yaml requires providerAlias when mode is enabled.");
  if (!modelId) throw new Error("quality.yaml requires modelId when mode is enabled.");
  if (!timeoutValue || !/^[0-9]+$/.test(timeoutValue)) {
    throw new Error("quality.yaml requires integer judgeTimeoutMs when mode is enabled.");
  }
  const judgeTimeoutMs = Number(timeoutValue);
  if (!Number.isSafeInteger(judgeTimeoutMs)
    || judgeTimeoutMs < minExperimentalQualityTimeoutMs
    || judgeTimeoutMs > maxExperimentalQualityTimeoutMs) {
    throw new Error(`quality.yaml judgeTimeoutMs must be an integer from ${minExperimentalQualityTimeoutMs} to ${maxExperimentalQualityTimeoutMs}.`);
  }
  return {
    mode,
    providerAlias,
    modelId,
    judgeTimeoutMs,
    path,
    exists: true,
    identity: sha256(canonicalQualitySettings({ mode, providerAlias, modelId, judgeTimeoutMs })),
  };
}

export async function writeExperimentalQualitySettings(
  settings: Pick<ExperimentalQualitySettings, "mode" | "providerAlias" | "modelId" | "judgeTimeoutMs">,
  env: NodeJS.ProcessEnv = process.env,
): Promise<ExperimentalQualitySettings> {
  const path = qualitySettingsPath(env);
  const source = renderExperimentalQualitySettings(settings);
  // Parse before replacing the existing user configuration.
  const parsed = parseExperimentalQualitySettings(source, path);
  await mkdir(dirname(path), { recursive: true });
  const staging = `${path}.staging-${randomUUID()}`;
  try {
    await writeFile(staging, source, { encoding: "utf8", flag: "wx" });
    await rename(staging, path);
  } finally {
    await rm(staging, { force: true });
  }
  return parsed;
}

export function renderExperimentalQualitySettings(
  settings: Pick<ExperimentalQualitySettings, "mode" | "providerAlias" | "modelId" | "judgeTimeoutMs">,
): string {
  if (!experimentalQualityModes.includes(settings.mode)) {
    throw new Error(`Invalid quality mode. Available: ${experimentalQualityModes.join(", ")}.`);
  }
  if (settings.mode === "off") return "version: 1\nmode: off\n";
  if (!settings.providerAlias || !settings.modelId || settings.judgeTimeoutMs === undefined) {
    throw new Error("Enabled experimental quality settings require providerAlias, modelId, and judgeTimeoutMs.");
  }
  return [
    "version: 1",
    `mode: ${quoteYaml(settings.mode)}`,
    `providerAlias: ${quoteYaml(settings.providerAlias)}`,
    `modelId: ${quoteYaml(settings.modelId)}`,
    `judgeTimeoutMs: ${settings.judgeTimeoutMs}`,
    "",
  ].join("\n");
}

function disabledSettings(path: string, exists: boolean, source = "version: 1\nmode: off\n"): ExperimentalQualitySettings {
  return {
    mode: "off",
    path,
    exists,
    identity: sha256(source),
  };
}

function canonicalQualitySettings(settings: { mode: ExperimentalQualityMode; providerAlias: string; modelId: string; judgeTimeoutMs: number }): string {
  return JSON.stringify(settings);
}

function resolvedProfileIdentity(settings: ExperimentalQualitySettings, config: VesicleConfig): string {
  return sha256(JSON.stringify({
    settings: {
      mode: settings.mode,
      providerAlias: settings.providerAlias,
      modelId: settings.modelId,
      judgeTimeoutMs: settings.judgeTimeoutMs,
    },
    provider: {
      provider: config.provider,
      providerId: config.providerId,
      baseUrl: config.baseUrl,
      model: config.model,
      authMethod: config.authMethod ?? null,
      apiKeyLabel: config.apiKeyLabel ?? null,
      userAgent: config.userAgent ?? null,
      temperatureSupported: config.capabilities?.temperature !== false,
      reasoningTierSupported: config.capabilities?.reasoningTier === true,
    },
  }));
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function unquote(value: string): string {
  const match = value.match(/^(["'])(.*)\1$/);
  return match ? match[2]! : value;
}

function quoteYaml(value: string): string {
  return JSON.stringify(value);
}
