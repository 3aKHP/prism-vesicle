import { dirname, join } from "node:path";
import { providerConfigPathFromEnv } from "../config/providers";
import type { EngineId } from "../core/engine/profile";
import type { ToolCall, ToolDefinition, ToolResult } from "../core/tools/types";
import { McpStreamableHttpClient, type McpClientOptions } from "./client";
import { loadMcpConfig, mcpConfigPathFromEnv } from "./config";
import type { McpConfig, McpRawTool, McpServerConfig, McpServerStatus, McpToolBinding, McpToolEvent } from "./types";
import {
  buildMcpToolAlias,
  isRecord,
  mcpToolFilterMatches,
  schemaFromMcpTool,
  toolDefinitionFromMcpBinding,
} from "./types";

export type McpRegistryOptions = McpClientOptions & {
  env?: NodeJS.ProcessEnv;
};

export type McpRegistry = {
  definitions: ToolDefinition[];
  statuses: McpServerStatus[];
  hasTool: (name: string) => boolean;
  execute: (call: ToolCall) => Promise<ToolResult>;
};

export type McpInspection = {
  configured: boolean;
  path: string;
  envPath: string;
  hasEnvFile: boolean;
  enabled: boolean;
  statuses: McpServerStatus[];
};

export async function createMcpRegistryForEngine(
  engine: EngineId,
  options: McpRegistryOptions = {},
): Promise<McpRegistry> {
  const loaded = await loadMcpConfig(options.env).catch(() => null);
  if (!loaded) return emptyRegistry();
  if (!loaded.configured || !loaded.config.enabled) return emptyRegistry();

  const registry = await buildRegistry(loaded.config, options, engine);
  return registry;
}

export async function inspectMcpConfig(options: McpRegistryOptions = {}): Promise<McpInspection> {
  const loaded = await loadMcpConfig(options.env).catch((error: unknown) => configLoadErrorInspection(options.env, error));
  if ("statuses" in loaded) return loaded;
  if (!loaded.configured) {
    return {
      configured: false,
      path: loaded.path,
      envPath: loaded.envPath,
      hasEnvFile: loaded.hasEnvFile,
      enabled: false,
      statuses: [],
    };
  }
  if (!loaded.config.enabled) {
    return {
      configured: true,
      path: loaded.config.path,
      envPath: loaded.envPath,
      hasEnvFile: loaded.hasEnvFile,
      enabled: false,
      statuses: loaded.config.servers.map((server) => ({
        id: server.id,
        transport: server.transport,
        enabled: server.enabled,
        connected: false,
        toolCount: 0,
        detail: server.enabled ? "global MCP disabled" : "server disabled",
      })),
    };
  }
  const registry = await buildRegistry(loaded.config, options);
  return {
    configured: true,
    path: loaded.config.path,
    envPath: loaded.envPath,
    hasEnvFile: loaded.hasEnvFile,
    enabled: true,
    statuses: registry.statuses,
  };
}

function configLoadErrorInspection(env: NodeJS.ProcessEnv = process.env, error: unknown): McpInspection {
  const detail = error instanceof Error ? error.message : String(error);
  return {
    configured: true,
    path: mcpConfigPathFromEnv(env),
    envPath: join(dirname(providerConfigPathFromEnv(env)), ".env"),
    hasEnvFile: false,
    enabled: false,
    statuses: [{
      id: "config",
      transport: "streamable-http",
      enabled: true,
      connected: false,
      toolCount: 0,
      error: detail,
    }],
  };
}

async function buildRegistry(
  config: McpConfig,
  options: McpRegistryOptions,
  engine?: EngineId,
): Promise<McpRegistry> {
  const clients = new Map<string, McpStreamableHttpClient>();
  const bindings = new Map<string, McpToolBinding>();
  const statuses: McpServerStatus[] = [];

  for (const server of config.servers) {
    if (!server.enabled) {
      statuses.push(disconnectedStatus(server, "server disabled"));
      continue;
    }
    if (engine && server.enabledEngines.length > 0 && !server.enabledEngines.includes(engine)) {
      statuses.push(disconnectedStatus(server, `not enabled for ${engine}`));
      continue;
    }

    const client = new McpStreamableHttpClient(server, options);
    try {
      await client.initialize();
      const tools = await client.listTools();
      const serverBindings = buildBindings(server, tools);
      const duplicate = serverBindings.find((binding) => bindings.has(binding.alias));
      if (duplicate) {
        throw new Error(`duplicate MCP tool alias "${duplicate.alias}"`);
      }
      clients.set(server.id, client);
      for (const binding of serverBindings) bindings.set(binding.alias, binding);
      statuses.push({
        id: server.id,
        transport: server.transport,
        enabled: true,
        connected: true,
        toolCount: serverBindings.length,
        detail: describeServer(server, client),
      });
    } catch (error) {
      statuses.push({
        id: server.id,
        transport: server.transport,
        enabled: true,
        connected: false,
        toolCount: 0,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return {
    definitions: [...bindings.values()].map(toolDefinitionFromMcpBinding),
    statuses,
    hasTool: (name) => bindings.has(name),
    execute: async (call) => {
      const binding = bindings.get(call.name);
      if (!binding) {
        return {
          callId: call.id,
          name: call.name,
          ok: false,
          content: `Unknown MCP tool: ${call.name}`,
        };
      }
      const client = clients.get(binding.serverId);
      if (!client) {
        return {
          callId: call.id,
          name: call.name,
          ok: false,
          content: `MCP server is not connected: ${binding.serverId}`,
          mcpEvent: eventFromBinding(binding, true),
        };
      }
      const args = parseToolArguments(call.arguments);
      if (!args.ok) {
        return {
          callId: call.id,
          name: call.name,
          ok: false,
          content: args.error,
          mcpEvent: eventFromBinding(binding, true),
        };
      }
      try {
        const result = await client.callTool(binding.toolName, args.value);
        return {
          callId: call.id,
          name: call.name,
          ok: !result.isError,
          content: result.content,
          mcpEvent: eventFromBinding(binding, result.isError),
        };
      } catch (error) {
        return {
          callId: call.id,
          name: call.name,
          ok: false,
          content: error instanceof Error ? error.message : String(error),
          mcpEvent: eventFromBinding(binding, true),
        };
      }
    },
  };
}

function buildBindings(server: McpServerConfig, tools: McpRawTool[]): McpToolBinding[] {
  const include = normalizeToolFilter(server.includeTools);
  const exclude = normalizeToolFilter(server.excludeTools);
  const bindings: McpToolBinding[] = [];
  for (const rawTool of tools) {
    const toolName = typeof rawTool.name === "string" ? rawTool.name.trim() : "";
    if (!toolName) continue;
    const binding: McpToolBinding = {
      alias: buildMcpToolAlias(server.id, toolName, server.toolPrefix),
      serverId: server.id,
      toolName,
      description: typeof rawTool.description === "string" && rawTool.description.trim()
        ? rawTool.description.trim()
        : `MCP tool ${toolName} from ${server.id}`,
      inputSchema: schemaFromMcpTool(rawTool),
    };
    if (include.size > 0 && !mcpToolFilterMatches(include, binding)) continue;
    if (exclude.size > 0 && mcpToolFilterMatches(exclude, binding)) continue;
    bindings.push(binding);
  }
  return bindings;
}

function normalizeToolFilter(values: string[]): Set<string> {
  return new Set(values.map((value) => value.trim()).filter(Boolean));
}

function parseToolArguments(source: string): { ok: true; value: Record<string, unknown> } | { ok: false; error: string } {
  try {
    const parsed = source.trim() ? JSON.parse(source) as unknown : {};
    if (!isRecord(parsed)) return { ok: false, error: "MCP tool arguments must be a JSON object." };
    return { ok: true, value: parsed };
  } catch (error) {
    return { ok: false, error: `Invalid MCP tool arguments: ${error instanceof Error ? error.message : String(error)}` };
  }
}

function describeServer(server: McpServerConfig, client: McpStreamableHttpClient): string {
  const name = typeof client.serverInfo.name === "string" ? client.serverInfo.name.trim() : "";
  const version = typeof client.serverInfo.version === "string" ? client.serverInfo.version.trim() : "";
  if (name && version) return `${name} ${version}`;
  if (name) return name;
  return server.url;
}

function disconnectedStatus(server: McpServerConfig, detail: string): McpServerStatus {
  return {
    id: server.id,
    transport: server.transport,
    enabled: false,
    connected: false,
    toolCount: 0,
    detail,
  };
}

function eventFromBinding(binding: McpToolBinding, isError: boolean): McpToolEvent {
  return {
    kind: "mcp_tool",
    serverId: binding.serverId,
    alias: binding.alias,
    toolName: binding.toolName,
    isError,
  };
}

function emptyRegistry(): McpRegistry {
  return {
    definitions: [],
    statuses: [],
    hasTool: () => false,
    execute: async (call) => ({
      callId: call.id,
      name: call.name,
      ok: false,
      content: `Unknown MCP tool: ${call.name}`,
    }),
  };
}
