import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import type { PermissionMode } from "../core/permissions";
import type { EngineId } from "../core/engine/profile";
import { userConfigDirectory } from "../config/paths";
import {
  loadProviderRegistry,
  parseEnvFile,
  parseProviderConfig,
  providerConfigPathFromEnv,
  type ProviderModelProfile,
  type ProviderProfile,
  type ProviderRegistry,
} from "../config/providers";
import { parseMcpConfig, mcpConfigPathFromEnv } from "../mcp/config";

export type SetupMcpServer = {
  name: string;
  url: string;
  auth: "none" | "bearer" | "custom-header";
  headerName?: string;
  secret?: string;
  enabledEngines: EngineId[];
};

export type SetupConfiguration = {
  baseUrl: string;
  apiKey: string;
  modelIds: string[];
  defaultModel: string;
  tavilyApiKey?: string;
  mcpServers?: SetupMcpServer[];
  permissionMode: Exclude<PermissionMode, "YOLO">;
  projectDirectory: string;
};

export type SetupWriteResult = {
  providerId: string;
  providerPath: string;
  envPath: string;
  permissionsPath: string;
  statePath: string;
  mcpPath?: string;
  projectDirectory: string;
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
  const statePath = join(configDir, "setup-state.json");
  const mcpPath = mcpConfigPathFromEnv(env);
  await mkdir(configDir, { recursive: true });

  const existingRegistry = await loadExistingRegistry(providerPath, env);
  const merged = mergeProvider(existingRegistry, input);
  const existingEnv = await readOptional(envPath);
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
  const permissionsSource = `version: 1\ndefaultMode: ${input.permissionMode}\nshellExec: false\n`;
  const stateSource = `${JSON.stringify({ version: 1, projectDirectory: input.projectDirectory }, null, 2)}\n`;

  parseProviderConfig(providerSource, providerPath, { ...env, ...parseEnvFile(envSource, envPath) });
  if (mcpSource !== undefined) parseMcpConfig(mcpSource, mcpPath, { ...env, ...parseEnvFile(envSource, envPath) });

  const writes = [
    { path: providerPath, source: providerSource, secret: false },
    { path: envPath, source: envSource, secret: true },
    { path: permissionsPath, source: permissionsSource, secret: false },
    { path: statePath, source: stateSource, secret: false },
    ...(!shouldWriteMcp || mcpSource === undefined ? [] : [{ path: mcpPath, source: mcpSource, secret: false }]),
  ];
  await mkdir(input.projectDirectory, { recursive: true });
  const backups = await replaceFilesTransaction(writes);

  return {
    providerId: merged.providerId,
    providerPath,
    envPath,
    permissionsPath,
    statePath,
    ...(!shouldWriteMcp ? {} : { mcpPath }),
    projectDirectory: input.projectDirectory,
    backups,
  };
}

export async function readSetupState(
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ version: 1; projectDirectory: string } | undefined> {
  const path = join(userConfigDirectory(env), "setup-state.json");
  const source = await readOptional(path);
  if (source === undefined) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch {
    throw new Error(`Setup state is not valid JSON: ${path}.`);
  }
  if (!parsed || typeof parsed !== "object" || (parsed as { version?: unknown }).version !== 1) {
    throw new Error(`Setup state has an unsupported version: ${path}.`);
  }
  const projectDirectory = (parsed as { projectDirectory?: unknown }).projectDirectory;
  if (typeof projectDirectory !== "string" || !projectDirectory.trim()) {
    throw new Error(`Setup state is missing projectDirectory: ${path}.`);
  }
  return { version: 1, projectDirectory };
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
    if (provider.defaultModel) lines.push(`    defaultModel: ${yamlScalar(provider.defaultModel)}`);
    lines.push("    models:");
    for (const model of provider.models) serializeModel(lines, model);
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
  const models = [...new Set(input.modelIds.map((model) => model.trim()).filter(Boolean))]
    .map((id) => existingModels.get(id) ?? { id });
  const profile: ProviderProfile = {
    id: providerId,
    protocol: "openai-chat-compatible",
    baseUrl,
    apiKeyEnv,
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

function serializeModel(lines: string[], model: ProviderModelProfile): void {
  const structured = model.generation || model.capabilities || model.limits;
  if (!structured) {
    lines.push(`      - ${yamlScalar(model.id)}`);
    return;
  }
  lines.push(`      - id: ${yamlScalar(model.id)}`);
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
      const compact = model.limits.autoCompact;
      if (compact.enabled !== undefined) lines.push(`            enabled: ${compact.enabled}`);
      if (compact.threshold !== undefined) lines.push(`            threshold: ${compact.threshold}`);
      if (compact.reserveOutputTokens !== undefined) lines.push(`            reserveOutputTokens: ${compact.reserveOutputTokens}`);
    }
  }
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
  const lines = [`  ${yamlKey(id)}:`, "    enabled: true", "    transport: streamable-http", `    url: ${yamlScalar(server.url.trim())}`];
  if (server.auth !== "none") {
    const envKey = `MCP_${id.replace(/[^A-Za-z0-9]+/g, "_").toUpperCase()}_TOKEN`;
    envUpdates[envKey] = server.secret!.trim();
    const header = server.auth === "bearer" ? "Authorization" : server.headerName!.trim();
    const prefix = server.auth === "bearer" ? "Bearer " : "";
    lines.push("    headers:", `      ${yamlKey(header)}: ${yamlScalar(`${prefix}\${${envKey}}`)}`);
  }
  lines.push("    enabledEngines:");
  for (const engine of server.enabledEngines) lines.push(`      - ${engine}`);

  let source = existingSource?.replace(/\r\n/g, "\n").replace(/\s*$/, "") ?? "enabled: true\n\nservers:";
  if (existingSource !== undefined && parsed && !parsed.enabled) {
    source = source.replace(/^enabled:\s*false(?:\s+#.*)?$/m, "enabled: true");
  }
  if (!/^servers:\s*$/m.test(source)) source += "\n\nservers:";
  source = `${source}\n${lines.join("\n")}\n`;
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
    for (const write of writes) {
      const original = snapshots.get(write.path);
      if (original === undefined) await rm(write.path, { force: true }).catch(() => undefined);
      else await writeFile(write.path, original, "utf8").catch(() => undefined);
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
  if (!input.projectDirectory.trim()) throw new Error("Project directory is required.");
}

function validateMcpServer(server: SetupMcpServer): void {
  if (!server.name.trim()) throw new Error("MCP server name is required.");
  const url = new URL(server.url);
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("MCP URL must use http:// or https://.");
  if (server.auth !== "none" && !server.secret?.trim()) throw new Error("MCP authentication secret is required.");
  if (server.auth === "custom-header" && !server.headerName?.trim()) throw new Error("MCP custom header name is required.");
}

function uniqueId(base: string, used: Set<string>): string {
  if (!used.has(base)) return base;
  let suffix = 2;
  while (used.has(`${base}-${suffix}`)) suffix += 1;
  return `${base}-${suffix}`;
}

function sanitizeId(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "") || "service";
}

function yamlKey(value: string): string {
  return /^[A-Za-z0-9_-]+$/.test(value) ? value : yamlScalar(value);
}

function yamlScalar(value: string): string {
  if (/^[A-Za-z0-9_./:@+${}-]+$/.test(value)) return value;
  return JSON.stringify(value);
}

function dotenvScalar(value: string): string {
  if (/^[A-Za-z0-9_./:@+\-=]+$/.test(value)) return value;
  return JSON.stringify(value);
}

async function readOptional(path: string): Promise<string | undefined> {
  return readFile(path, "utf8").catch((error: unknown) => {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return undefined;
    throw error;
  });
}
