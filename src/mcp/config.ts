import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { loadUserConfigEnvironment, providerConfigPathFromEnv } from "../config/providers";
import { engineIds, type EngineId } from "../core/engine/profile";
import type { McpConfig, McpServerConfig, McpTransport } from "./types";

const defaultProtocolVersion = "2025-03-26";
const defaultTimeoutSeconds = 30;

export type McpConfigLoadResult =
  | {
    configured: true;
    config: McpConfig;
    envPath: string;
    hasEnvFile: boolean;
  }
  | {
    configured: false;
    path: string;
    envPath: string;
    hasEnvFile: boolean;
  };

export async function loadMcpConfig(
  env: NodeJS.ProcessEnv = process.env,
): Promise<McpConfigLoadResult> {
  const path = mcpConfigPathFromEnv(env);
  const userEnv = await loadUserConfigEnvironment(env);
  const source = await readFile(path, "utf8").catch((error: unknown) => {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return "";
    throw error;
  });

  if (!source) {
    return {
      configured: false,
      path,
      envPath: userEnv.path,
      hasEnvFile: userEnv.exists,
    };
  }

  return {
    configured: true,
    config: parseMcpConfig(source, path, userEnv.effectiveEnv),
    envPath: userEnv.path,
    hasEnvFile: userEnv.exists,
  };
}

export function mcpConfigPathFromEnv(env: NodeJS.ProcessEnv = process.env): string {
  if (env.VESICLE_MCP_FILE) return env.VESICLE_MCP_FILE;
  return join(dirname(providerConfigPathFromEnv(env)), "mcp.yaml");
}

export function parseMcpConfig(source: string, path: string, env: NodeJS.ProcessEnv): McpConfig {
  const lines = source.split(/\r?\n/);
  let enabled = true;
  let section: "servers" | null = null;
  let currentServer: Partial<McpServerConfig> | null = null;
  let currentNested: "headers" | "includeTools" | "excludeTools" | "enabledEngines" | null = null;
  const servers: McpServerConfig[] = [];

  const finishServer = () => {
    if (!currentServer) return;
    const id = currentServer.id;
    if (!id) throw new Error(`MCP config ${path} has a server without an id.`);
    if (servers.some((server) => server.id === id)) throw new Error(`Duplicate MCP server id "${id}".`);
    const transport = currentServer.transport ?? "streamable-http";
    if (!currentServer.url) throw new Error(`MCP server "${id}" is missing url.`);
    servers.push({
      id,
      enabled: currentServer.enabled ?? true,
      transport,
      url: currentServer.url,
      headers: currentServer.headers ?? {},
      timeoutSeconds: currentServer.timeoutSeconds ?? defaultTimeoutSeconds,
      protocolVersion: currentServer.protocolVersion ?? defaultProtocolVersion,
      ...(currentServer.toolPrefix ? { toolPrefix: currentServer.toolPrefix } : {}),
      includeTools: currentServer.includeTools ?? [],
      excludeTools: currentServer.excludeTools ?? [],
      enabledEngines: currentServer.enabledEngines ?? [],
    });
    currentServer = null;
    currentNested = null;
  };

  for (let index = 0; index < lines.length; index++) {
    const raw = stripComment(lines[index]).replace(/\s+$/, "");
    if (!raw.trim()) continue;
    const indent = leadingSpaces(raw);
    const line = raw.trim();

    if (indent === 0) {
      finishServer();
      currentNested = null;
      if (line === "servers:") {
        section = "servers";
        continue;
      }
      const [key, value] = readKeyValue(line, index, path);
      if (key === "enabled") {
        enabled = readBoolean(value, index, path);
        section = null;
        continue;
      }
      throw new Error(`MCP config parse error on line ${index + 1}: expected enabled: or servers:.`);
    }

    if (section !== "servers") {
      throw new Error(`MCP config parse error on line ${index + 1}: field outside servers:.`);
    }

    if (indent === 2) {
      finishServer();
      if (!line.endsWith(":")) throw new Error(`MCP config parse error on line ${index + 1}: server id must end with colon.`);
      currentServer = {
        id: line.slice(0, -1).trim(),
        headers: {},
        includeTools: [],
        excludeTools: [],
        enabledEngines: [],
      };
      continue;
    }

    if (!currentServer) throw new Error(`MCP config parse error on line ${index + 1}: server field without server id.`);

    if (indent === 4) {
      if (line === "headers:") {
        currentNested = "headers";
        currentServer.headers = currentServer.headers ?? {};
        continue;
      }
      if (line === "includeTools:" || line === "include_tools:" || line === "allowedTools:" || line === "allowed_tools:") {
        currentNested = "includeTools";
        currentServer.includeTools = currentServer.includeTools ?? [];
        continue;
      }
      if (line === "excludeTools:" || line === "exclude_tools:") {
        currentNested = "excludeTools";
        currentServer.excludeTools = currentServer.excludeTools ?? [];
        continue;
      }
      if (line === "enabledEngines:" || line === "enabled_engines:") {
        currentNested = "enabledEngines";
        currentServer.enabledEngines = currentServer.enabledEngines ?? [];
        continue;
      }
      currentNested = null;
      const [key, rawValue] = readKeyValue(line, index, path);
      const value = expandEnv(unquote(rawValue), env, index, path);
      if (key === "enabled") currentServer.enabled = readBoolean(value, index, path);
      else if (key === "transport") currentServer.transport = readTransport(value, index, path);
      else if (key === "url") currentServer.url = value;
      else if (key === "timeoutSeconds" || key === "timeout_seconds") currentServer.timeoutSeconds = readPositiveNumber(value, key, index, path);
      else if (key === "protocolVersion" || key === "protocol_version") currentServer.protocolVersion = value;
      else if (key === "toolPrefix" || key === "tool_prefix") currentServer.toolPrefix = value || undefined;
      else if (key === "includeTools" || key === "include_tools" || key === "allowedTools" || key === "allowed_tools") {
        currentServer.includeTools = readInlineList(value, index, path);
      } else if (key === "excludeTools" || key === "exclude_tools") {
        currentServer.excludeTools = readInlineList(value, index, path);
      } else if (key === "enabledEngines" || key === "enabled_engines") {
        currentServer.enabledEngines = readEngineList(readInlineList(value, index, path), index, path);
      } else {
        throw new Error(`MCP config parse error on line ${index + 1}: unknown server field "${key}".`);
      }
      continue;
    }

    if (indent === 6 && currentNested === "headers") {
      const [key, value] = readKeyValue(line, index, path);
      currentServer.headers = {
        ...(currentServer.headers ?? {}),
        [key]: expandEnv(unquote(value), env, index, path),
      };
      continue;
    }

    if (indent === 6 && currentNested && currentNested !== "headers") {
      if (!line.startsWith("- ")) throw new Error(`MCP config parse error on line ${index + 1}: list entries must start with "- ".`);
      const value = expandEnv(unquote(line.slice(2).trim()), env, index, path);
      if (currentNested === "includeTools") currentServer.includeTools = [...(currentServer.includeTools ?? []), value];
      if (currentNested === "excludeTools") currentServer.excludeTools = [...(currentServer.excludeTools ?? []), value];
      if (currentNested === "enabledEngines") currentServer.enabledEngines = readEngineList([...(currentServer.enabledEngines ?? []), value], index, path);
      continue;
    }

    throw new Error(`MCP config parse error on line ${index + 1}: unsupported indentation.`);
  }

  finishServer();
  return { enabled, path, servers };
}

function readTransport(value: string, index: number, path: string): McpTransport {
  const normalized = value.trim();
  if (normalized === "http" || normalized === "streamable-http") return "streamable-http";
  throw new Error(`MCP config parse error on line ${index + 1} in ${path}: unsupported transport "${value}".`);
}

function readEngineList(values: string[], index: number, path: string): EngineId[] {
  const engines: EngineId[] = [];
  for (const value of values) {
    const engine = value.trim();
    if (!engine) continue;
    if (!engineIds.includes(engine as EngineId)) {
      throw new Error(`MCP config parse error on line ${index + 1} in ${path}: unknown engine "${engine}".`);
    }
    if (!engines.includes(engine as EngineId)) engines.push(engine as EngineId);
  }
  return engines;
}

function readPositiveNumber(value: string, key: string, index: number, path: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`MCP config parse error on line ${index + 1} in ${path}: ${key} must be a positive number.`);
  }
  return parsed;
}

function readBoolean(value: string, index: number, path: string): boolean {
  if (value === "true") return true;
  if (value === "false") return false;
  throw new Error(`MCP config parse error on line ${index + 1} in ${path}: expected true or false.`);
}

function readInlineList(value: string, index: number, path: string): string[] {
  const trimmed = value.trim();
  if (!trimmed.startsWith("[") || !trimmed.endsWith("]")) {
    throw new Error(`MCP config parse error on line ${index + 1} in ${path}: expected an inline list like [a, b] or a nested list.`);
  }
  const inner = trimmed.slice(1, -1).trim();
  if (!inner) return [];
  return inner.split(",").map((item) => unquote(item.trim())).filter(Boolean);
}

function expandEnv(value: string, env: NodeJS.ProcessEnv, index: number, path: string): string {
  return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g, (_match, key: string, fallback: string | undefined) => {
    const envValue = env[key];
    if (envValue !== undefined) return envValue;
    if (fallback !== undefined) return fallback;
    throw new Error(`MCP config parse error on line ${index + 1} in ${path}: environment variable ${key} is not set.`);
  });
}

function readKeyValue(line: string, index: number, path: string): [string, string] {
  const colon = line.indexOf(":");
  if (colon === -1) throw new Error(`MCP config parse error on line ${index + 1} in ${path}: expected key: value.`);
  const key = line.slice(0, colon).trim();
  const value = line.slice(colon + 1).trim();
  if (!key) throw new Error(`MCP config parse error on line ${index + 1} in ${path}: empty key.`);
  return [key, value];
}

function unquote(value: string): string {
  const trimmed = value.trim();
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function stripComment(line: string): string {
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if ((char === '"' || char === "'") && line[i - 1] !== "\\") {
      quote = quote === char ? null : quote ?? char;
      continue;
    }
    if (char === "#" && !quote) return line.slice(0, i);
  }
  return line;
}

function leadingSpaces(value: string): number {
  return value.length - value.trimStart().length;
}
