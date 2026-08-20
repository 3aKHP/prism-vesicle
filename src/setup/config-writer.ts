import { randomUUID } from "node:crypto";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import type { PermissionMode } from "../core/permissions";
import type { EngineId } from "../core/engine/profile";
import { userConfigDirectory } from "../config/paths";
import {
  loadProviderRegistry,
  parseEnvFile,
  parseProviderConfig,
  providerConfigPathFromEnv,
  serializeProviderModelLines,
  type ProviderProfile,
  type ProviderRegistry,
} from "../config/providers";
import { parseMcpConfig, mcpConfigPathFromEnv } from "../mcp/config";
import { appendMcpServerBlock, mcpTokenEnvKey, serializeMcpServerBlock, type McpServerBlock } from "../mcp/config-edit";
import { loadPermissionSettings } from "../config/permissions";
import { atomicWrite } from "../config/atomic-write";
import { readOptionalText as readOptional } from "../config/file-read";
import { sanitizeId, uniqueId, yamlKey, yamlScalar } from "../config/yaml-writer";

export type SetupMcpServer = {
  name: string;
  url: string;
  auth: "none" | "bearer" | "custom-header";
  headerName?: string;
  secret?: string;
  enabledEngines: EngineId[];
};

export type SetupConfiguration = {
  providerPreset?: SetupProviderPreset;
  baseUrl: string;
  apiKey: string;
  modelIds: string[];
  defaultModel: string;
  tavilyApiKey?: string;
  mcpServers?: SetupMcpServer[];
  permissionMode: Exclude<PermissionMode, "YOLO">;
  projectDirectory?: string;
};

export type SetupProviderPreset = "chat-compatible" | "openai-responses" | "mimo-responses" | "deepseek-responses";

export type SetupWriteResult = {
  providerId: string;
  providerPath: string;
  envPath: string;
  permissionsPath: string;
  mcpPath?: string;
  projectDirectory?: string;
  backups: string[];
};

export async function writeSetupConfiguration(
  input: SetupConfiguration,
  env: NodeJS.ProcessEnv = process.env,
): Promise<SetupWriteResult> {
  validateSetupInput(input);
  const configDir = userConfigDirectory(env);
  const providerPath = providerConfigPathFromEnv(env);
  const envPath = join(dirname(providerPath), ".env");
  const permissionsPath = join(configDir, "permissions.yaml");
  const mcpPath = mcpConfigPathFromEnv(env);
  await mkdir(configDir, { recursive: true });

  const existingRegistry = await loadExistingRegistry(providerPath, env);
  const merged = mergeProvider(existingRegistry, input);
  const existingEnv = await readOptional(envPath);
  const existingPermissions = await loadPermissionSettings(env);
  const envUpdates: Record<string, string> = {
    [merged.apiKeyEnv]: input.apiKey,
    ...(input.tavilyApiKey?.trim() ? { TAVILY_API_KEY: input.tavilyApiKey.trim() } : {}),
  };

  const shouldWriteMcp = (input.mcpServers?.length ?? 0) > 0;
  let mcpSource = shouldWriteMcp ? await readOptional(mcpPath) : undefined;
  for (const server of input.mcpServers ?? []) {
    const addition = mcpAddition(server, mcpSource, { ...env, ...parseEnvFile(setEnvValues(existingEnv ?? "", envUpdates), envPath) });
    mcpSource = addition.source;
    Object.assign(envUpdates, addition.envUpdates);
  }

  const providerSource = serializeProviderRegistry(merged.registry);
  const envSource = setEnvValues(existingEnv ?? "", envUpdates);
  const permissionsSource = [
    "version: 1",
    `defaultMode: ${input.permissionMode}`,
    `shellExec: ${existingPermissions.exists ? existingPermissions.shellExec : false}`,
    `shellInterpreter: ${existingPermissions.exists ? existingPermissions.shellInterpreter : "auto"}`,
    "",
  ].join("\n");

  parseProviderConfig(providerSource, providerPath, { ...env, ...parseEnvFile(envSource, envPath) });
  if (mcpSource !== undefined) parseMcpConfig(mcpSource, mcpPath, { ...env, ...parseEnvFile(envSource, envPath) });

  const writes = [
    { path: providerPath, source: providerSource, secret: false },
    { path: envPath, source: envSource, secret: true },
    { path: permissionsPath, source: permissionsSource, secret: false },
    ...(!shouldWriteMcp || mcpSource === undefined ? [] : [{ path: mcpPath, source: mcpSource, secret: false }]),
  ];
  if (input.projectDirectory) await mkdir(input.projectDirectory, { recursive: true });
  const backups = await replaceFilesTransaction(writes);

  return {
    providerId: merged.providerId,
    providerPath,
    envPath,
    permissionsPath,
    ...(!shouldWriteMcp ? {} : { mcpPath }),
    ...(input.projectDirectory ? { projectDirectory: input.projectDirectory } : {}),
    backups,
  };
}

export function providerIdFromBaseUrl(baseUrl: string): string {
  const host = new URL(baseUrl).hostname.toLowerCase();
  const labels = host.split(".").filter(Boolean);
  const withoutCommon = labels.filter((part, index) => !(index === 0 && (part === "api" || part === "www")));
  const meaningful = withoutCommon.length > 1 ? withoutCommon.slice(0, -1) : withoutCommon;
  return sanitizeId(meaningful.join("-") || "provider");
}

export function setEnvValues(source: string, updates: Record<string, string>): string {
  const remaining = new Map(Object.entries(updates));
  const lines = source ? source.replace(/\r\n/g, "\n").split("\n") : [];
  const output = lines.map((line) => {
    const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line);
    if (!match || !remaining.has(match[1])) return line;
    const value = remaining.get(match[1])!;
    remaining.delete(match[1]);
    return `${match[1]}=${dotenvScalar(value)}`;
  });
  while (output.length > 0 && output[output.length - 1] === "") output.pop();
  for (const [key, value] of remaining) output.push(`${key}=${dotenvScalar(value)}`);
  return `${output.join("\n")}\n`;
}

/**
 * Shared provider-registry write pipeline for config CLI commands:
 * serialize → validate by re-parsing (before touching disk) → atomic write →
 * reload to confirm the round-trip. A failed cross-field constraint throws
 * before any bytes land on disk, leaving the existing providers.yaml intact.
 */
export async function writeProviderRegistry(registry: ProviderRegistry): Promise<string> {
  const path = providerConfigPathFromEnv();
  const source = serializeProviderRegistry(registry);
  parseProviderConfig(source, path, process.env);
  await atomicWrite(path, source);
  await loadProviderRegistry();
  return path;
}

export async function editProviderRegistrySource(
  edit: (source: string, registry: ProviderRegistry) => string,
): Promise<string> {
  const path = providerConfigPathFromEnv();
  const source = await readOptional(path);
  if (source === undefined) throw new Error(`Provider config does not exist at ${path}.`);
  const registry = await loadProviderRegistry();
  const candidate = edit(source, registry);
  parseProviderConfig(candidate, path, process.env);
  await atomicWrite(path, candidate);
  await loadProviderRegistry();
  return path;
}

export function serializeProviderRegistry(registry: ProviderRegistry): string {
  const lines = [
    "default:",
    `  provider: ${yamlScalar(registry.default.provider)}`,
    `  model: ${yamlScalar(registry.default.model)}`,
    "",
    "providers:",
  ];
  for (const provider of registry.providers) {
    lines.push(`  ${yamlKey(provider.id)}:`);
    lines.push(`    protocol: ${provider.protocol}`);
    lines.push(`    baseUrl: ${yamlScalar(provider.baseUrl)}`);
    lines.push(`    apiKeyEnv: ${provider.apiKeyEnv}`);
    if (provider.authMethod) lines.push(`    authMethod: ${provider.authMethod}`);
    if (provider.userAgent) lines.push(`    userAgent: ${yamlScalar(provider.userAgent)}`);
    if (provider.responsesProfile) lines.push(`    responsesProfile: ${provider.responsesProfile}`);
    if (provider.responsesTransport) lines.push(`    responsesTransport: ${provider.responsesTransport}`);
    if (provider.defaultModel) lines.push(`    defaultModel: ${yamlScalar(provider.defaultModel)}`);
    lines.push("    models:");
    for (const model of provider.models) lines.push(...serializeProviderModelLines(model));
  }
  return `${lines.join("\n")}\n`;
}

function mergeProvider(
  registry: ProviderRegistry | undefined,
  input: SetupConfiguration,
): { registry: ProviderRegistry; providerId: string; apiKeyEnv: string } {
  const baseUrl = input.baseUrl.replace(/\/+$/, "");
  const current = registry?.providers.find((provider) => provider.baseUrl.replace(/\/+$/, "") === baseUrl);
  const usedIds = new Set(registry?.providers.map((provider) => provider.id) ?? []);
  const providerId = current?.id ?? uniqueId(providerIdFromBaseUrl(baseUrl), usedIds);
  const apiKeyEnv = current?.apiKeyEnv ?? `${providerId.replace(/[^A-Za-z0-9]+/g, "_").toUpperCase()}_API_KEY`;
  const existingModels = new Map(current?.models.map((model) => [model.id, model]) ?? []);
  if (current?.protocol === "openai-responses" && input.providerPreset === "chat-compatible") {
    throw new Error(`Setup will not replace existing Responses provider "${current.id}" with Chat Completions. Select its Responses protocol or use a different endpoint.`);
  }
  const preset = input.providerPreset ?? presetFromProvider(current) ?? "chat-compatible";
  const preserveExistingResponses = current?.protocol === "openai-responses"
    && (input.providerPreset === undefined || input.providerPreset === presetFromProvider(current));
  const preservedResponses = preserveExistingResponses
    ? {
        ...(current.authMethod ? { authMethod: current.authMethod } : {}),
        ...(current.userAgent ? { userAgent: current.userAgent } : {}),
        responsesProfile: current.responsesProfile,
        responsesTransport: current.responsesTransport,
      }
    : {};
  const models = [...new Set(input.modelIds.map((model) => model.trim()).filter(Boolean))]
    .map((id) => existingModels.get(id) ?? { id });
  if (preset === "deepseek-responses" && models.some((model) => model.id !== "deepseek-v4-flash" && model.id !== "deepseek-v4-pro")) {
    throw new Error("DeepSeek Responses currently supports only deepseek-v4-flash and deepseek-v4-pro; deselect other models before saving.");
  }
  const profile: ProviderProfile = {
    id: providerId,
    protocol: preset === "chat-compatible" ? "openai-chat-compatible" : "openai-responses",
    baseUrl,
    apiKeyEnv,
    ...(preserveExistingResponses
      ? preservedResponses
      : preset === "openai-responses"
        ? { responsesProfile: "openai-public" as const, responsesTransport: "http" as const }
        : preset === "mimo-responses"
          ? {
              authMethod: "x-api-key" as const,
              responsesProfile: "mimo-subset-2026-07-30" as const,
              responsesTransport: "http" as const,
            }
          : preset === "deepseek-responses"
            ? {
                responsesProfile: "deepseek-subset-2026-08-19" as const,
                responsesTransport: "http" as const,
              }
          : {}),
    defaultModel: input.defaultModel,
    models,
  };
  const providers = registry
    ? registry.providers.map((provider) => provider.id === providerId ? profile : provider)
    : [profile];
  if (registry && !current) providers.push(profile);
  return {
    providerId,
    apiKeyEnv,
    registry: {
      source: "file",
      path: registry?.path,
      default: { provider: providerId, model: input.defaultModel },
      providers,
    },
  };
}

function presetFromProvider(provider: ProviderProfile | undefined): SetupProviderPreset | undefined {
  if (!provider) return undefined;
  if (provider.protocol === "openai-chat-compatible") return "chat-compatible";
  if (provider.responsesProfile === "openai-public") return "openai-responses";
  if (provider.responsesProfile === "mimo-subset-2026-07-30") return "mimo-responses";
  if (provider.responsesProfile === "deepseek-subset-2026-07-31"
    || provider.responsesProfile === "deepseek-subset-2026-08-19") return "deepseek-responses";
  if (provider.responsesProfile === "codex-http-relay" || provider.responsesProfile === "codex-beta-2026-02-06") {
    return "openai-responses";
  }
  return undefined;
}

function mcpAddition(
  server: SetupMcpServer,
  existingSource: string | undefined,
  env: NodeJS.ProcessEnv,
): { source: string; envUpdates: Record<string, string> } {
  validateMcpServer(server);
  const parsed = existingSource === undefined ? undefined : parseMcpConfig(existingSource, "mcp.yaml", env);
  const id = uniqueId(sanitizeId(server.name), new Set(parsed?.servers.map((entry) => entry.id) ?? []));
  const envUpdates: Record<string, string> = {};
  const block: McpServerBlock = {
    id,
    enabled: true,
    transport: "streamable-http",
    url: server.url.trim(),
    negotiation: "auto",
  };
  if (server.auth !== "none") {
    const envKey = mcpTokenEnvKey(id);
    envUpdates[envKey] = server.secret!.trim();
    const header = server.auth === "bearer" ? "Authorization" : server.headerName!.trim();
    const prefix = server.auth === "bearer" ? "Bearer " : "";
    block.headers = { [header]: `${prefix}\${${envKey}}` };
  }
  block.enabledEngines = server.enabledEngines;

  const lines = serializeMcpServerBlock(block);
  const source = appendMcpServerBlock(existingSource, lines);
  parseMcpConfig(source, "mcp.yaml", { ...env, ...envUpdates });
  return { source, envUpdates };
}

async function loadExistingRegistry(path: string, env: NodeJS.ProcessEnv): Promise<ProviderRegistry | undefined> {
  if (await readOptional(path) === undefined) return undefined;
  return loadProviderRegistry(env);
}

async function replaceFilesTransaction(
  writes: Array<{ path: string; source: string; secret: boolean }>,
): Promise<string[]> {
  const snapshots = new Map<string, string | undefined>();
  const temps: string[] = [];
  const backups: string[] = [];
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  try {
    for (const write of writes) {
      await mkdir(dirname(write.path), { recursive: true });
      const original = await readOptional(write.path);
      snapshots.set(write.path, original);
      if (original !== undefined) {
        const backup = `${write.path}.backup-${stamp}`;
        await writeFile(backup, original, { encoding: "utf8", flag: "wx", mode: write.secret ? 0o600 : 0o644 });
        backups.push(backup);
      }
      const temp = join(dirname(write.path), `.${basename(write.path)}.${process.pid}.${randomUUID()}.tmp`);
      await writeFile(temp, write.source, { encoding: "utf8", flag: "wx", mode: write.secret ? 0o600 : 0o644 });
      temps.push(temp);
    }
    for (let index = 0; index < writes.length; index++) await rename(temps[index], writes[index].path);
    return backups;
  } catch (error) {
    await Promise.all(temps.map((path) => rm(path, { force: true }).catch(() => undefined)));
    const restored = await Promise.allSettled([...snapshots].map(([path, original]) => (
      original === undefined
        ? rm(path, { force: true })
        : writeFile(path, original, "utf8")
    )));
    if (restored.every((result) => result.status === "fulfilled")) {
      await Promise.all(backups.map((path) => rm(path, { force: true }).catch(() => undefined)));
    }
    throw error;
  }
}

function validateSetupInput(input: SetupConfiguration): void {
  if (!input.baseUrl.trim()) throw new Error("Base URL is required.");
  if (!input.apiKey.trim()) throw new Error("API key is required.");
  if (input.modelIds.length === 0) throw new Error("Select or add at least one model.");
  if (!input.modelIds.includes(input.defaultModel)) throw new Error("Default model must be one of the selected models.");
  if ((input.permissionMode as string) === "YOLO") throw new Error("YOLO cannot be saved by Setup.");
  if (input.projectDirectory !== undefined && !input.projectDirectory.trim()) {
    throw new Error("Project directory must not be empty when provided.");
  }
}

function validateMcpServer(server: SetupMcpServer): void {
  if (!server.name.trim()) throw new Error("MCP server name is required.");
  const url = new URL(server.url);
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("MCP URL must use http:// or https://.");
  if (server.auth !== "none" && !server.secret?.trim()) throw new Error("MCP authentication secret is required.");
  if (server.auth === "custom-header" && !server.headerName?.trim()) throw new Error("MCP custom header name is required.");
}

function dotenvScalar(value: string): string {
  if (/^[A-Za-z0-9_./:@+\-=]+$/.test(value)) return value;
  return JSON.stringify(value);
}
