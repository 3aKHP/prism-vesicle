import type { VesicleConfig } from "../../config/env";
import { ProviderError } from "../shared/errors";
import { fetchProvider } from "../shared/fetch";
import { anthropicMessagesHeaders } from "../shared/headers";
import type { ProviderAdapter, ProviderStreamEvent, VesicleRequest, VesicleResponse } from "../shared/types";
import { toAnthropicMessagesBody } from "./request";
import { responseFromAnthropicBody } from "./response";
import { readAnthropicMessagesStream } from "./stream";
import type { AnthropicResponse } from "./types";

export { toAnthropicMessagesBody } from "./request";

export class AnthropicMessagesAdapter implements ProviderAdapter {
  readonly id = "anthropic-messages";

  constructor(private readonly config: VesicleConfig) {}

  async complete(request: VesicleRequest): Promise<VesicleResponse> {
    this.requireApiKey();

    const response = await this.fetchMessages(request, false);
    const body = await response.json().catch(() => undefined) as AnthropicResponse | undefined;
    if (!response.ok) this.throwHttpError(response, body);

    return responseFromAnthropicBody(body, request.id, this.config.providerId);
  }

  async *stream(request: VesicleRequest): AsyncIterable<ProviderStreamEvent> {
    this.requireApiKey();

    const response = await this.fetchMessages(request, true);
    if (!response.ok) {
      const body = await response.json().catch(() => undefined) as AnthropicResponse | undefined;
      this.throwHttpError(response, body);
    }

    yield* readAnthropicMessagesStream(response, request.id, request.model.model, this.config.providerId);
  }

  private fetchMessages(request: VesicleRequest, stream: boolean): Promise<Response> {
    return fetchProvider(`${this.config.baseUrl}/messages?beta=true`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({ ...toAnthropicMessagesBody(request), ...(stream ? { stream: true } : {}) }),
      signal: request.signal,
    }, {
      providerId: this.config.providerId,
      signal: request.signal,
      attemptHeaders: (retryCount) => ({ "x-stainless-retry-count": String(retryCount) }),
    });
  }

  private headers(): Record<string, string> {
    const apiKey = this.config.apiKey ?? "";
    const authMethod = this.config.authMethod ?? "x-api-key";
    return {
      ...anthropicMessagesHeaders(this.config.userAgent),
      ...(authMethod === "bearer" ? { "authorization": `Bearer ${apiKey}` } : { "x-api-key": apiKey }),
    };
  }

  private requireApiKey(): void {
    if (this.config.apiKey) return;
    throw new ProviderError(`${this.config.apiKeyLabel ?? "provider API key"} is required before making a provider request.`, {
      kind: "missing_credentials",
      providerId: this.config.providerId,
    });
  }

  private throwHttpError(response: Response, body: AnthropicResponse | undefined): never {
    const providerMessage = body?.error?.message ?? response.statusText;
    throw new ProviderError(`Provider request failed (${response.status}): ${providerMessage}`, {
      kind: "http_error",
      providerId: this.config.providerId,
      status: response.status,
    });
  }
}
