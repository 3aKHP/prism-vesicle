import { createHash } from "node:crypto";
import type { EngineId } from "../core/engine/profile";
import type { ToolDefinition } from "../core/tools/types";

export type { McpToolEvent } from "../core/tools/types";

export type McpTransport = "streamable-http";

export type McpProtocolEra = "legacy" | "modern";

export type McpNegotiationMode = "legacy" | "modern" | "auto";

export const validNegotiationModes: readonly McpNegotiationMode[] = ["legacy", "modern", "auto"];
export const protocolRevisionPattern = /^\d{4}-\d{2}-\d{2}$/;

export type McpFailureKind =
  | "config"
  | "probe"
  | "auth"
  | "timeout"
  | "transport"
  | "legacy-handshake"
  | "stale-session"
  | "modern-negotiation"
  | "routing"
  | "unsupported-capability"
  | "protocol";

/**
 * Modern protocol revisions Vesicle supports as a client. Currently exactly
 * the `2026-07-28` era entry point. Legacy revisions are not listed here;
 * they are owned by the legacy `initialize` path and `protocolVersion` pin.
 */
export const supportedModernProtocolVersions: readonly string[] = ["2026-07-28"];

export type McpServerConfig = {
  id: string;
  enabled: boolean;
  transport: McpTransport;
  url: string;
  headers: Record<string, string>;
  timeoutSeconds: number;
  protocolVersion: string;
  negotiation: McpNegotiationMode;
  supportedProtocolVersions: string[];
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
  negotiation?: McpNegotiationMode;
  era?: McpProtocolEra | "unknown";
  protocolVersion?: string;
  failureKind?: McpFailureKind;
  error?: string;
  detail?: string;
};

export type McpToolCallResult = {
  text: string[];
  structuredContent?: unknown;
  images: McpInlineImageCandidate[];
  deferred: McpDeferredContentCandidate[];
  diagnostics: McpResultDiagnostic[];
  isError: boolean;
};

export type McpInlineImageCandidate = {
  kind: "image";
  contentIndex: number;
  data: string;
  mimeType: string;
};

export type McpDeferredContentCandidate =
  | {
    kind: "audio";
    contentIndex: number;
    mimeType?: string;
  }
  | {
    kind: "resource";
    contentIndex: number;
    mimeType?: string;
    scheme?: string;
    hasText: boolean;
    hasBlob: boolean;
  }
  | {
    kind: "link";
    contentIndex: number;
    mimeType?: string;
    scheme?: string;
  };

export type McpResultDiagnostic = {
  contentIndex?: number;
  code: "invalid-response" | "invalid-content-item" | "invalid-image" | "unknown-content-type";
  declaredType?: string;
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

export function normalizeMcpToolResult(payload: unknown): McpToolCallResult {
  if (!isRecord(payload)) {
    return {
      text: [],
      images: [],
      deferred: [],
      diagnostics: [{ code: "invalid-response" }],
      isError: true,
    };
  }

  const text: string[] = [];
  const images: McpInlineImageCandidate[] = [];
  const deferred: McpDeferredContentCandidate[] = [];
  const diagnostics: McpResultDiagnostic[] = [];
  const content = payload.content;
  if (Array.isArray(content)) {
    for (const [contentIndex, item] of content.entries()) {
      if (!isRecord(item)) {
        diagnostics.push({ contentIndex, code: "invalid-content-item" });
        continue;
      }
      if (item.type === "text" && typeof item.text === "string") {
        const normalizedText = item.text.trim();
        if (normalizedText) text.push(normalizedText);
        continue;
      }
      if (item.type === "image") {
        if (typeof item.data === "string" && item.data.length > 0
          && typeof item.mimeType === "string" && item.mimeType.trim()) {
          images.push({
            kind: "image",
            contentIndex,
            data: item.data,
            mimeType: item.mimeType.trim(),
          });
        } else {
          diagnostics.push({ contentIndex, code: "invalid-image", declaredType: "image" });
        }
        continue;
      }
      if (item.type === "audio") {
        deferred.push({
          kind: "audio",
          contentIndex,
          ...optionalMimeType(item),
        });
        continue;
      }
      if (item.type === "resource") {
        if (!isRecord(item.resource)) {
          diagnostics.push({ contentIndex, code: "invalid-content-item", declaredType: "resource" });
          continue;
        }
        const resource = item.resource;
        deferred.push({
          kind: "resource",
          contentIndex,
          ...optionalMimeType(resource),
          ...referenceScheme(resource.uri),
          hasText: typeof resource.text === "string",
          hasBlob: typeof resource.blob === "string",
        });
        continue;
      }
      if (item.type === "resource_link" || item.type === "url" || item.type === "link") {
        deferred.push({
          kind: "link",
          contentIndex,
          ...optionalMimeType(item),
          ...referenceScheme(item.uri ?? item.url),
        });
        continue;
      }
      diagnostics.push({
        contentIndex,
        code: "unknown-content-type",
        ...declaredContentType(item.type),
      });
    }
  } else if (content !== undefined) {
    diagnostics.push({ code: "invalid-response" });
  }

  return {
    text,
    ...(payload.structuredContent !== undefined ? { structuredContent: payload.structuredContent } : {}),
    images,
    deferred,
    diagnostics,
    isError: payload.isError === true,
  };
}

function optionalMimeType(value: Record<string, unknown>): { mimeType?: string } {
  return typeof value.mimeType === "string" && value.mimeType.trim()
    ? { mimeType: value.mimeType.trim().slice(0, 128) }
    : {};
}

function referenceScheme(value: unknown): { scheme?: string } {
  if (typeof value !== "string") return {};
  const match = /^([A-Za-z][A-Za-z0-9+.-]*):/.exec(value.trim());
  return match ? { scheme: match[1]!.toLowerCase().slice(0, 32) } : {};
}

function declaredContentType(value: unknown): { declaredType?: string } {
  return typeof value === "string" && value.trim()
    ? { declaredType: value.trim().replace(/[\u0000-\u001f\u007f]/g, "").slice(0, 64) }
    : {};
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
