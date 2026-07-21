import packageJson from "../../package.json";
import type { McpServerConfig, McpToolCallResult, McpRawTool } from "./types";
import { formatMcpToolResult, isRecord, McpError } from "./types";

type JsonRpcEnvelope = Record<string, unknown>;

export type McpClientOptions = {
  fetchImpl?: typeof fetch;
};

export class McpStreamableHttpClient {
  private readonly fetchImpl: typeof fetch;
  private nextId = 1;
  private sessionId: string | undefined;
  serverInfo: Record<string, unknown> = {};

  constructor(
    private readonly config: McpServerConfig,
    options: McpClientOptions = {},
  ) {
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async initialize(): Promise<void> {
    const result = await this.request("initialize", {
      protocolVersion: this.config.protocolVersion,
      capabilities: {},
      clientInfo: { name: "Prism Vesicle", version: packageJson.version },
    });
    this.serverInfo = isRecord(result.serverInfo) ? result.serverInfo : {};
    await this.notify("notifications/initialized", {});
  }

  async listTools(): Promise<McpRawTool[]> {
    const tools: McpRawTool[] = [];
    let cursor: string | undefined;
    while (true) {
      const result = await this.request("tools/list", cursor ? { cursor } : {});
      const currentTools = Array.isArray(result.tools) ? result.tools : [];
      tools.push(...currentTools.filter(isRecord));
      const nextCursor = typeof result.nextCursor === "string" ? result.nextCursor.trim() : "";
      if (!nextCursor) break;
      cursor = nextCursor;
    }
    return tools;
  }

  async callTool(toolName: string, args: Record<string, unknown>): Promise<McpToolCallResult> {
    const result = await this.request("tools/call", {
      name: toolName,
      arguments: args,
    });
    return formatMcpToolResult(result);
  }

  private async request(method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
    const id = this.nextId++;
    const envelopes = await this.post({
      jsonrpc: "2.0",
      id,
      method,
      params,
    });
    const envelope = findResponseEnvelope(envelopes, id);
    if (!envelope) {
      throw new McpError(`MCP server ${this.config.id} returned no JSON-RPC response for ${method}.`);
    }
    if ("error" in envelope) {
      const error = envelope.error;
      const message = isRecord(error) && typeof error.message === "string" ? error.message : "unknown MCP error";
      throw new McpError(`MCP server ${this.config.id} ${method} failed: ${message}`);
    }
    return isRecord(envelope.result) ? envelope.result : {};
  }

  private async notify(method: string, params: Record<string, unknown>): Promise<void> {
    await this.post({
      jsonrpc: "2.0",
      method,
      params,
    });
  }

  private async post(payload: JsonRpcEnvelope): Promise<JsonRpcEnvelope[]> {
    const timeout = setTimeoutController(this.config.timeoutSeconds);
    try {
      const response = await this.fetchImpl(this.config.url, {
        method: "POST",
        headers: {
          ...this.config.headers,
          "Accept": "application/json, text/event-stream",
          "Content-Type": "application/json",
          ...(this.sessionId ? { "MCP-Session-Id": this.sessionId } : {}),
        },
        body: JSON.stringify(payload),
        signal: timeout.signal,
      });
      if (!response.ok) {
        throw new McpError(`MCP server ${this.config.id} HTTP ${response.status}.`);
      }
      const returnedSession = response.headers.get("MCP-Session-Id") ?? response.headers.get("mcp-session-id");
      if (returnedSession) this.sessionId = returnedSession;
      if (response.status === 204) return [];
      const text = await response.text();
      if (!text.trim()) return [];
      const contentType = response.headers.get("content-type") ?? "";
      if (contentType.includes("text/event-stream")) {
        return parseSseEnvelopes(text);
      }
      const parsed = JSON.parse(text) as unknown;
      if (Array.isArray(parsed)) return parsed.filter(isRecord);
      if (isRecord(parsed)) return [parsed];
      throw new McpError(`MCP server ${this.config.id} returned a non-object JSON response.`);
    } catch (error) {
      if (error instanceof McpError) throw error;
      if (error instanceof DOMException && error.name === "AbortError") {
        throw new McpError(`MCP server ${this.config.id} timed out after ${this.config.timeoutSeconds}s.`);
      }
      const detail = error instanceof Error ? error.message : String(error);
      throw new McpError(`MCP server ${this.config.id} request failed: ${detail}`);
    } finally {
      timeout.clear();
    }
  }
}

function findResponseEnvelope(envelopes: JsonRpcEnvelope[], id: number): JsonRpcEnvelope | undefined {
  return envelopes.find((envelope) => Number(envelope.id) === id && ("result" in envelope || "error" in envelope));
}

export function parseSseEnvelopes(source: string): JsonRpcEnvelope[] {
  const envelopes: JsonRpcEnvelope[] = [];
  for (const block of source.split(/\r?\n\r?\n/)) {
    const dataLines: string[] = [];
    for (const rawLine of block.split(/\r?\n/)) {
      const line = rawLine.trimEnd();
      if (!line || line.startsWith(":")) continue;
      if (line.startsWith("data:")) dataLines.push(line.slice("data:".length).trimStart());
    }
    const data = dataLines.join("\n").trim();
    if (!data || data === "[DONE]") continue;
    const parsed = JSON.parse(data) as unknown;
    if (isRecord(parsed)) envelopes.push(parsed);
  }
  return envelopes;
}

function setTimeoutController(timeoutSeconds: number): { signal: AbortSignal; clear: () => void } {
  const controller = new AbortController();
  const handle = setTimeout(() => controller.abort(), Math.max(1, timeoutSeconds) * 1000);
  return {
    signal: controller.signal,
    clear: () => clearTimeout(handle),
  };
}
