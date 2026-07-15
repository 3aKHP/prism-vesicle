import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { VesicleConfig, VesicleProvider } from "./env";
import type { ProviderAuthMethod } from "./env";
import type { AutoCompactLimits, GenerationDefaults, ModelCapabilities, ModelLimits } from "./env";
import { userConfigDirectory } from "./paths";

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
};

export type ProviderProfile = {
  id: string;
  protocol: ProviderProtocol;
  baseUrl: string;
  apiKeyEnv: string;
  authMethod?: ProviderAuthMethod;
  userAgent?: string;
  defaultModel?: string;
  models: ProviderModelProfile[];
};

export type ProviderRegistry = {
  default: ProviderSelection;
  providers: ProviderProfile[];
  source: "file";
  path?: string;
};

export type ProviderConfigStatus = VesicleConfig & {
  hasApiKey: boolean;
  missing: string[];
  registry: ProviderRegistry;
  providerEnvPath: string;
  hasProviderEnvFile: boolean;
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
    providerEnvPath: providerEnv.path,
    hasProviderEnvFile: providerEnv.exists,
  };
}

export async function loadUserConfigEnvironment(
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ effectiveEnv: NodeJS.ProcessEnv; path: string; exists: boolean }> {
  return loadProviderEnvironment(providerConfigPathFromEnv(env), env);
}

export async function loadConfigForSelection(
  selection?: Partial<ProviderSelection>,
  env: NodeJS.ProcessEnv = process.env,
): Promise<VesicleConfig> {
  const { registry, effectiveEnv } = await loadProviderRegistryWithEnv(env);
  return resolveProviderConfig(registry, selection, effectiveEnv);
}

export async function inspectProviderConfig(
  selection?: Partial<ProviderSelection>,
  env: NodeJS.ProcessEnv = process.env,
): Promise<ProviderConfigStatus> {
  const { registry, effectiveEnv, providerEnvPath, hasProviderEnvFile } = await loadProviderRegistryWithEnv(env);
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
    ...(modelProfile.generation ? { generation: modelProfile.generation } : {}),
    ...(modelProfile.capabilities ? { capabilities: modelProfile.capabilities } : {}),
    ...(modelProfile.limits ? { limits: modelProfile.limits } : {}),
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
): Promise<{ effectiveEnv: NodeJS.ProcessEnv; path: string; exists: boolean }> {
  const envPath = join(dirname(configPath), ".env");
  const source = await readFile(envPath, "utf8").catch((error: unknown) => {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return "";
    throw error;
  });
  if (!source) return { effectiveEnv: env, path: envPath, exists: false };
  return { effectiveEnv: { ...env, ...parseEnvFile(source, envPath) }, path: envPath, exists: true };
}

export function parseEnvFile(source: string, path: string): NodeJS.ProcessEnv {
  const values: NodeJS.ProcessEnv = {};
  const lines = source.split(/\r?\n/);
  for (let index = 0; index < lines.length; index++) {
    const raw = stripComment(lines[index]).trim();
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
    values[key] = unquote(line.slice(equals + 1).trim());
  }
  return values;
}

export function parseProviderConfig(source: string, path: string, env: NodeJS.ProcessEnv): ProviderRegistry {
  const lines = source.split(/\r?\n/);
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

  const finishModel = () => {
    if (!currentModel) return;
    const id = currentModel.id;
    if (!id) throw new Error(`Provider config ${path} has a model without an id.`);
    currentProvider!.models = [
      ...(currentProvider!.models ?? []),
      {
        id,
        ...(currentModel.generation ? { generation: currentModel.generation } : {}),
        ...(currentModel.capabilities ? { capabilities: currentModel.capabilities } : {}),
        ...(currentModel.limits ? { limits: currentModel.limits } : {}),
      },
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
    registry.providers.push({
      id,
      protocol,
      baseUrl,
      apiKeyEnv,
      ...(currentProvider.authMethod ? { authMethod: currentProvider.authMethod } : {}),
      ...(currentProvider.userAgent ? { userAgent: currentProvider.userAgent } : {}),
      ...(defaultModel ? { defaultModel } : {}),
      models,
    });
    currentProvider = null;
    currentList = null;
    currentModelBlock = null;
  };

  for (let index = 0; index < lines.length; index++) {
    const raw = stripComment(lines[index]).replace(/\s+$/, "");
    if (!raw.trim()) continue;
    const indent = leadingSpaces(raw);
    const line = raw.trim();

    if (indent === 0) {
      finishProvider();
      currentList = null;
      currentModelBlock = null;
      if (line === "default:") {
        section = "default";
        continue;
      }
      if (line === "providers:") {
        section = "providers";
        continue;
      }
      throw new Error(`Provider config parse error on line ${index + 1}: expected default: or providers:.`);
    }

    if (section === "default") {
      if (indent !== 2) throw new Error(`Provider config parse error on line ${index + 1}: default fields use two spaces.`);
      const [key, value] = readKeyValue(line, index, path);
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
        currentList = "models";
        continue;
      }
      currentList = null;
      const [key, value] = readKeyValue(line, index, path);
      if (key === "protocol") currentProvider.protocol = readProtocol(value, `provider ${currentProvider.id}`);
      else if (key === "baseUrl") currentProvider.baseUrl = value;
      else if (key === "apiKeyEnv") currentProvider.apiKeyEnv = value;
      else if (key === "authMethod") currentProvider.authMethod = readAuthMethod(value, `provider ${currentProvider.id}`);
      else if (key === "userAgent") currentProvider.userAgent = readUserAgent(value, `provider ${currentProvider.id}`);
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
        currentProvider.models = [...(currentProvider.models ?? []), { id: unquote(entry) }];
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

function readProtocol(value: string, field: string): ProviderProtocol {
  if (value !== "openai-chat-compatible" && value !== "anthropic-messages" && value !== "gemini-generate-content") {
    throw new Error(`Unsupported provider protocol "${value}" in ${field}.`);
  }
  return value;
}

function readAuthMethod(value: string, field: string): ProviderAuthMethod {
  if (value !== "bearer" && value !== "x-api-key" && value !== "x-goog-api-key") {
    throw new Error(`Unsupported provider authMethod "${value}" in ${field}.`);
  }
  return value;
}

function readUserAgent(value: string, field: string): string {
  if (/[\x00-\x1f\x7f]/.test(value)) {
    throw new Error(`Provider ${field} userAgent contains an invalid control character.`);
  }
  return value;
}

function readKeyValue(line: string, index: number, path: string): [string, string] {
  const colon = line.indexOf(":");
  if (colon === -1) throw new Error(`Provider config parse error on line ${index + 1} in ${path}: missing colon.`);
  const key = line.slice(0, colon).trim();
  const value = unquote(line.slice(colon + 1).trim());
  if (!value) throw new Error(`Provider config parse error on line ${index + 1} in ${path}: empty value for ${key}.`);
  return [key, value];
}

function readGenerationField(key: string, value: string, index: number, path: string): GenerationDefaults {
  if (key === "temperature") return { temperature: readFiniteNumber(value, key, index, path) };
  if (key === "maxTokens") return { maxTokens: readPositiveInteger(value, key, index, path) };
  throw new Error(`Provider config parse error on line ${index + 1} in ${path}: unknown generation field "${key}".`);
}

function readCapabilityField(key: string, value: string, index: number, path: string): ModelCapabilities {
  const enabled = readBoolean(value, key, index, path);
  if (key === "streaming") return { streaming: enabled };
  if (key === "tools") return { tools: enabled };
  if (key === "reasoningTier") return { reasoningTier: enabled };
  if (key === "reasoningContent") return { reasoningContent: enabled };
  if (key === "temperature") return { temperature: enabled };
  if (key === "maxTokens") return { maxTokens: enabled };
  if (key === "vision") return { vision: enabled };
  throw new Error(`Provider config parse error on line ${index + 1} in ${path}: unknown capability field "${key}".`);
}

function readLimitsField(key: string, value: string, index: number, path: string): ModelLimits {
  if (key === "contextWindow") return { contextWindow: readPositiveInteger(value, key, index, path) };
  if (key === "maxOutputTokens") return { maxOutputTokens: readPositiveInteger(value, key, index, path) };
  throw new Error(`Provider config parse error on line ${index + 1} in ${path}: unknown limits field "${key}".`);
}

function readAutoCompactField(key: string, value: string, index: number, path: string): AutoCompactLimits {
  if (key === "enabled") return { enabled: readBoolean(value, key, index, path) };
  if (key === "threshold") return { threshold: readFraction(value, key, index, path) };
  if (key === "reserveOutputTokens") return { reserveOutputTokens: readPositiveInteger(value, key, index, path) };
  throw new Error(`Provider config parse error on line ${index + 1} in ${path}: unknown autoCompact field "${key}".`);
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

function stripComment(line: string): string {
  let quote: "\"" | "'" | null = null;
  for (let index = 0; index < line.length; index++) {
    const char = line[index];
    if ((char === "\"" || char === "'") && (index === 0 || line[index - 1] !== "\\")) {
      quote = quote === char ? null : quote ?? char;
      continue;
    }
    if (char === "#" && quote === null) return line.slice(0, index);
  }
  return line;
}

function leadingSpaces(line: string): number {
  const match = line.match(/^ */);
  return match ? match[0].length : 0;
}

function unquote(value: string): string {
  if (value.startsWith("\"") && value.endsWith("\"")) {
    try {
      const parsed = JSON.parse(value) as unknown;
      if (typeof parsed === "string") return parsed;
    } catch {
      return value.slice(1, -1);
    }
  }
  if (value.startsWith("'") && value.endsWith("'")) {
    return value.slice(1, -1).replace(/''/g, "'");
  }
  return value;
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}
