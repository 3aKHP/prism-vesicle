import { openAIChatHeaders } from "../providers/shared/headers";

const DEFAULT_TIMEOUT_MS = 12_000;
const DEFAULT_MAX_BYTES = 1_000_000;

export type ModelDiscoveryOptions = {
  fetchImpl?: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
  timeoutMs?: number;
  maxBytes?: number;
};

export type ModelDiscoveryResult = {
  baseUrl: string;
  endpoint: string;
  models: string[];
};

export class ModelDiscoveryError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
    this.name = "ModelDiscoveryError";
  }
}

export function normalizeOpenAIBaseUrl(input: string): string {
  const trimmed = input.trim().replace(/\/+$/, "");
  if (!trimmed) throw new ModelDiscoveryError("Enter a Base URL.");

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new ModelDiscoveryError("Base URL must be a complete http:// or https:// URL.");
  }
  if (url.username || url.password) {
    throw new ModelDiscoveryError("Base URL must not contain a username or password.");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new ModelDiscoveryError("Base URL must use http:// or https://.");
  }
  if (url.protocol === "http:" && !isLoopbackHost(url.hostname)) {
    throw new ModelDiscoveryError("Use HTTPS for remote providers. HTTP is allowed only for a local provider.");
  }

  url.hash = "";
  url.search = "";
  url.pathname = url.pathname.replace(/\/+$/, "");
  if (!url.pathname.toLowerCase().endsWith("/v1")) {
    url.pathname = `${url.pathname}/v1`.replace(/\/{2,}/g, "/");
  }
  return url.toString().replace(/\/$/, "");
}

export async function discoverOpenAIModels(
  input: string,
  apiKey: string,
  options: ModelDiscoveryOptions = {},
): Promise<ModelDiscoveryResult> {
  if (!apiKey.trim()) throw new ModelDiscoveryError("Enter an API key before discovering models.");
  const baseUrl = normalizeOpenAIBaseUrl(input);
  const endpoint = `${baseUrl}/models`;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(1, timeoutMs));

  try {
    const fetchImpl = options.fetchImpl ?? ((target: string | URL | Request, init?: RequestInit) => fetch(target, init));
    const response = await fetchImpl(endpoint, {
      method: "GET",
      redirect: "error",
      headers: {
        ...openAIChatHeaders(),
        "authorization": `Bearer ${apiKey}`,
      },
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new ModelDiscoveryError(discoveryHttpMessage(response.status), response.status);
    }
    const declaredSize = Number(response.headers.get("content-length"));
    const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
    if (Number.isFinite(declaredSize) && declaredSize > maxBytes) {
      throw new ModelDiscoveryError("The provider model list is too large to read safely.");
    }
    const source = await readBoundedText(response, maxBytes);
    let body: unknown;
    try {
      body = JSON.parse(source);
    } catch {
      throw new ModelDiscoveryError("The provider returned an invalid JSON model list.");
    }
    const models = modelIdsFromResponse(body);
    if (models.length === 0) {
      throw new ModelDiscoveryError("The provider returned no model ids. You can add a model manually.");
    }
    return { baseUrl, endpoint, models };
  } catch (error) {
    if (error instanceof ModelDiscoveryError) throw error;
    if (controller.signal.aborted) {
      throw new ModelDiscoveryError(`Model discovery timed out after ${Math.ceil(timeoutMs / 1000)} seconds.`);
    }
    throw new ModelDiscoveryError(`Could not reach the provider: ${safeErrorMessage(error)}`);
  } finally {
    clearTimeout(timer);
  }
}

async function readBoundedText(response: Response, maxBytes: number): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      bytes += next.value.byteLength;
      if (bytes > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new ModelDiscoveryError("The provider model list is too large to read safely.");
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  const combined = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(combined);
}

export function modelIdsFromResponse(body: unknown): string[] {
  if (!isRecord(body) || !Array.isArray(body.data)) return [];
  const ids = body.data.flatMap((entry) => {
    if (!isRecord(entry) || typeof entry.id !== "string") return [];
    const id = entry.id.trim();
    return id ? [id] : [];
  });
  return [...new Set(ids)].sort((left, right) => left.localeCompare(right));
}

function discoveryHttpMessage(status: number): string {
  if (status === 401 || status === 403) return `The provider rejected the API key (HTTP ${status}).`;
  if (status === 404) return "The provider does not expose /v1/models at this Base URL (HTTP 404).";
  if (status === 429) return "The provider rate-limited model discovery (HTTP 429). Try again shortly.";
  return `The provider model request failed with HTTP ${status}.`;
}

function isLoopbackHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  return host === "localhost" || host === "127.0.0.1" || host === "::1";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function safeErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim()) return error.message;
  return "network error";
}
