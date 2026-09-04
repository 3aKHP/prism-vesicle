import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { isDeepSeekSubsetProfile, type ResponsesProfile, type ResponsesTransport, type VesicleConfig, type VesicleProvider } from "./env";
import type { ProviderAuthMethod } from "./env";
import type { AutoCompactLimits, GenerationDefaults, ModelCapabilities, ModelLimits } from "./env";
import { userConfigDirectory } from "./paths";
import { readYamlKeyValue, readYamlLines, stripYamlComment, unquoteYamlValue } from "./yaml-line-reader";
import { yamlKey, yamlScalar } from "./yaml-writer";

export type ProviderProtocol = VesicleProvider;

export type ProviderSelection = {
  provider: string;
  model: string;
};

export type ProviderModelProfile = {
  id: string;
  generation?: GenerationDefaults;
  capabilities?: ModelCapabilities;
  limits?: ModelLimits;
  webSearchDefault?: boolean;
};

export type ProviderProfile = {
  id: string;
  protocol: ProviderProtocol;
  baseUrl: string;
  apiKeyEnv: string;
  authMethod?: ProviderAuthMethod;
  userAgent?: string;
  responsesProfile?: ResponsesProfile;
  responsesTransport?: ResponsesTransport;
  defaultModel?: string;
  models: ProviderModelProfile[];
};

export type ProviderRegistry = {
  default: ProviderSelection;
  providers: ProviderProfile[];
  source: "file";
  path?: string;
};

/**
 * Canonical model-entry field names, shared between the YAML parser below and
 * the JSON-shape validator used by `vesicle config add-model`. Keep these in
 * sync with readGenerationField/readCapabilityField/readLimitsField/
 * readAutoCompactField; both live in this module so drift is visible in one diff.
 */
export const modelEntryFieldNames = ["id", "generation", "capabilities", "limits", "webSearchDefault"] as const;
export const generationFieldNames = ["temperature", "maxTokens"] as const;
export const capabilityFieldNames = [
  "streaming",
  "tools",
  "reasoningTier",
  "reasoningContent",
  "temperature",
  "maxTokens",
  "vision",
  "remoteCompact",
  "builtinWebSearch",
] as const;
export const limitsFieldNames = ["contextWindow", "maxOutputTokens"] as const;
export const autoCompactFieldNames = ["enabled", "threshold", "reserveOutputTokens"] as const;

export function serializeProviderModelLines(model: ProviderModelProfile): string[] {
  const structured = model.generation || model.capabilities || model.limits || model.webSearchDefault !== undefined;
  if (!structured) return [`      - ${yamlScalar(model.id)}`];
  const lines = [`      - id: ${yamlScalar(model.id)}`];
  if (model.generation) {
    lines.push("        generation:");
    if (model.generation.temperature !== undefined) lines.push(`          temperature: ${model.generation.temperature}`);
    if (model.generation.maxTokens !== undefined) lines.push(`          maxTokens: ${model.generation.maxTokens}`);
  }
  if (model.capabilities) {
    lines.push("        capabilities:");
    for (const [key, value] of Object.entries(model.capabilities)) {
      if (value !== undefined) lines.push(`          ${key}: ${value}`);
    }
  }
  if (model.limits) {
    lines.push("        limits:");
    if (model.limits.contextWindow !== undefined) lines.push(`          contextWindow: ${model.limits.contextWindow}`);
    if (model.limits.maxOutputTokens !== undefined) lines.push(`          maxOutputTokens: ${model.limits.maxOutputTokens}`);
    if (model.limits.autoCompact) {
      lines.push("          autoCompact:");
      if (model.limits.autoCompact.enabled !== undefined) lines.push(`            enabled: ${model.limits.autoCompact.enabled}`);
      if (model.limits.autoCompact.threshold !== undefined) lines.push(`            threshold: ${model.limits.autoCompact.threshold}`);
      if (model.limits.autoCompact.reserveOutputTokens !== undefined) {
        lines.push(`            reserveOutputTokens: ${model.limits.autoCompact.reserveOutputTokens}`);
      }
    }
  }
  if (model.webSearchDefault !== undefined) lines.push(`        webSearchDefault: ${model.webSearchDefault}`);
  return lines;
}

export function serializeProviderLines(provider: ProviderProfile): string[] {
  const lines = [
    `  ${yamlKey(provider.id)}:`,
    `    protocol: ${provider.protocol}`,
    `    baseUrl: ${yamlScalar(provider.baseUrl)}`,
    `    apiKeyEnv: ${provider.apiKeyEnv}`,
  ];
  if (provider.authMethod) lines.push(`    authMethod: ${provider.authMethod}`);
  if (provider.userAgent) lines.push(`    userAgent: ${yamlScalar(provider.userAgent)}`);
  if (provider.responsesProfile) lines.push(`    responsesProfile: ${provider.responsesProfile}`);
  if (provider.responsesTransport) lines.push(`    responsesTransport: ${provider.responsesTransport}`);
  if (provider.defaultModel) lines.push(`    defaultModel: ${yamlScalar(provider.defaultModel)}`);
  lines.push("    models:");
  for (const model of provider.models) lines.push(...serializeProviderModelLines(model));
  return lines;
}

/**
 * Validate a JSON-shaped model entry (as passed to `vesicle config add-model
 * --json`) into a ProviderModelProfile. Unlike the YAML readers below, values
 * here are already JSON-typed, so booleans must be real booleans and numbers
 * real numbers — no string coercion. Unknown keys are rejected.
 */
export function validateModelEntryShape(entry: unknown): ProviderModelProfile {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
    throw new Error("Model entry must be a JSON object.");
  }
  const source = entry as Record<string, unknown>;
  for (const key of Object.keys(source)) {
    if (!(modelEntryFieldNames as readonly string[]).includes(key)) {
      throw new Error(`Unknown model entry field "${key}". Allowed: ${modelEntryFieldNames.join(", ")}.`);
    }
  }

  const id = source.id;
  if (typeof id !== "string" || !id.trim()) {
    throw new Error(`Model entry requires a non-empty "id" string.`);
  }
  const modelId = id.trim();
  if (/\s/.test(modelId)) {
    throw new Error(`Model id "${modelId}" must not contain whitespace.`);
  }

  const model: ProviderModelProfile = { id: modelId };
  if (source.generation !== undefined) model.generation = readGenerationObject(source.generation);
  if (source.capabilities !== undefined) model.capabilities = readCapabilitiesObject(source.capabilities);
  if (source.limits !== undefined) model.limits = readLimitsObject(source.limits);
  if (source.webSearchDefault !== undefined) {
    if (typeof source.webSearchDefault !== "boolean") throw new Error("webSearchDefault must be true or false.");
    model.webSearchDefault = source.webSearchDefault;
  }
  return model;
}

function readGenerationObject(value: unknown): GenerationDefaults {
  const source = readObjectField(value, "generation", generationFieldNames);
  const result: GenerationDefaults = {};
  if (source.temperature !== undefined) result.temperature = readJsonFiniteNumber(source.temperature, "temperature");
  if (source.maxTokens !== undefined) result.maxTokens = readJsonPositiveInteger(source.maxTokens, "maxTokens");
  return result;
}

function readCapabilitiesObject(value: unknown): ModelCapabilities {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("capabilities must be an object.");
  }
  const result: Record<string, boolean> = {};
  for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
    if (!(capabilityFieldNames as readonly string[]).includes(key)) {
      throw new Error(`Unknown capability "${key}". Allowed: ${capabilityFieldNames.join(", ")}.`);
    }
    if (typeof val !== "boolean") {
      throw new Error(`Capability "${key}" must be true or false.`);
    }
    result[key] = val;
  }
  return result as ModelCapabilities;
}

function readLimitsObject(value: unknown): ModelLimits {
  const source = readObjectField(value, "limits", limitsFieldNames);
  const result: ModelLimits = {};
  if (source.contextWindow !== undefined) result.contextWindow = readJsonPositiveInteger(source.contextWindow, "contextWindow");
  if (source.maxOutputTokens !== undefined) result.maxOutputTokens = readJsonPositiveInteger(source.maxOutputTokens, "maxOutputTokens");
  if (source.autoCompact !== undefined) result.autoCompact = readAutoCompactObject(source.autoCompact);
  return result;
}

function readAutoCompactObject(value: unknown): AutoCompactLimits {
  const source = readObjectField(value, "autoCompact", autoCompactFieldNames);
  const result: AutoCompactLimits = {};
  if (source.enabled !== undefined) {
    if (typeof source.enabled !== "boolean") throw new Error("autoCompact.enabled must be true or false.");
    result.enabled = source.enabled;
  }
  if (source.threshold !== undefined) {
    const threshold = source.threshold;
    if (typeof threshold !== "number" || !Number.isFinite(threshold) || threshold <= 0 || threshold >= 1) {
      throw new Error("autoCompact.threshold must be a number greater than 0 and less than 1.");
    }
    result.threshold = threshold;
  }
  if (source.reserveOutputTokens !== undefined) {
    result.reserveOutputTokens = readJsonPositiveInteger(source.reserveOutputTokens, "autoCompact.reserveOutputTokens");
  }
  return result;
}

function readObjectField(value: unknown, field: string, allowed: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${field} must be an object.`);
  }
  const source = value as Record<string, unknown>;
  for (const key of Object.keys(source)) {
    if (!allowed.includes(key)) {
      throw new Error(`Unknown ${field} field "${key}". Allowed: ${allowed.join(", ")}.`);
    }
  }
  return source;
}

function readJsonFiniteNumber(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${field} must be a finite number.`);
  }
  return value;
}

function readJsonPositiveInteger(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw new Error(`${field} must be a positive integer.`);
  }
  return value;
}


export type ProviderConfigStatus = VesicleConfig & {
  hasApiKey: boolean;
  missing: string[];
  registry: ProviderRegistry;
  providerEnvPath: string;
  hasProviderEnvFile: boolean;
  /**
   * User-level `.env` values only, without the process-env overlay. Lets the
   * provider proxy policy resolve explicit-user vs process precedence without
   * merge ambiguity. Existing consumers continue to use `effectiveEnv`.
   */
  fileEnv: NodeJS.ProcessEnv;
};

export async function loadProviderRegistry(
  env: NodeJS.ProcessEnv = process.env,
): Promise<ProviderRegistry> {
  const { registry } = await loadProviderRegistryWithEnv(env);
  return registry;
}

async function loadProviderRegistryWithEnv(
  env: NodeJS.ProcessEnv = process.env,
): Promise<{
  registry: ProviderRegistry;
  effectiveEnv: NodeJS.ProcessEnv;
  fileEnv: NodeJS.ProcessEnv;
  providerEnvPath: string;
  hasProviderEnvFile: boolean;
}> {
  const configPath = providerConfigPathFromEnv(env);
  const source = await readFile(configPath, "utf8").catch((error: unknown) => {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return undefined;
    throw error;
  });
  if (!source) {
    if (env.VESICLE_PROVIDERS_FILE) {
      throw new Error(`VESICLE_PROVIDERS_FILE points to a provider config that does not exist: ${configPath}.`);
    }
    throw new Error(`Provider config not found at ${configPath}. Copy docs/examples/providers.yaml there or set VESICLE_PROVIDERS_FILE.`);
  }
  const providerEnv = await loadProviderEnvironment(configPath, env);
  return {
    registry: parseProviderConfig(source, configPath, providerEnv.effectiveEnv),
    effectiveEnv: providerEnv.effectiveEnv,
    fileEnv: providerEnv.fileEnv,
    providerEnvPath: providerEnv.path,
    hasProviderEnvFile: providerEnv.exists,
  };
}

export async function loadUserConfigEnvironment(
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ effectiveEnv: NodeJS.ProcessEnv; fileEnv: NodeJS.ProcessEnv; path: string; exists: boolean }> {
  return loadProviderEnvironment(providerConfigPathFromEnv(env), env);
}

export async function loadConfigForSelection(
  selection?: Partial<ProviderSelection>,
  env: NodeJS.ProcessEnv = process.env,
): Promise<VesicleConfig> {
  const { registry, effectiveEnv } = await loadProviderRegistryWithEnv(env);
  return resolveProviderConfig(registry, selection, effectiveEnv);
}

/**
 * `loadConfigForSelection` with the two-level degradation used by
 * budget-sensitive consumers (skill catalog resolution, migration preflight):
 * try the session's recorded selection first, then an undefined selection,
 * then give up and return undefined. Keep this the single owner of that
 * fallback contract — duplicating the try/catch ladder drifts.
 */
export async function loadConfigWithProviderFallback(
  selection?: Partial<ProviderSelection>,
  env: NodeJS.ProcessEnv = process.env,
): Promise<VesicleConfig | undefined> {
  try {
    return await loadConfigForSelection(selection, env);
  } catch {
    try {
      return await loadConfigForSelection(undefined, env);
    } catch {
      return undefined;
    }
  }
}

export async function inspectProviderConfig(
  selection?: Partial<ProviderSelection>,
  env: NodeJS.ProcessEnv = process.env,
): Promise<ProviderConfigStatus> {
  const { registry, effectiveEnv, fileEnv, providerEnvPath, hasProviderEnvFile } = await loadProviderRegistryWithEnv(env);
  const config = resolveProviderConfig(registry, selection, effectiveEnv);
  const missing: string[] = [];
  if (!config.apiKey) {
    const profile = requireProvider(registry, config.providerId);
    missing.push(profile.apiKeyEnv ?? "apiKey");
  }
  if (!config.baseUrl) missing.push("baseUrl");
  if (!config.model) missing.push("model");
  return {
    ...config,
    hasApiKey: Boolean(config.apiKey),
    missing,
    registry,
    providerEnvPath,
    hasProviderEnvFile,
    fileEnv,
  };
}

export function resolveProviderConfig(
  registry: ProviderRegistry,
  selection: Partial<ProviderSelection> | undefined,
  env: NodeJS.ProcessEnv = process.env,
): VesicleConfig {
  const providerId = selection?.provider ?? registry.default.provider;
  const profile = requireProvider(registry, providerId);
  const model = selection?.model ?? profile.defaultModel ?? (providerId === registry.default.provider ? registry.default.model : profile.models[0]?.id);
  if (!model) {
    throw new Error(`Provider "${providerId}" does not declare any models.`);
  }
  const modelProfile = requireModel(profile, model);

  return {
    provider: profile.protocol,
    providerId,
    baseUrl: trimTrailingSlash(profile.baseUrl),
    model,
    apiKey: env[profile.apiKeyEnv],
    apiKeyLabel: profile.apiKeyEnv,
    ...(profile.authMethod ? { authMethod: profile.authMethod } : {}),
    ...(profile.userAgent ? { userAgent: profile.userAgent } : {}),
    ...(profile.responsesProfile ? { responsesProfile: profile.responsesProfile } : {}),
    ...(profile.responsesTransport ? { responsesTransport: profile.responsesTransport } : {}),
    ...(modelProfile.generation ? { generation: modelProfile.generation } : {}),
    ...(modelProfile.capabilities ? { capabilities: modelProfile.capabilities } : {}),
    ...(modelProfile.limits ? { limits: modelProfile.limits } : {}),
    ...(modelProfile.webSearchDefault !== undefined ? { webSearchDefault: modelProfile.webSearchDefault } : {}),
  };
}

export function providerConfigPath(): string {
  return providerConfigPathFromEnv(process.env);
}

export function providerConfigPathFromEnv(env: NodeJS.ProcessEnv = process.env): string {
  if (env.VESICLE_PROVIDERS_FILE) return env.VESICLE_PROVIDERS_FILE;
  return join(userConfigDirectory(env), "providers.yaml");
}

async function loadProviderEnvironment(
  configPath: string,
  env: NodeJS.ProcessEnv,
): Promise<{ effectiveEnv: NodeJS.ProcessEnv; fileEnv: NodeJS.ProcessEnv; path: string; exists: boolean }> {
  const envPath = join(dirname(configPath), ".env");
  const source = await readFile(envPath, "utf8").catch((error: unknown) => {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return "";
    throw error;
  });
  if (!source) return { effectiveEnv: env, fileEnv: {}, path: envPath, exists: false };
  const fileEnv = parseEnvFile(source, envPath);
  return { effectiveEnv: { ...env, ...fileEnv }, fileEnv, path: envPath, exists: true };
}

export function parseEnvFile(source: string, path: string): NodeJS.ProcessEnv {
  const values: NodeJS.ProcessEnv = {};
  const lines = source.split(/\r?\n/);
  for (let index = 0; index < lines.length; index++) {
    const raw = stripYamlComment(lines[index]).trim();
    if (!raw) continue;
    const line = raw.startsWith("export ") ? raw.slice("export ".length).trimStart() : raw;
    const equals = line.indexOf("=");
    if (equals === -1) {
      const hint = raw.startsWith("export ") ? "use KEY=value syntax, not bare export statements" : 'missing "="';
      throw new Error(`Environment file parse error on line ${index + 1} in ${path}: ${hint}.`);
    }
    const key = line.slice(0, equals).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      throw new Error(`Environment file parse error on line ${index + 1} in ${path}: invalid variable name "${key}".`);
    }
    values[key] = unquoteYamlValue(line.slice(equals + 1).trim());
  }
  return values;
}

export function parseProviderConfig(source: string, path: string, env: NodeJS.ProcessEnv): ProviderRegistry {
  const lines = readYamlLines(source);
  const registry: ProviderRegistry = {
    source: "file",
    path,
    default: { provider: "", model: "" },
    providers: [],
  };
  let section: "default" | "providers" | null = null;
  let currentProvider: Partial<ProviderProfile> | null = null;
  let currentList: "models" | null = null;
  let currentModel: Partial<ProviderModelProfile> | null = null;
  let currentModelBlock: "generation" | "capabilities" | "limits" | "autoCompact" | null = null;
  const seenSections = new Set<string>();
  const seenDefaultFields = new Set<string>();
  let seenProviderFields = new Set<string>();

  const finishModel = () => {
    if (!currentModel) return;
    const id = currentModel.id;
    if (!id) throw new Error(`Provider config ${path} has a model without an id.`);
    const model: ProviderModelProfile = {
      id,
      ...(currentModel.generation ? { generation: currentModel.generation } : {}),
      ...(currentModel.capabilities ? { capabilities: currentModel.capabilities } : {}),
      ...(currentModel.limits ? { limits: currentModel.limits } : {}),
      ...(currentModel.webSearchDefault !== undefined ? { webSearchDefault: currentModel.webSearchDefault } : {}),
    };
    validateAutoCompactBudget(model, currentProvider?.id, path);
    currentProvider!.models = [
      ...(currentProvider!.models ?? []),
      model,
    ];
    currentModel = null;
    currentModelBlock = null;
  };

  const finishProvider = () => {
    finishModel();
    if (!currentProvider) return;
    const id = currentProvider.id;
    if (!id) throw new Error(`Provider config ${path} has a provider without an id.`);
    const protocol = currentProvider.protocol;
    if (!protocol) throw new Error(`Provider "${id}" is missing protocol.`);
    if (registry.providers.some((provider) => provider.id === id)) {
      throw new Error(`Duplicate provider id "${id}".`);
    }
    const baseUrl = currentProvider.baseUrl;
    if (!baseUrl) throw new Error(`Provider "${id}" is missing baseUrl.`);
    const apiKeyEnv = currentProvider.apiKeyEnv;
    if (!apiKeyEnv) throw new Error(`Provider "${id}" is missing apiKeyEnv.`);
    const models = currentProvider.models ?? [];
    if (models.length === 0) throw new Error(`Provider "${id}" must declare at least one model.`);
    const duplicateModel = firstDuplicate(models.map((model) => model.id));
    if (duplicateModel) throw new Error(`Provider "${id}" declares duplicate model "${duplicateModel}".`);
    const defaultModel = currentProvider.defaultModel;
    if (defaultModel && !models.some((model) => model.id === defaultModel)) {
      throw new Error(`Provider "${id}" defaultModel "${defaultModel}" is not declared in models.`);
    }
    if (protocol === "openai-responses" && !currentProvider.responsesProfile) {
      throw new Error(`Provider "${id}" using openai-responses must declare responsesProfile.`);
    }
    if (protocol !== "openai-responses" && currentProvider.responsesProfile) {
      throw new Error(`Provider "${id}" cannot declare responsesProfile with protocol ${protocol}.`);
    }
    if (protocol !== "openai-responses" && currentProvider.responsesTransport) {
      throw new Error(`Provider "${id}" cannot declare responsesTransport with protocol ${protocol}.`);
    }
    if (currentProvider.responsesProfile === "codex-http-relay" && currentProvider.responsesTransport === "websocket") {
      throw new Error(`Provider "${id}" cannot use codex-http-relay with responsesTransport websocket.`);
    }
    if (currentProvider.responsesProfile === "mimo-subset-2026-07-30" && currentProvider.responsesTransport === "websocket") {
      throw new Error(`Provider "${id}" cannot use mimo-subset-2026-07-30 with responsesTransport websocket.`);
    }
    if (isDeepSeekSubsetProfile(currentProvider.responsesProfile) && currentProvider.responsesTransport === "websocket") {
      throw new Error(`Provider "${id}" cannot use ${currentProvider.responsesProfile} with responsesTransport websocket.`);
    }
    if (protocol === "openai-responses" && currentProvider.authMethod === "x-goog-api-key") {
      throw new Error(`Provider "${id}" using openai-responses cannot use authMethod x-goog-api-key.`);
    }
    if (protocol === "openai-responses" && currentProvider.authMethod === "x-api-key"
      && currentProvider.responsesProfile !== "mimo-subset-2026-07-30") {
      throw new Error(`Provider "${id}" can use authMethod x-api-key only with mimo-subset-2026-07-30.`);
    }
    if (currentProvider.responsesProfile === "mimo-subset-2026-07-30"
      && models.some((model) => model.capabilities?.remoteCompact === true)) {
      throw new Error(`Provider "${id}" cannot enable remoteCompact with mimo-subset-2026-07-30.`);
    }
    if (isDeepSeekSubsetProfile(currentProvider.responsesProfile)
      && models.some((model) => model.capabilities?.remoteCompact === true)) {
      throw new Error(`Provider "${id}" cannot enable remoteCompact with ${currentProvider.responsesProfile}.`);
    }
    if (isDeepSeekSubsetProfile(currentProvider.responsesProfile)
      && models.some((model) => model.id !== "deepseek-v4-flash" && model.id !== "deepseek-v4-pro")) {
      throw new Error(`Provider "${id}" can declare only deepseek-v4-flash or deepseek-v4-pro with ${currentProvider.responsesProfile}.`);
    }
    registry.providers.push({
      id,
      protocol,
      baseUrl,
      apiKeyEnv,
      ...(currentProvider.authMethod ? { authMethod: currentProvider.authMethod } : {}),
      ...(currentProvider.userAgent ? { userAgent: currentProvider.userAgent } : {}),
      ...(currentProvider.responsesProfile ? { responsesProfile: currentProvider.responsesProfile } : {}),
      ...(currentProvider.responsesTransport ? { responsesTransport: currentProvider.responsesTransport } : {}),
      ...(defaultModel ? { defaultModel } : {}),
      models,
    });
    currentProvider = null;
    currentList = null;
    currentModelBlock = null;
    seenProviderFields = new Set<string>();
  };

  for (const parsedLine of lines) {
    const index = parsedLine.number - 1;
    const indent = parsedLine.indent;
    const line = parsedLine.text;

    if (indent === 0) {
      finishProvider();
      currentList = null;
      currentModelBlock = null;
      if (line === "default:") {
        if (seenSections.has("default")) throw new Error(`Provider config parse error on line ${index + 1}: duplicate default: section.`);
        seenSections.add("default");
        section = "default";
        continue;
      }
      if (line === "providers:") {
        if (seenSections.has("providers")) throw new Error(`Provider config parse error on line ${index + 1}: duplicate providers: section.`);
        seenSections.add("providers");
        section = "providers";
        continue;
      }
      throw new Error(`Provider config parse error on line ${index + 1}: expected default: or providers:.`);
    }

    if (section === "default") {
      if (indent !== 2) throw new Error(`Provider config parse error on line ${index + 1}: default fields use two spaces.`);
      const [key, value] = readKeyValue(line, index, path);
      if (seenDefaultFields.has(key)) throw new Error(`Provider config parse error on line ${index + 1}: duplicate default field "${key}".`);
      seenDefaultFields.add(key);
      if (key === "provider") registry.default.provider = value;
      else if (key === "model") registry.default.model = value;
      else throw new Error(`Provider config parse error on line ${index + 1}: unknown default field "${key}".`);
      continue;
    }

    if (section !== "providers") {
      throw new Error(`Provider config parse error on line ${index + 1}: field outside a section.`);
    }

    if (indent === 2) {
      finishProvider();
      if (!line.endsWith(":")) {
        throw new Error(`Provider config parse error on line ${index + 1}: provider id must end with colon.`);
      }
      currentProvider = { id: line.slice(0, -1).trim(), models: [] };
      continue;
    }

    if (!currentProvider) {
      throw new Error(`Provider config parse error on line ${index + 1}: provider field without provider id.`);
    }

    if (indent === 4) {
      finishModel();
      if (line === "models:") {
        if (seenProviderFields.has("models")) {
          throw new Error(`Provider config parse error on line ${index + 1}: duplicate provider field "models".`);
        }
        seenProviderFields.add("models");
        currentList = "models";
        continue;
      }
      currentList = null;
      const [key, value] = readKeyValue(line, index, path);
      if (seenProviderFields.has(key)) throw new Error(`Provider config parse error on line ${index + 1}: duplicate provider field "${key}".`);
      seenProviderFields.add(key);
      if (key === "protocol") currentProvider.protocol = readProtocol(value, `provider ${currentProvider.id}`);
      else if (key === "baseUrl") currentProvider.baseUrl = value;
      else if (key === "apiKeyEnv") currentProvider.apiKeyEnv = value;
      else if (key === "authMethod") currentProvider.authMethod = readAuthMethod(value, `provider ${currentProvider.id}`);
      else if (key === "userAgent") currentProvider.userAgent = readUserAgent(value, `provider ${currentProvider.id}`);
      else if (key === "responsesProfile") currentProvider.responsesProfile = readResponsesProfile(value, `provider ${currentProvider.id}`);
      else if (key === "responsesTransport") currentProvider.responsesTransport = readResponsesTransport(value, `provider ${currentProvider.id}`);
      else if (key === "defaultModel") currentProvider.defaultModel = value;
      else if (key === "apiKey") throw new Error(`Provider config parse error on line ${index + 1}: use apiKeyEnv instead of inline apiKey.`);
      else throw new Error(`Provider config parse error on line ${index + 1}: unknown provider field "${key}".`);
      continue;
    }

    if (indent === 6 && currentList === "models") {
      finishModel();
      if (!line.startsWith("- ")) {
        throw new Error(`Provider config parse error on line ${index + 1}: model entries must start with "- ".`);
      }
      const entry = line.slice(2).trim();
      if (/^id\s*:/.test(entry)) {
        const [key, value] = readKeyValue(entry, index, path);
        if (key !== "id") {
          throw new Error(`Provider config parse error on line ${index + 1}: model object entries must start with id.`);
        }
        currentModel = { id: value };
      } else {
        currentProvider.models = [...(currentProvider.models ?? []), { id: unquoteYamlValue(entry) }];
      }
      continue;
    }

    if (indent === 8 && currentList === "models" && currentModel) {
      if (line === "generation:") {
        currentModel.generation = currentModel.generation ?? {};
        currentModelBlock = "generation";
        continue;
      }
      if (line === "capabilities:") {
        currentModel.capabilities = currentModel.capabilities ?? {};
        currentModelBlock = "capabilities";
        continue;
      }
      if (line === "limits:") {
        currentModel.limits = currentModel.limits ?? {};
        currentModelBlock = "limits";
        continue;
      }
      currentModelBlock = null;
      const [key, value] = readKeyValue(line, index, path);
      if (key === "id") currentModel.id = value;
      else if (key === "webSearchDefault") currentModel.webSearchDefault = readBoolean(value, key, index, path);
      else throw new Error(`Provider config parse error on line ${index + 1}: unknown model field "${key}".`);
      continue;
    }

    if (indent === 10 && currentList === "models" && currentModel && currentModelBlock) {
      if (currentModelBlock === "autoCompact") currentModelBlock = "limits";
      if (currentModelBlock === "limits" && line === "autoCompact:") {
        currentModel.limits = {
          ...(currentModel.limits ?? {}),
          autoCompact: currentModel.limits?.autoCompact ?? {},
        };
        currentModelBlock = "autoCompact";
        continue;
      }
      const [key, value] = readKeyValue(line, index, path);
      if (currentModelBlock === "generation") {
        currentModel.generation = {
          ...(currentModel.generation ?? {}),
          ...readGenerationField(key, value, index, path),
        };
        continue;
      }
      if (currentModelBlock === "capabilities") {
        currentModel.capabilities = {
          ...(currentModel.capabilities ?? {}),
          ...readCapabilityField(key, value, index, path),
        };
        continue;
      }
      if (currentModelBlock === "limits") {
        currentModel.limits = {
          ...(currentModel.limits ?? {}),
          ...readLimitsField(key, value, index, path),
        };
        continue;
      }
      currentModel.limits = {
        ...(currentModel.limits ?? {}),
        autoCompact: {
          ...(currentModel.limits?.autoCompact ?? {}),
          ...readAutoCompactField(key, value, index, path),
        },
      };
      continue;
    }

    if (indent === 12 && currentList === "models" && currentModel && currentModelBlock === "autoCompact") {
      const [key, value] = readKeyValue(line, index, path);
      currentModel.limits = {
        ...(currentModel.limits ?? {}),
        autoCompact: {
          ...(currentModel.limits?.autoCompact ?? {}),
          ...readAutoCompactField(key, value, index, path),
        },
      };
      continue;
    }

    throw new Error(`Provider config parse error on line ${index + 1}: unsupported indentation.`);
  }

  finishProvider();
  if (!registry.default.provider) throw new Error(`Provider config ${path} is missing default.provider.`);
  if (!registry.default.model) throw new Error(`Provider config ${path} is missing default.model.`);
  resolveProviderConfig(registry, registry.default, env);
  return registry;
}

function validateAutoCompactBudget(model: ProviderModelProfile, providerId: string | undefined, path: string): void {
  const autoCompact = model.limits?.autoCompact;
  const contextWindow = model.limits?.contextWindow;
  if (!autoCompact || contextWindow === undefined) return;

  const location = `Provider config ${path} model "${model.id}"${providerId ? ` in provider "${providerId}"` : ""}`;
  const explicitReserve = autoCompact.reserveOutputTokens;
  if (explicitReserve !== undefined && explicitReserve >= contextWindow) {
    throw new Error(`${location} has autoCompact.reserveOutputTokens (${explicitReserve}) greater than or equal to contextWindow (${contextWindow}).`);
  }
  if (autoCompact.enabled === false || autoCompact.threshold === undefined) return;

  const effectiveReserve = explicitReserve
    ?? model.generation?.maxTokens
    ?? model.limits?.maxOutputTokens
    ?? 0;
  if (effectiveReserve >= contextWindow) {
    throw new Error(`${location} has an effective output reserve (${effectiveReserve}) that leaves no positive input budget within contextWindow (${contextWindow}).`);
  }
}

function requireProvider(registry: ProviderRegistry, providerId: string): ProviderProfile {
  const profile = registry.providers.find((entry) => entry.id === providerId);
  if (!profile) throw new Error(`Unknown provider "${providerId}".`);
  return profile;
}

function requireModel(profile: ProviderProfile, modelId: string): ProviderModelProfile {
  const model = profile.models.find((entry) => entry.id === modelId);
  if (!model) throw new Error(`Provider "${profile.id}" does not declare model "${modelId}".`);
  return model;
}

export function readProtocol(value: string, field: string): ProviderProtocol {
  if (value !== "openai-chat-compatible" && value !== "openai-responses" && value !== "anthropic-messages" && value !== "gemini-generate-content") {
    throw new Error(`Unsupported provider protocol "${value}" in ${field}.`);
  }
  return value;
}

export function readResponsesProfile(value: string, field: string): ResponsesProfile {
  if (value !== "openai-public" && value !== "codex-http-relay" && value !== "codex-beta-2026-02-06"
    && value !== "mimo-subset-2026-07-30" && !isDeepSeekSubsetProfile(value)) {
    throw new Error(`Unsupported Responses profile "${value}" in ${field}.`);
  }
  return value;
}

export function readResponsesTransport(value: string, field: string): ResponsesTransport {
  if (value !== "http" && value !== "websocket") {
    throw new Error(`Unsupported Responses transport "${value}" in ${field}.`);
  }
  return value;
}

export function readAuthMethod(value: string, field: string): ProviderAuthMethod {
  if (value !== "bearer" && value !== "x-api-key" && value !== "x-goog-api-key") {
    throw new Error(`Unsupported provider authMethod "${value}" in ${field}.`);
  }
  return value;
}

export function readUserAgent(value: string, field: string): string {
  if (/[\x00-\x1f\x7f]/.test(value)) {
    throw new Error(`Provider ${field} userAgent contains an invalid control character.`);
  }
  return value;
}

function readKeyValue(line: string, index: number, path: string): [string, string] {
  const [key, value] = readYamlKeyValue(line, index + 1, path, "Provider config");
  if (!value) throw new Error(`Provider config parse error on line ${index + 1} in ${path}: empty value for ${key}.`);
  return [key, value];
}

function readGenerationField(key: string, value: string, index: number, path: string): GenerationDefaults {
  if (!(generationFieldNames as readonly string[]).includes(key)) {
    throw new Error(`Provider config parse error on line ${index + 1} in ${path}: unknown generation field "${key}".`);
  }
  if (key === "temperature") return { temperature: readFiniteNumber(value, key, index, path) };
  return { maxTokens: readPositiveInteger(value, key, index, path) };
}

function readCapabilityField(key: string, value: string, index: number, path: string): ModelCapabilities {
  if (!(capabilityFieldNames as readonly string[]).includes(key)) {
    throw new Error(`Provider config parse error on line ${index + 1} in ${path}: unknown capability field "${key}".`);
  }
  const enabled = readBoolean(value, key, index, path);
  if (key === "streaming") return { streaming: enabled };
  if (key === "tools") return { tools: enabled };
  if (key === "reasoningTier") return { reasoningTier: enabled };
  if (key === "reasoningContent") return { reasoningContent: enabled };
  if (key === "temperature") return { temperature: enabled };
  if (key === "maxTokens") return { maxTokens: enabled };
  if (key === "vision") return { vision: enabled };
  if (key === "remoteCompact") return { remoteCompact: enabled };
  return { builtinWebSearch: enabled };
}

function readLimitsField(key: string, value: string, index: number, path: string): ModelLimits {
  if (!(limitsFieldNames as readonly string[]).includes(key)) {
    throw new Error(`Provider config parse error on line ${index + 1} in ${path}: unknown limits field "${key}".`);
  }
  if (key === "contextWindow") return { contextWindow: readPositiveInteger(value, key, index, path) };
  return { maxOutputTokens: readPositiveInteger(value, key, index, path) };
}

function readAutoCompactField(key: string, value: string, index: number, path: string): AutoCompactLimits {
  if (!(autoCompactFieldNames as readonly string[]).includes(key)) {
    throw new Error(`Provider config parse error on line ${index + 1} in ${path}: unknown autoCompact field "${key}".`);
  }
  if (key === "enabled") return { enabled: readBoolean(value, key, index, path) };
  if (key === "threshold") return { threshold: readFraction(value, key, index, path) };
  return { reserveOutputTokens: readPositiveInteger(value, key, index, path) };
}

function readFiniteNumber(value: string, key: string, index: number, path: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Provider config parse error on line ${index + 1} in ${path}: ${key} must be a finite number.`);
  }
  return parsed;
}

function readPositiveInteger(value: string, key: string, index: number, path: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`Provider config parse error on line ${index + 1} in ${path}: ${key} must be a positive integer.`);
  }
  return parsed;
}

function readFraction(value: string, key: string, index: number, path: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0 || parsed >= 1) {
    throw new Error(`Provider config parse error on line ${index + 1} in ${path}: ${key} must be a number greater than 0 and less than 1.`);
  }
  return parsed;
}

function readBoolean(value: string, key: string, index: number, path: string): boolean {
  if (value === "true") return true;
  if (value === "false") return false;
  throw new Error(`Provider config parse error on line ${index + 1} in ${path}: ${key} must be true or false.`);
}

function firstDuplicate(values: string[]): string | undefined {
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) return value;
    seen.add(value);
  }
  return undefined;
}


function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}
