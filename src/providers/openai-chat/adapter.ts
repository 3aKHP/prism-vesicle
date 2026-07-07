import type { VesicleConfig } from "../../config/env";
import { ProviderError } from "../shared/errors";
import type { ProviderAdapter, ProviderStreamEvent, VesicleRequest, VesicleResponse } from "../shared/types";
import { toChatCompletionBody } from "./request";
import { readProviderErrorMessage, responseFromChatCompletionBody } from "./response";
import { isRetryableStreamRequestFailure, readChatCompletionStream } from "./stream";
import type { ChatCompletionResponse } from "./types";

export class OpenAIChatCompatibleAdapter implements ProviderAdapter {
  readonly id = "openai-chat-compatible";

  constructor(private readonly config: VesicleConfig) {}

  async complete(request: VesicleRequest): Promise<VesicleResponse> {
    this.requireApiKey();

    const response = await this.fetchChatCompletion(request, false, false);
    const body = await response.json().catch(() => undefined) as ChatCompletionResponse | undefined;
    if (!response.ok) {
      const providerMessage = body?.error?.message ?? response.statusText;
      throw new ProviderError(`Provider request failed (${response.status}): ${providerMessage}`, {
        kind: "http_error",
        providerId: this.config.providerId,
        status: response.status,
      });
    }

    return responseFromChatCompletionBody(body, request.id, this.config.providerId);
  }

  async *stream(request: VesicleRequest): AsyncIterable<ProviderStreamEvent> {
    this.requireApiKey();

    const response = await this.fetchChatCompletion(request, true, true);
    const retryWithoutStreamOptions = !response.ok && isRetryableStreamRequestFailure(response.status);
    const streamResponse = retryWithoutStreamOptions
      ? await this.fetchChatCompletion(request, true, false)
      : response;

    if (!streamResponse.ok && isRetryableStreamRequestFailure(streamResponse.status)) {
      yield { type: "complete", response: await this.complete(request) };
      return;
    }

    if (!streamResponse.ok) {
      const providerMessage = await readProviderErrorMessage(streamResponse);
      throw new ProviderError(`Provider request failed (${streamResponse.status}): ${providerMessage}`, {
        kind: "http_error",
        providerId: this.config.providerId,
        status: streamResponse.status,
      });
    }
    if (streamResponse.headers.get("content-type")?.includes("application/json")) {
      const body = await streamResponse.json().catch(() => undefined) as ChatCompletionResponse | undefined;
      yield { type: "complete", response: responseFromChatCompletionBody(body, request.id, this.config.providerId) };
      return;
    }

    yield* readChatCompletionStream(streamResponse, request.id, this.config.providerId);
  }

  private fetchChatCompletion(request: VesicleRequest, stream: boolean, includeUsage: boolean): Promise<Response> {
    return fetch(`${this.config.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${this.config.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(toChatCompletionBody(request, stream, includeUsage)),
    });
  }

  private requireApiKey(): void {
    if (this.config.apiKey) return;
    throw new ProviderError(`${this.config.apiKeyLabel ?? "provider API key"} is required before making a provider request.`, {
      kind: "missing_credentials",
      providerId: this.config.providerId,
    });
  }
}
