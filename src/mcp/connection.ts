import packageJson from "../../package.json";
import {
  Client,
  type ClientOptions,
  ProtocolError,
  SdkError,
  SdkErrorCode,
  SdkHttpError,
  StreamableHTTPClientTransport,
  type VersionNegotiationMode,
} from "@modelcontextprotocol/client";
import type {
  McpFailureKind,
  McpNegotiationMode,
  McpProtocolEra,
  McpRawTool,
  McpServerConfig,
  McpToolCallResult,
} from "./types";
import { isRecord, McpError, normalizeMcpToolResult } from "./types";

export type McpConnectionOptions = {
  fetchImpl?: typeof fetch;
};

/**
 * Side-channel holder for the raw tools/call result content. The fetch wrapper
 * captures the original content before sanitizing it for SDK validation; the
 * connection's callTool retrieves it so Vesicle's lenient normalization sees
 * the original items (including invalid/unknown types that the SDK would
 * reject).
 */
type RawResultHolder = { result?: unknown };

export type McpConnectionInfo = {
  serverId: string;
  generation: number;
  negotiation: McpNegotiationMode;
  era: McpProtocolEra | "unknown";
  protocolVersion: string;
  capabilities?: Record<string, unknown>;
  serverInfo?: Record<string, unknown>;
};

export type McpConnectionResult =
  | { ok: true; connection: McpConnection }
  | { ok: false; failureKind: McpFailureKind; error: string };

export type McpConnection = {
  readonly info: McpConnectionInfo;
  listTools(signal?: AbortSignal): Promise<McpRawTool[]>;
  callTool(name: string, args: Record<string, unknown>, options?: { signal?: AbortSignal }): Promise<McpToolCallResult>;
  close(): Promise<void>;
};

const clientIdentity = { name: "Prism Vesicle", version: packageJson.version };

/**
 * One logical request has one timeout owner. The SDK owns the timeout via
 * its per-request signal and transport timeout. Vesicle passes the caller's
 * abort signal through and does not layer additional retries.
 */
export async function createMcpConnection(
  config: McpServerConfig,
  options: McpConnectionOptions = {},
): Promise<McpConnectionResult> {
  const rawHolder: RawResultHolder = {};
  try {
    const { client, info } = await connectClient(config, options, rawHolder, 1);
    return { ok: true, connection: makeConnection(config, options, rawHolder, client, info) };
  } catch (error) {
    if (error instanceof McpConnectError) {
      return { ok: false, failureKind: error.failureKind, error: error.message };
    }
    const classified = classifyError(error);
    return { ok: false, failureKind: classified.kind, error: classified.message };
  }
}

async function connectClient(
  config: McpServerConfig,
  options: McpConnectionOptions,
  rawHolder: RawResultHolder,
  generation: number,
): Promise<{ client: Client; info: McpConnectionInfo }> {
  const negotiationMode = sdkNegotiationMode(config);
  const clientOptions: ClientOptions = {
    versionNegotiation: { mode: negotiationMode },
    inputRequired: { autoFulfill: false },
  };
  const client = new Client(clientIdentity, clientOptions);
  const transport = createTransport(config, options, rawHolder);
  try {
    await client.connect(transport);
  } catch (error) {
    await safeClose(client);
    throw toConnectError(error);
  }
  const era = client.getProtocolEra() ?? "unknown";
  const version = client.getNegotiatedProtocolVersion() ?? config.protocolVersion;
  const caps = client.getServerCapabilities();
  const serverVersion = client.getServerVersion();
  return {
    client,
    info: {
      serverId: config.id,
      generation,
      negotiation: config.negotiation,
      era,
      protocolVersion: version,
      ...(caps ? { capabilities: caps as Record<string, unknown> } : {}),
      ...(serverVersion ? { serverInfo: serverVersion as Record<string, unknown> } : {}),
    },
  };
}

function makeConnection(
  config: McpServerConfig,
  options: McpConnectionOptions,
  rawHolder: RawResultHolder,
  client: Client,
  info: McpConnectionInfo,
): McpConnection {
  let currentClient = client;
  let currentInfo = info;
  let reconnecting = false;

  const reconnect = async (): Promise<boolean> => {
    if (reconnecting) return false;
    reconnecting = true;
    try {
      await safeClose(currentClient);
      const { client: newClient, info: newInfo } = await connectClient(config, options, rawHolder, currentInfo.generation + 1);
      currentClient = newClient;
      currentInfo = newInfo;
      return true;
    } catch {
      return false;
    } finally {
      reconnecting = false;
    }
  };

  return {
    get info() {
      return currentInfo;
    },
    async listTools(signal?: AbortSignal): Promise<McpRawTool[]> {
      try {
        return await paginateTools(currentClient, signal);
      } catch (error) {
        if (signal?.aborted) throw abortReason(signal);
        if (isConnectionLevelError(error)) {
          const reconnected = await reconnect();
          if (reconnected) return paginateTools(currentClient, signal);
        }
        throw error;
      }
    },
    async callTool(name: string, args: Record<string, unknown>, callOptions?: { signal?: AbortSignal }): Promise<McpToolCallResult> {
      rawHolder.result = undefined;
      try {
        await currentClient.callTool({ name, arguments: args }, { signal: callOptions?.signal });
      } catch (error) {
        if (callOptions?.signal?.aborted) throw abortReason(callOptions.signal);
        if (isConnectionLevelError(error)) {
          await reconnect();
          throw new McpError(`MCP server ${config.id} stale session: tools/call was not replayed.`);
        }
        // SDK strict validation may reject content Vesicle accepts; fall back
        // to the raw result captured by the fetch wrapper.
      }
      if (rawHolder.result !== undefined) return normalizeMcpToolResult(rawHolder.result);
      throw new McpError(`MCP server ${config.id} returned no processable tools/call result.`);
    },
    async close(): Promise<void> {
      await safeClose(currentClient);
    },
  };
}

async function paginateTools(client: Client, signal?: AbortSignal): Promise<McpRawTool[]> {
  const tools: McpRawTool[] = [];
  let cursor: string | undefined;
  for (;;) {
    const result = await client.listTools({ ...(cursor ? { cursor } : {}), ...(signal ? { signal } : {}) });
    const currentTools = Array.isArray(result.tools) ? result.tools : [];
    tools.push(...currentTools);
    const nextCursor = typeof result.nextCursor === "string" ? result.nextCursor.trim() : "";
    if (!nextCursor) break;
    cursor = nextCursor;
  }
  return tools;
}

function createTransport(config: McpServerConfig, options: McpConnectionOptions, rawHolder: RawResultHolder): StreamableHTTPClientTransport {
  let url: URL;
  try {
    url = new URL(config.url);
  } catch {
    throw new McpConnectError("config", `MCP server "${config.id}" has an invalid URL.`);
  }
  const baseFetch = options.fetchImpl ?? fetch;
  const transportOptions: ConstructorParameters<typeof StreamableHTTPClientTransport>[1] = {
    requestInit: { headers: config.headers },
    fetch: ((input: RequestInfo | URL, init?: RequestInit) => sanitizeContentResponse(baseFetch, rawHolder, input, init)) as typeof fetch,
  };
  return new StreamableHTTPClientTransport(url, transportOptions);
}

/**
 * The fetch wrapper captures the raw tools/call result before the SDK's strict
 * Zod validation can reject content items that Vesicle's lenient normalizer
 * would accept (invalid base64, unknown types, resource_link without name).
 * The connection's callTool always normalizes from this captured raw result.
 * When the SDK rejects a response, the connection falls back to the raw result;
 * when the SDK accepts it, the raw result is still preferred to preserve items
 * the sanitizer stripped for SDK compliance.
 */
async function sanitizeContentResponse(
  baseFetch: typeof fetch,
  rawHolder: RawResultHolder,
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> {
  const response = await baseFetch(input, init);
  if (!response.ok) return response;
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("application/json")) return response;
  const text = await response.text();
  if (!text.trim()) return response;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return new Response(text, { status: response.status, headers: response.headers });
  }
  if (!isRecord(parsed) || !("result" in parsed)) return new Response(text, { status: response.status, headers: response.headers });
  const result = parsed.result;
  if (!isRecord(result)) return new Response(text, { status: response.status, headers: response.headers });
  rawHolder.result = result;
  if (!Array.isArray(result.content)) return new Response(text, { status: response.status, headers: response.headers });
  const sanitized = result.content.filter((item: unknown) => isRecord(item) && passesSdkContentValidation(item));
  if (sanitized.length === result.content.length) return new Response(text, { status: response.status, headers: response.headers });
  return new Response(JSON.stringify({ ...parsed, result: { ...result, content: sanitized } }), {
    status: response.status,
    headers: { "content-type": "application/json" },
  });
}

const knownContentTypes = new Set(["text", "image", "audio", "resource", "resource_link"]);

function passesSdkContentValidation(item: Record<string, unknown>): boolean {
  const type = item.type;
  if (typeof type !== "string" || !knownContentTypes.has(type)) return false;
  if (type === "text") return typeof item.text === "string";
  if (type === "image" || type === "audio") {
    return typeof item.data === "string" && typeof item.mimeType === "string" && item.mimeType.trim() !== "" && isValidBase64(item.data);
  }
  if (type === "resource") {
    const resource = item.resource;
    if (!isRecord(resource) || typeof resource.uri !== "string") return false;
    if (typeof resource.text === "string") return true;
    return typeof resource.blob === "string" && isValidBase64(resource.blob);
  }
  if (type === "resource_link") {
    return typeof item.name === "string" && typeof item.uri === "string";
  }
  return false;
}

function isValidBase64(value: string): boolean {
  if (!value || value.length % 4 !== 0) return false;
  try {
    atob(value);
    return true;
  } catch {
    return false;
  }
}

function sdkNegotiationMode(config: McpServerConfig): VersionNegotiationMode {
  if (config.negotiation === "legacy") return "legacy";
  if (config.negotiation === "auto") return "auto";
  const pinned = config.supportedProtocolVersions[0];
  if (!pinned) throw new McpConnectError("config", `MCP server "${config.id}" has no supported modern protocol version for pin mode.`);
  return { pin: pinned };
}

class McpConnectError extends Error {
  constructor(public readonly failureKind: McpFailureKind, message: string) {
    super(message);
    this.name = "McpConnectError";
  }
}

function toConnectError(error: unknown): Error {
  if (error instanceof McpConnectError) return error;
  const classified = classifyError(error);
  return new McpConnectError(classified.kind, classified.message);
}

type ClassifiedError = { kind: McpFailureKind; message: string };

function classifyError(error: unknown): ClassifiedError {
  if (error instanceof SdkHttpError) {
    const status = error.status;
    if (status === 401 || status === 403) return { kind: "auth", message: safeMessage(error) };
    if (status >= 500) return { kind: "transport", message: safeMessage(error) };
    return { kind: "transport", message: safeMessage(error) };
  }
  if (error instanceof SdkError) {
    if (error.code === SdkErrorCode.EraNegotiationFailed) return { kind: "modern-negotiation", message: safeMessage(error) };
    if (error.code === SdkErrorCode.RequestTimeout) return { kind: "timeout", message: safeMessage(error) };
    return { kind: "protocol", message: safeMessage(error) };
  }
  if (error instanceof ProtocolError) return { kind: "protocol", message: safeMessage(error) };
  if (error instanceof Error) return { kind: "transport", message: safeMessage(error) };
  return { kind: "transport", message: "unknown MCP error" };
}

/**
 * Heuristic for whether an error invalidates the connection and warrants a
 * read-only reconnect attempt. Stale sessions surface as transport errors
 * after the SDK's own recovery is exhausted.
 */
function isConnectionLevelError(error: unknown): boolean {
  if (error instanceof SdkHttpError) {
    const status = error.status;
    return status === 404 || status === 408 || status === 502 || status === 503 || status === 504;
  }
  if (error instanceof SdkError) {
    return error.code === SdkErrorCode.RequestTimeout || error.code === SdkErrorCode.ConnectionClosed;
  }
  return false;
}

function safeMessage(error: Error): string {
  return error.message.replace(/Bearer\s+\S+/gi, "Bearer [redacted]").slice(0, 256);
}

async function safeClose(client: Client): Promise<void> {
  try {
    await client.close();
  } catch {
    // Best-effort cleanup.
  }
}

/**
 * The SDK wraps caller abort reasons in SdkError. Re-throw the original abort
 * reason so callers see their own DOMException (name: "AbortError") rather
 * than an SDK-internal error type.
 */
function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("The operation was aborted.", "AbortError");
}
