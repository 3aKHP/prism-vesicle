import type { VesicleConfig } from "../../config/env";
import { abortError, ProviderError, summarizeProviderFailure } from "../shared/errors";
import { fetchProvider } from "../shared/fetch";
import { defaultUserAgent, openAIResponsesHeaders } from "../shared/headers";
import type { ProviderAdapter, ProviderStreamEvent, VesicleRequest, VesicleResponse } from "../shared/types";
import { findResponsesContinuation, toResponsesBody, toResponsesWebSocketMessage } from "./request";
import { readResponsesErrorMessage, responseFromResponsesBody } from "./response";
import { readResponsesStream } from "./stream";
import type { ResponsesBody } from "./types";
import { responsesEndpointFingerprint } from "./owner";
import { responsesWebSocketSession, type ResponsesSocketFactory } from "./websocket";

export class OpenAIResponsesAdapter implements ProviderAdapter {
  readonly id = "openai-responses";

  constructor(
    private readonly config: VesicleConfig,
    private readonly runtime: {
      sessionId?: string;
      webSocketFactory?: ResponsesSocketFactory;
      webSocketRequestTimeoutMs?: number;
      retryDelay?: (delayMs: number, signal?: AbortSignal) => Promise<void>;
    } = {},
  ) {}

  async complete(request: VesicleRequest): Promise<VesicleResponse> {
    this.requireApiKey();
    this.requireProfile();
    const response = await this.fetchResponses(request, false);
    const body = await response.json().catch(() => undefined) as ResponsesBody | undefined;
    if (!response.ok) this.throwHttp(response, body?.error?.message);
    return responseFromResponsesBody(body, this.context(request));
  }

  async *stream(request: VesicleRequest): AsyncIterable<ProviderStreamEvent> {
    this.requireApiKey();
    this.requireProfile();
    if (this.config.responsesTransport === "websocket" && this.runtime.sessionId) {
      yield* this.streamWebSocket(request);
      return;
    }
    yield* this.streamHttp(request);
  }

  private async *streamHttp(
    request: VesicleRequest,
    attemptOffset = 0,
    maxRetries = 5,
  ): AsyncIterable<ProviderStreamEvent> {
    for (let retry = 0; ; retry++) {
      const attempt = attemptOffset + retry + 1;
      try {
        const response = await this.fetchResponses(request, true, 0);
        if (!response.ok) {
          const message = await readResponsesErrorMessage(response);
          this.throwHttp(response, message);
        }
        if (response.headers.get("content-type")?.includes("application/json")) {
          const body = await response.json().catch(() => undefined) as ResponsesBody | undefined;
          const completed = responseFromResponsesBody(body, this.context(request));
          yield { type: "attempt_started", attempt };
          yield { type: "complete", attempt, response: completed };
          return;
        }

        // Keep every transport attempt isolated. Publishing deltas only after
        // response.completed avoids duplicate provisional output when an SSE
        // body fails after accepting text or function Items.
        const committed: ProviderStreamEvent[] = [];
        for await (const event of readResponsesStream(response, {
          ...this.context(request), attempt, profile: this.config.responsesProfile,
        })) committed.push(event);
        for (const event of committed) yield event;
        return;
      } catch (error) {
        if (request.signal?.aborted || !isRetryableResponsesFailure(error) || retry >= maxRetries) throw error;
        yield { type: "attempt_started", attempt };
        yield { type: "attempt_discarded", attempt };
        const delayMs = Math.min(4_000, 250 * (2 ** retry));
        request.onRetry?.({ attempt: retry + 1, maxRetries, delayMs });
        await (this.runtime.retryDelay ?? abortableDelay)(delayMs, request.signal);
      }
    }
  }

  private async *streamWebSocket(request: VesicleRequest): AsyncIterable<ProviderStreamEvent> {
    const stableRequest: VesicleRequest = { ...request, messages: [...request.messages] };
    const maxRetries = 5;
    const endpointFingerprint = responsesEndpointFingerprint(this.config.baseUrl);
    const owner = `${this.config.providerId}\u0000${stableRequest.model.model}\u0000${endpointFingerprint}\u0000${this.webSocketProfile()}`;
    const session = responsesWebSocketSession({
      sessionId: this.runtime.sessionId!,
      owner,
      baseUrl: this.config.baseUrl,
      providerId: this.config.providerId,
      headers: this.webSocketHeaders(),
      factory: this.runtime.webSocketFactory,
      requestTimeoutMs: this.runtime.webSocketRequestTimeoutMs,
    });
    if (session.unavailable) {
      yield* this.streamHttp(stableRequest);
      return;
    }
    for (let retry = 0; ; retry++) {
      const attempt = retry + 1;
      try {
        session.prepareForRequest();
        let continuation = findResponsesContinuation(stableRequest, this.requestContext(), session.lastResponseId);
        if (session.lastResponseId && !continuation) session.clearContinuation();
        if (!continuation && session.needsPrewarm()) {
          const prewarm = toResponsesWebSocketMessage(
            stableRequest, this.requestContext(), undefined, false, this.webSocketProfile(),
          );
          const prewarmResponse = await session.request(prewarm, stableRequest.signal);
          const prewarmEvents: ProviderStreamEvent[] = [];
          for await (const event of readResponsesStream(prewarmResponse, {
            ...this.context(stableRequest), attempt, profile: this.config.responsesProfile, allowEmptyOutput: true,
          })) prewarmEvents.push(event);
          const completed = prewarmEvents.find((event) => event.type === "complete");
          if (!completed || completed.type !== "complete" || !completed.response.id) {
            throw new ProviderError("Responses WebSocket prewarm did not return a response ID.", {
              kind: "malformed_response", providerId: this.config.providerId,
            });
          }
          const prewarmBody = completed.response.raw as ResponsesBody | undefined;
          if (!prewarmBody || prewarmBody.output?.length !== 0) {
            throw new ProviderError("Responses WebSocket prewarm returned unexpected output Items.", {
              kind: "malformed_response", providerId: this.config.providerId,
            });
          }
          session.markCompleted(completed.response.id);
          continuation = {
            responseId: completed.response.id,
            afterMessageIndex: stableRequest.messages.length,
            pendingCallIds: [],
          };
        }
        const message = toResponsesWebSocketMessage(
          stableRequest, this.requestContext(), continuation, true, this.webSocketProfile(),
        );
        const response = await session.request(message, stableRequest.signal);
        const committed: ProviderStreamEvent[] = [];
        for await (const event of readResponsesStream(response, {
          ...this.context(stableRequest), attempt, profile: this.config.responsesProfile,
        })) committed.push(event);
        const completed = committed.find((event) => event.type === "complete");
        if (completed?.type === "complete") session.markCompleted(completed.response.id);
        for (const event of committed) yield event;
        return;
      } catch (error) {
        if (stableRequest.signal?.aborted) {
          session.resetConnection("request canceled");
          throw abortError(stableRequest.signal);
        }
        const missingContinuation = error instanceof ProviderError && error.code === "previous_response_not_found";
        // Any uncommitted WebSocket terminal invalidates connection-local
        // continuation, including a non-retryable malformed/failed response.
        session.resetConnection("request recovery");
        if (!missingContinuation && !isRetryableResponsesFailure(error)) throw error;
        yield { type: "attempt_started", attempt };
        yield { type: "attempt_discarded", attempt };
        if (retry >= maxRetries) {
          session.disable();
          // The downgrade is the final attempt in this logical request. It does
          // not receive a second HTTP retry budget after six WS attempts.
          yield* this.streamHttp(stableRequest, maxRetries + 1, 0);
          return;
        }
        const delayMs = Math.min(4_000, 250 * (2 ** retry));
        stableRequest.onRetry?.({ attempt: retry + 1, maxRetries, delayMs });
        await (this.runtime.retryDelay ?? abortableDelay)(delayMs, stableRequest.signal);
      }
    }
  }

  private fetchResponses(request: VesicleRequest, stream: boolean, maxRetries = 5): Promise<Response> {
    return fetchProvider(`${this.config.baseUrl}/responses`, {
      method: "POST",
      headers: { ...openAIResponsesHeaders(stream, this.config.userAgent), authorization: `Bearer ${this.config.apiKey}` },
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
    return { providerId: this.config.providerId, endpointFingerprint: responsesEndpointFingerprint(this.config.baseUrl) };
  }

  private context(request: VesicleRequest) {
    return { requestId: request.id, providerId: this.config.providerId, model: request.model.model, endpointFingerprint: responsesEndpointFingerprint(this.config.baseUrl) };
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

  private requireProfile(): void {
    if (this.config.responsesProfile === "codex-http-relay" && this.config.responsesTransport === "websocket") {
      throw new ProviderError("codex-http-relay supports HTTP only; select openai-public or codex-beta-2026-02-06 for WebSocket.", {
        kind: "malformed_response", providerId: this.config.providerId,
      });
    }
    if (this.config.responsesProfile === "codex-beta-2026-02-06" && this.config.responsesTransport !== "websocket") {
      throw new ProviderError("codex-beta-2026-02-06 requires responsesTransport websocket.", {
        kind: "malformed_response", providerId: this.config.providerId,
      });
    }
    if (this.config.responsesProfile === "openai-public"
      || this.config.responsesProfile === "codex-http-relay"
      || this.config.responsesProfile === "codex-beta-2026-02-06") return;
    throw new ProviderError("OpenAI Responses requires an explicit supported responsesProfile.", {
      kind: "malformed_response", providerId: this.config.providerId,
    });
  }

  private webSocketProfile(): "openai-public" | "codex-beta-2026-02-06" {
    return this.config.responsesProfile === "codex-beta-2026-02-06"
      ? "codex-beta-2026-02-06"
      : "openai-public";
  }

  private webSocketHeaders(): Record<string, string> {
    return {
      authorization: `Bearer ${this.config.apiKey}`,
      "user-agent": this.config.userAgent ?? defaultUserAgent(),
      ...(this.webSocketProfile() === "codex-beta-2026-02-06"
        ? { "openai-beta": "responses_websockets=2026-02-06" }
        : {}),
    };
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
