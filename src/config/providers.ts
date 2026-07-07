import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { VesicleConfig, VesicleProvider } from "./env";

export type ProviderProtocol = VesicleProvider;

export type ProviderSelection = {
  provider: string;
  model: string;
};

export type ProviderProfile = {
  id: string;
  protocol: ProviderProtocol;
  baseUrl: string;
  apiKey?: string;
  apiKeyEnv?: string;
  models: string[];
};

export type ProviderRegistry = {
  default: ProviderSelection;
  providers: ProviderProfile[];
  source: "file" | "environment";
  path?: string;
};

export type ProviderConfigStatus = VesicleConfig & {
  hasApiKey: boolean;
  missing: string[];
  registry: ProviderRegistry;
};

export async function loadProviderRegistry(
  rootDir = process.cwd(),
  env: NodeJS.ProcessEnv = process.env,
): Promise<ProviderRegistry> {
  const configPath = providerConfigPath(rootDir);
  const source = await readFile(configPath, "utf8").catch((error: unknown) => {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return undefined;
    throw error;
  });
  if (!source) return legacyRegistryFromEnv(env);
  return parseProviderConfig(source, configPath);
}

export async function loadConfigForSelection(
  rootDir = process.cwd(),
  selection?: Partial<ProviderSelection>,
  env: NodeJS.ProcessEnv = process.env,
): Promise<VesicleConfig> {
  const registry = await loadProviderRegistry(rootDir, env);
  return resolveProviderConfig(registry, selection, env);
}

export async function inspectProviderConfig(
  rootDir = process.cwd(),
  selection?: Partial<ProviderSelection>,
  env: NodeJS.ProcessEnv = process.env,
): Promise<ProviderConfigStatus> {
  const registry = await loadProviderRegistry(rootDir, env);
  const config = resolveProviderConfig(registry, selection, env);
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
  };
}

export function resolveProviderConfig(
  registry: ProviderRegistry,
  selection: Partial<ProviderSelection> | undefined,
  env: NodeJS.ProcessEnv = process.env,
): VesicleConfig {
  const providerId = selection?.provider ?? registry.default.provider;
  const profile = requireProvider(registry, providerId);
  const model = selection?.model ?? (providerId === registry.default.provider ? registry.default.model : profile.models[0]);
  if (!model) {
    throw new Error(`Provider "${providerId}" does not declare any models.`);
  }
  if (!profile.models.includes(model)) {
    throw new Error(`Provider "${providerId}" does not declare model "${model}".`);
  }

  return {
    provider: profile.protocol,
    providerId,
    baseUrl: trimTrailingSlash(profile.baseUrl),
    model,
    apiKey: profile.apiKey ?? (profile.apiKeyEnv ? env[profile.apiKeyEnv] : undefined),
    apiKeyLabel: profile.apiKeyEnv ?? "apiKey",
  };
}

export function providerConfigPath(rootDir = process.cwd()): string {
  return join(rootDir, ".vesicle", "providers.yaml");
}

function legacyRegistryFromEnv(env: NodeJS.ProcessEnv): ProviderRegistry {
  const protocol = readProtocol(env.VESICLE_PROVIDER ?? "openai-chat-compatible", "VESICLE_PROVIDER");
  const providerId = env.VESICLE_PROVIDER_ID ?? "default";
  const model = env.VESICLE_MODEL ?? "gpt-4.1-mini";
  return {
    source: "environment",
    default: { provider: providerId, model },
    providers: [{
      id: providerId,
      protocol,
      baseUrl: env.VESICLE_BASE_URL ?? "https://api.openai.com/v1",
      apiKeyEnv: "VESICLE_API_KEY",
      models: [model],
    }],
  };
}

function parseProviderConfig(source: string, path: string): ProviderRegistry {
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

  const finishProvider = () => {
    if (!currentProvider) return;
    const id = currentProvider.id;
    if (!id) throw new Error(`Provider config ${path} has a provider without an id.`);
    const protocol = currentProvider.protocol;
    if (!protocol) throw new Error(`Provider "${id}" is missing protocol.`);
    const baseUrl = currentProvider.baseUrl;
    if (!baseUrl) throw new Error(`Provider "${id}" is missing baseUrl.`);
    const models = currentProvider.models ?? [];
    if (models.length === 0) throw new Error(`Provider "${id}" must declare at least one model.`);
    registry.providers.push({
      id,
      protocol,
      baseUrl,
      apiKey: currentProvider.apiKey,
      apiKeyEnv: currentProvider.apiKeyEnv,
      models,
    });
    currentProvider = null;
    currentList = null;
  };

  for (let index = 0; index < lines.length; index++) {
    const raw = stripComment(lines[index]).replace(/\s+$/, "");
    if (!raw.trim()) continue;
    const indent = leadingSpaces(raw);
    const line = raw.trim();

    if (indent === 0) {
      finishProvider();
      currentList = null;
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
      if (line === "models:") {
        currentList = "models";
        continue;
      }
      currentList = null;
      const [key, value] = readKeyValue(line, index, path);
      if (key === "protocol") currentProvider.protocol = readProtocol(value, `provider ${currentProvider.id}`);
      else if (key === "baseUrl") currentProvider.baseUrl = value;
      else if (key === "apiKey") currentProvider.apiKey = value;
      else if (key === "apiKeyEnv") currentProvider.apiKeyEnv = value;
      else throw new Error(`Provider config parse error on line ${index + 1}: unknown provider field "${key}".`);
      continue;
    }

    if (indent === 6 && currentList === "models") {
      if (!line.startsWith("- ")) {
        throw new Error(`Provider config parse error on line ${index + 1}: model entries must start with "- ".`);
      }
      currentProvider.models = [...(currentProvider.models ?? []), unquote(line.slice(2).trim())];
      continue;
    }

    throw new Error(`Provider config parse error on line ${index + 1}: unsupported indentation.`);
  }

  finishProvider();
  if (!registry.default.provider) throw new Error(`Provider config ${path} is missing default.provider.`);
  if (!registry.default.model) throw new Error(`Provider config ${path} is missing default.model.`);
  resolveProviderConfig(registry, registry.default, process.env);
  return registry;
}

function requireProvider(registry: ProviderRegistry, providerId: string): ProviderProfile {
  const profile = registry.providers.find((entry) => entry.id === providerId);
  if (!profile) throw new Error(`Unknown provider "${providerId}".`);
  return profile;
}

function readProtocol(value: string, field: string): ProviderProtocol {
  if (value !== "openai-chat-compatible") {
    throw new Error(`Unsupported provider protocol "${value}" in ${field}.`);
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
  if ((value.startsWith("\"") && value.endsWith("\"")) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1);
  }
  return value;
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}
