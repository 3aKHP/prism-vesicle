import type { VesicleConfig } from "../../config/env";
import { ProviderError, summarizeProviderFailure } from "../shared/errors";
import { fetchProvider } from "../shared/fetch";
import { openAIResponsesHeaders } from "../shared/headers";
import type { ProviderAdapter, ProviderStreamEvent, VesicleRequest, VesicleResponse } from "../shared/types";
import { toResponsesBody } from "./request";
import { readResponsesErrorMessage, responseFromResponsesBody } from "./response";
import { readResponsesStream } from "./stream";
import type { ResponsesBody } from "./types";

export class OpenAIResponsesAdapter implements ProviderAdapter {
  readonly id = "openai-responses";

  constructor(private readonly config: VesicleConfig) {}

  async complete(request: VesicleRequest): Promise<VesicleResponse> {
    this.requireApiKey();
    const response = await this.fetchResponses(request, false);
    const body = await response.json().catch(() => undefined) as ResponsesBody | undefined;
    if (!response.ok) this.throwHttp(response, body?.error?.message);
    return responseFromResponsesBody(body, this.context(request));
  }

  async *stream(request: VesicleRequest): AsyncIterable<ProviderStreamEvent> {
    this.requireApiKey();
    const maxRetries = 5;
    for (let retry = 0; ; retry++) {
      const attempt = retry + 1;
      try {
        const response = await this.fetchResponses(request, true, 0);
        if (!response.ok) {
          const message = await readResponsesErrorMessage(response);
          this.throwHttp(response, message);
        }
        if (response.headers.get("content-type")?.includes("application/json")) {
          const body = await response.json().catch(() => undefined) as ResponsesBody | undefined;
          yield { type: "complete", response: responseFromResponsesBody(body, this.context(request)) };
          return;
        }

        // Keep every transport attempt isolated. Publishing deltas only after
        // response.completed avoids duplicate provisional output when an SSE
        // body fails after accepting text or function Items.
        const committed: ProviderStreamEvent[] = [];
        for await (const event of readResponsesStream(response, { ...this.context(request), attempt })) committed.push(event);
        for (const event of committed) yield event;
        return;
      } catch (error) {
        if (request.signal?.aborted || !isRetryableResponsesFailure(error) || retry >= maxRetries) throw error;
        const delayMs = Math.min(4_000, 250 * (2 ** retry));
        request.onRetry?.({ attempt: retry + 1, maxRetries, delayMs });
        await abortableDelay(delayMs, request.signal);
      }
    }
  }

  private fetchResponses(request: VesicleRequest, stream: boolean, maxRetries = 5): Promise<Response> {
    return fetchProvider(`${this.config.baseUrl}/responses`, {
      method: "POST",
      headers: { ...openAIResponsesHeaders(this.config.userAgent), authorization: `Bearer ${this.config.apiKey}` },
      body: JSON.stringify(toResponsesBody(request, this.requestContext(), stream)),
      signal: request.signal,
    }, {
      providerId: this.config.providerId,
      signal: request.signal,
      onRetry: request.onRetry,
      policy: { maxRetries },
    });
  }

  private requestContext() {
    return { providerId: this.config.providerId, endpointFingerprint: this.config.baseUrl };
  }

  private context(request: VesicleRequest) {
    return { requestId: request.id, providerId: this.config.providerId, model: request.model.model, endpointFingerprint: this.config.baseUrl };
  }

  private throwHttp(response: Response, detail?: string): never {
    throw new ProviderError(`Provider request failed (${response.status}): ${detail ?? response.statusText}`, {
      kind: "http_error", providerId: this.config.providerId, status: response.status,
    });
  }

  private requireApiKey(): void {
    if (this.config.apiKey) return;
    throw new ProviderError(`${this.config.apiKeyLabel ?? "provider API key"} is required before making a provider request.`, {
      kind: "missing_credentials", providerId: this.config.providerId,
    });
  }
}

function isRetryableResponsesFailure(error: unknown): boolean {
  const failure = summarizeProviderFailure(error);
  return failure.retryable;
}

function abortableDelay(delayMs: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(abortError(signal));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(done, delayMs);
    signal?.addEventListener("abort", aborted, { once: true });
    function done() {
      signal?.removeEventListener("abort", aborted);
      resolve();
    }
    function aborted() {
      clearTimeout(timer);
      reject(abortError(signal));
    }
  });
}

function abortError(signal?: AbortSignal): DOMException {
  return new DOMException(typeof signal?.reason === "string" ? signal.reason : "The operation was aborted.", "AbortError");
}
