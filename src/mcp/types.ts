import { createHash } from "node:crypto";
import type { EngineId } from "../core/engine/profile";
import type { ToolDefinition } from "../core/tools/types";

export type McpTransport = "streamable-http";

export type McpServerConfig = {
  id: string;
  enabled: boolean;
  transport: McpTransport;
  url: string;
  headers: Record<string, string>;
  timeoutSeconds: number;
  protocolVersion: string;
  toolPrefix?: string;
  includeTools: string[];
  excludeTools: string[];
  enabledEngines: EngineId[];
};

export type McpConfig = {
  enabled: boolean;
  path: string;
  servers: McpServerConfig[];
};

export type McpRawTool = {
  name?: unknown;
  description?: unknown;
  inputSchema?: unknown;
  input_schema?: unknown;
};

export type McpToolBinding = {
  alias: string;
  serverId: string;
  toolName: string;
  description: string;
  inputSchema: Record<string, unknown>;
};

export type McpServerStatus = {
  id: string;
  transport: McpTransport;
  enabled: boolean;
  connected: boolean;
  toolCount: number;
  error?: string;
  detail?: string;
};

export type McpToolCallResult = {
  content: string;
  isError: boolean;
};

export type McpToolEvent = {
  kind: "mcp_tool";
  serverId: string;
  alias: string;
  toolName: string;
  isError: boolean;
};

export class McpError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "McpError";
  }
}

export function buildMcpToolAlias(serverId: string, toolName: string, prefix?: string): string {
  const basePrefix = sanitizeToolName(prefix || serverId);
  const baseTool = sanitizeToolName(toolName);
  const alias = `mcp_${basePrefix}_${baseTool}`;
  if (alias.length <= 64) return alias;

  const digest = createHash("sha1").update(`${serverId}:${toolName}`).digest("hex").slice(0, 8);
  const suffix = `_${digest}`;
  return `${alias.slice(0, 64 - suffix.length)}${suffix}`;
}

export function sanitizeToolName(value: string): string {
  const normalized = value.trim().replace(/[^A-Za-z0-9_-]+/g, "_").replace(/^_+|_+$/g, "");
  return normalized || "tool";
}

export function schemaFromMcpTool(rawTool: McpRawTool): Record<string, unknown> {
  for (const key of ["inputSchema", "input_schema"] as const) {
    const schema = rawTool[key];
    if (isRecord(schema)) return schema;
  }
  return { type: "object", properties: {} };
}

export function toolDefinitionFromMcpBinding(binding: McpToolBinding): ToolDefinition {
  return {
    type: "function",
    function: {
      name: binding.alias,
      description: `[MCP/${binding.serverId}] ${binding.description}`,
      parameters: binding.inputSchema,
    },
  };
}

export function mcpToolFilterMatches(filters: Set<string>, binding: Pick<McpToolBinding, "alias" | "toolName">): boolean {
  return filters.has(binding.toolName) || filters.has(binding.alias);
}

export function formatMcpToolResult(payload: unknown): McpToolCallResult {
  if (!isRecord(payload)) {
    return { content: "MCP tool returned an unrecognized response.", isError: true };
  }

  const parts: string[] = [];
  const content = payload.content;
  if (Array.isArray(content)) {
    for (const item of content) {
      if (!isRecord(item)) continue;
      if (item.type === "text" && typeof item.text === "string" && item.text.trim()) {
        parts.push(item.text.trim());
      }
    }
  }

  if (parts.length === 0 && payload.structuredContent !== undefined) {
    parts.push(JSON.stringify(payload.structuredContent));
  }
  if (parts.length === 0 && payload.content !== undefined) {
    parts.push(JSON.stringify(payload.content));
  }

  const text = parts.filter(Boolean).join("\n").trim();
  return {
    content: text || "MCP tool returned no displayable content.",
    isError: payload.isError === true,
  };
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
