import type { VesicleConfig } from "../../config/env";
import type { ProviderAdapter, ProviderStreamEvent, VesicleRequest, VesicleResponse } from "../shared/types";
import { ProviderError } from "../shared/errors";
import { fetchProvider } from "../shared/fetch";
import { geminiGenerateContentHeaders } from "../shared/headers";
import { toGeminiGenerateContentBody } from "./request";
import { responseFromGeminiBody } from "./response";
import { readGeminiGenerateContentStream } from "./stream";
import type { GeminiResponse } from "./types";

export { toGeminiGenerateContentBody } from "./request";

export class GeminiGenerateContentAdapter implements ProviderAdapter {
  readonly id = "gemini-generate-content";

  constructor(private readonly config: VesicleConfig) {}

  async complete(request: VesicleRequest): Promise<VesicleResponse> {
    this.requireApiKey();

    const response = await fetchProvider(this.url(request.model.model, "generateContent"), {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify(toGeminiGenerateContentBody(request)),
      signal: request.signal,
    }, {
      providerId: this.config.providerId,
      signal: request.signal,
    });
    const body = await response.json().catch(() => undefined) as GeminiResponse | undefined;
    if (!response.ok) {
      const providerMessage = body?.error?.message ?? response.statusText;
      throw new ProviderError(`Provider request failed (${response.status}): ${providerMessage}`, {
        kind: "http_error",
        providerId: this.config.providerId,
        status: response.status,
      });
    }

    return responseFromGeminiBody(body, request.id, this.config.providerId);
  }

  async *stream(request: VesicleRequest): AsyncIterable<ProviderStreamEvent> {
    this.requireApiKey();

    const response = await fetchProvider(`${this.url(request.model.model, "streamGenerateContent")}?alt=sse`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify(toGeminiGenerateContentBody(request)),
      signal: request.signal,
    }, {
      providerId: this.config.providerId,
      signal: request.signal,
    });
    if (!response.ok) {
      const body = await response.json().catch(() => undefined) as GeminiResponse | undefined;
      const providerMessage = body?.error?.message ?? response.statusText;
      throw new ProviderError(`Provider request failed (${response.status}): ${providerMessage}`, {
        kind: "http_error",
        providerId: this.config.providerId,
        status: response.status,
      });
    }
    if (response.headers.get("content-type")?.includes("application/json")) {
      const body = await response.json().catch(() => undefined) as GeminiResponse | undefined;
      yield { type: "complete", response: responseFromGeminiBody(body, request.id, this.config.providerId) };
      return;
    }

    yield* readGeminiGenerateContentStream(response, request.id, this.config.providerId);
  }

  private url(model: string, action: "generateContent" | "streamGenerateContent"): string {
    const modelPath = model.startsWith("models/") ? model : `models/${model}`;
    return `${this.config.baseUrl}/${modelPath}:${action}`;
  }

  private headers(): Record<string, string> {
    const apiKey = this.config.apiKey ?? "";
    const authMethod = this.config.authMethod ?? "x-goog-api-key";
    return {
      ...geminiGenerateContentHeaders(this.config.userAgent),
      ...(authMethod === "bearer" ? { "authorization": `Bearer ${apiKey}` } : {}),
      ...(authMethod === "x-api-key" ? { "x-api-key": apiKey } : {}),
      ...(authMethod === "x-goog-api-key" ? { "x-goog-api-key": apiKey } : {}),
    };
  }

  private requireApiKey(): void {
    if (this.config.apiKey) return;
    throw new ProviderError(`${this.config.apiKeyLabel ?? "provider API key"} is required before making a provider request.`, {
      kind: "missing_credentials",
      providerId: this.config.providerId,
    });
  }
}
