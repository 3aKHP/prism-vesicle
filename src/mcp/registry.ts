import { dirname, join } from "node:path";
import { providerConfigPathFromEnv } from "../config/providers";
import type { EngineId } from "../core/engine/profile";
import type { ToolCall, ToolDefinition, ToolResult } from "../core/tools/types";
import { createMcpConnection, type McpConnection, type McpConnectionOptions } from "./connection";
import { loadMcpConfig, mcpConfigPathFromEnv } from "./config";
import { deliverMcpToolResult, type McpResultDeliveryContext } from "./result-delivery";
import type { McpConfig, McpRawTool, McpServerConfig, McpServerStatus, McpToolBinding, McpToolEvent } from "./types";
import {
  buildMcpToolAlias,
  isRecord,
  mcpToolFilterMatches,
  schemaFromMcpTool,
  toolDefinitionFromMcpBinding,
} from "./types";

export type McpRegistryOptions = McpConnectionOptions & {
  env?: NodeJS.ProcessEnv;
  /**
   * When set, MCP tool-call outputs are persisted under
   * `tmp/mcp-output/<sessionId>/` (#137B). The registry captures this at build
   * time so the tool-round executor does not need to know about persistence.
   */
  outputPersistence?: { sessionId: string };
};

export type McpRegistry = {
  definitions: ToolDefinition[];
  statuses: McpServerStatus[];
  hasTool: (name: string) => boolean;
  execute: (call: ToolCall, context: Pick<McpResultDeliveryContext, "rootDir" | "visionEnabled" | "signal">) => Promise<ToolResult>;
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
  if (!loaded) return createEmptyMcpRegistry();
  if (!loaded.configured || !loaded.config.enabled) return createEmptyMcpRegistry();

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
  const connections = new Map<string, McpConnection>();
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

    const result = await createMcpConnection(server, options);
    if (!result.ok) {
      statuses.push({
        id: server.id,
        transport: server.transport,
        enabled: true,
        connected: false,
        toolCount: 0,
        negotiation: server.negotiation,
        era: "unknown",
        failureKind: result.failureKind,
        error: result.error,
      });
      continue;
    }
    const connection = result.connection;
    try {
      const tools = await connection.listTools();
      const serverBindings = buildBindings(server, tools);
      const duplicate = serverBindings.find((binding) => bindings.has(binding.alias));
      if (duplicate) {
        await connection.close();
        throw new Error(`duplicate MCP tool alias "${duplicate.alias}"`);
      }
      connections.set(server.id, connection);
      for (const binding of serverBindings) bindings.set(binding.alias, binding);
      statuses.push({
        id: server.id,
        transport: server.transport,
        enabled: true,
        connected: true,
        toolCount: serverBindings.length,
        negotiation: connection.info.negotiation,
        era: connection.info.era,
        protocolVersion: connection.info.protocolVersion,
        detail: describeConnection(server, connection),
      });
    } catch (error) {
      await connection.close();
      statuses.push({
        id: server.id,
        transport: server.transport,
        enabled: true,
        connected: false,
        toolCount: 0,
        negotiation: server.negotiation,
        era: connection.info.era,
        failureKind: connection.info.era === "modern" ? "protocol" : "legacy-handshake",
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return {
    definitions: [...bindings.values()].map(toolDefinitionFromMcpBinding),
    statuses,
    hasTool: (name) => bindings.has(name),
    execute: async (call, executeContext) => {
      const binding = bindings.get(call.name);
      if (!binding) {
        return {
          callId: call.id,
          name: call.name,
          ok: false,
          content: `Unknown MCP tool: ${call.name}`,
        };
      }
      const connection = connections.get(binding.serverId);
      if (!connection) {
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
        const result = await connection.callTool(binding.toolName, args.value, { signal: executeContext.signal });
        const delivered = await deliverMcpToolResult(result, {
          ...executeContext,
          serverId: binding.serverId,
          toolName: binding.toolName,
          ...(options.outputPersistence
            ? {
                outputPersistence: {
                  sessionId: options.outputPersistence.sessionId,
                  toolCallId: call.id,
                  arguments: call.arguments,
                },
              }
            : {}),
        });
        return {
          callId: call.id,
          name: call.name,
          ok: !result.isError,
          content: delivered.content,
          ...(delivered.images ? { images: delivered.images } : {}),
          mcpEvent: eventFromBinding(binding, result.isError, {
            imageCount: delivered.imageCount,
            omittedContentCount: delivered.omittedContentCount,
            hasStructuredContent: result.structuredContent !== undefined,
          }),
        };
      } catch (error) {
        if (executeContext.signal?.aborted) throw error;
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

function describeConnection(server: McpServerConfig, connection: McpConnection): string {
  const info = connection.info.serverInfo;
  const name = isRecord(info) && typeof info.name === "string" ? info.name.trim() : "";
  const version = isRecord(info) && typeof info.version === "string" ? info.version.trim() : "";
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
    negotiation: server.negotiation,
    detail,
  };
}

function eventFromBinding(
  binding: McpToolBinding,
  isError: boolean,
  summary?: { imageCount: number; omittedContentCount: number; hasStructuredContent: boolean },
): McpToolEvent {
  return {
    kind: "mcp_tool",
    serverId: binding.serverId,
    alias: binding.alias,
    toolName: binding.toolName,
    isError,
    ...(summary?.imageCount ? { imageCount: summary.imageCount } : {}),
    ...(summary?.omittedContentCount ? { omittedContentCount: summary.omittedContentCount } : {}),
    ...(summary?.hasStructuredContent ? { hasStructuredContent: true } : {}),
  };
}

export function createEmptyMcpRegistry(): McpRegistry {
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
