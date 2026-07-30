import type { VesicleConfig } from "../../config/env";
import { abortError, ProviderError, summarizeProviderFailure } from "../shared/errors";
import { fetchProvider } from "../shared/fetch";
import { defaultUserAgent, openAIResponsesHeaders } from "../shared/headers";
import { PROVIDER_NATIVE_CHECKPOINT_KIND, type ProviderAdapter, type ProviderCompactRequest, type ProviderCompactResult, type ProviderStreamEvent, type VesicleRequest, type VesicleResponse } from "../shared/types";
import { findResponsesContinuation, toResponsesBody, toResponsesCompactBody, toResponsesWebSocketMessage, usesResponsesNativeCheckpoint } from "./request";
import { readResponsesErrorMessage, responseFromResponsesBody } from "./response";
import { readResponsesStream } from "./stream";
import type { ResponsesBody, ResponsesCompactBody } from "./types";
import { responsesEndpointFingerprint } from "./owner";
import { invalidateResponsesWebSocketContinuation, responsesWebSocketSession, type ResponsesSocketFactory } from "./websocket";
import { parseProviderStateEnvelope, providerStateEnvelopeVersion } from "../shared/state";
import { validateResponsesCompactItems } from "./items";
import { usageFromResponses } from "./usage";

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
    try {
      return await this.completeOnce(request);
    } catch (error) {
      if (!usesResponsesNativeCheckpoint(request, this.requestContext()) || isRetryableResponsesFailure(error)) throw error;
      return this.completeOnce(portableCheckpointRequest(request));
    }
  }

  async compact(request: ProviderCompactRequest): Promise<ProviderCompactResult> {
    this.requireApiKey();
    this.requireProfile();
    if (this.config.responsesProfile === "mimo-subset-2026-07-30") {
      throw new ProviderError("mimo-subset-2026-07-30 does not support remote Responses compaction.", {
        kind: "malformed_response", providerId: this.config.providerId,
      });
    }
    if (this.config.capabilities?.remoteCompact !== true) {
      throw new ProviderError("Remote Responses compaction is not enabled for this model profile.", {
        kind: "malformed_response", providerId: this.config.providerId,
      });
    }
    const response = await fetchProvider(`${this.config.baseUrl}/responses/compact`, {
      method: "POST",
      headers: { ...openAIResponsesHeaders(false, this.config.userAgent), ...this.authHeaders() },
      body: JSON.stringify(toResponsesCompactBody(request, this.requestContext())),
      signal: request.signal,
    }, {
      providerId: this.config.providerId,
      signal: request.signal,
      onRetry: request.onRetry,
      policy: { maxRetries: 5 },
    });
    const body = await response.json().catch(() => undefined) as ResponsesCompactBody | undefined;
    if (!response.ok) this.throwHttp(response, body?.error?.message);
    if (!body || body.object !== "response.compaction" || !Array.isArray(body.output)) {
      throw new ProviderError("Provider compaction did not return a canonical output window.", {
        kind: "malformed_response", providerId: this.config.providerId,
      });
    }
    const compactedInput = validateResponsesCompactItems(body.output, this.config.providerId);
    const providerState = parseProviderStateEnvelope({
      version: providerStateEnvelopeVersion,
      protocol: "openai-responses",
      providerId: this.config.providerId,
      model: request.model.model,
      endpointFingerprint: responsesEndpointFingerprint(this.config.baseUrl),
      payload: { version: 1, profile: this.config.responsesProfile, compactedInput },
    });
    const usage = usageFromResponses(body.usage);
    return { providerState, ...(usage ? { usage } : {}) };
  }

  commitCompact(): void {
    if (this.runtime.sessionId) invalidateResponsesWebSocketContinuation(this.runtime.sessionId);
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
    allowNativeFallback = true,
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
        if (allowNativeFallback && usesResponsesNativeCheckpoint(request, this.requestContext()) && !isRetryableResponsesFailure(error)) {
          yield { type: "attempt_started", attempt };
          yield { type: "attempt_discarded", attempt };
          yield* this.streamHttp(
            portableCheckpointRequest(request),
            attempt,
            Math.max(0, maxRetries - retry),
            false,
          );
          return;
        }
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
    let stableRequest = snapshotRequest(request, this.config.providerId);
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
        const response = await session.request(message, stableRequest.signal, continuation?.responseId);
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
        if (!missingContinuation && usesResponsesNativeCheckpoint(stableRequest, this.requestContext()) && !isRetryableResponsesFailure(error)) {
          yield { type: "attempt_started", attempt };
          yield { type: "attempt_discarded", attempt };
          stableRequest = portableCheckpointRequest(stableRequest);
          if (retry >= maxRetries) {
            session.disable();
            yield* this.streamHttp(stableRequest, maxRetries + 1, 0, false);
            return;
          }
          continue;
        }
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
      headers: { ...openAIResponsesHeaders(stream, this.config.userAgent), ...this.authHeaders() },
      body: JSON.stringify(toResponsesBody(request, this.requestContext(), stream, this.config.responsesProfile!)),
      signal: request.signal,
    }, {
      providerId: this.config.providerId,
      signal: request.signal,
      onRetry: request.onRetry,
      policy: { maxRetries },
    });
  }

  private async completeOnce(request: VesicleRequest): Promise<VesicleResponse> {
    const response = await this.fetchResponses(request, false);
    const body = await response.json().catch(() => undefined) as ResponsesBody | undefined;
    if (!response.ok) this.throwHttp(response, body?.error?.message);
    return responseFromResponsesBody(body, this.context(request));
  }

  private requestContext() {
    return {
      providerId: this.config.providerId,
      endpointFingerprint: responsesEndpointFingerprint(this.config.baseUrl),
      profile: this.config.responsesProfile,
    };
  }

  private context(request: VesicleRequest) {
    return {
      requestId: request.id,
      providerId: this.config.providerId,
      model: request.model.model,
      endpointFingerprint: responsesEndpointFingerprint(this.config.baseUrl),
      profile: this.config.responsesProfile,
    };
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
    if (this.config.authMethod === "x-goog-api-key") {
      throw new ProviderError("OpenAI Responses supports bearer or x-api-key authentication only.", {
        kind: "malformed_response", providerId: this.config.providerId,
      });
    }
    if (this.config.authMethod === "x-api-key"
      && this.config.responsesProfile !== "mimo-subset-2026-07-30") {
      throw new ProviderError("OpenAI Responses x-api-key authentication requires mimo-subset-2026-07-30.", {
        kind: "malformed_response", providerId: this.config.providerId,
      });
    }
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
    if (this.config.responsesProfile === "mimo-subset-2026-07-30" && this.config.responsesTransport === "websocket") {
      throw new ProviderError("mimo-subset-2026-07-30 supports HTTP only.", {
        kind: "malformed_response", providerId: this.config.providerId,
      });
    }
    if (this.config.responsesProfile === "openai-public"
      || this.config.responsesProfile === "codex-http-relay"
      || this.config.responsesProfile === "codex-beta-2026-02-06"
      || this.config.responsesProfile === "mimo-subset-2026-07-30") return;
    throw new ProviderError("OpenAI Responses requires an explicit supported responsesProfile.", {
      kind: "malformed_response", providerId: this.config.providerId,
    });
  }

  private webSocketProfile(): "openai-public" | "codex-beta-2026-02-06" {
    if (this.config.responsesProfile === "openai-public") return "openai-public";
    if (this.config.responsesProfile === "codex-beta-2026-02-06") return "codex-beta-2026-02-06";
    throw new ProviderError(`Responses profile ${this.config.responsesProfile ?? "missing"} does not support WebSocket.`, {
      kind: "malformed_response", providerId: this.config.providerId,
    });
  }

  private webSocketHeaders(): Record<string, string> {
    return {
      ...this.authHeaders(),
      "user-agent": this.config.userAgent ?? defaultUserAgent(),
      ...(this.webSocketProfile() === "codex-beta-2026-02-06"
        ? { "openai-beta": "responses_websockets=2026-02-06" }
        : {}),
    };
  }

  private authHeaders(): Record<string, string> {
    return this.config.authMethod === "x-api-key"
      ? { "x-api-key": this.config.apiKey! }
      : { authorization: `Bearer ${this.config.apiKey}` };
  }
}

function portableCheckpointRequest(request: VesicleRequest): VesicleRequest {
  return {
    ...request,
    messages: request.messages.filter((message) => message.kind !== PROVIDER_NATIVE_CHECKPOINT_KIND),
  };
}

function snapshotRequest(request: VesicleRequest, providerId: string): VesicleRequest {
  const { signal, onRetry, ...serializable } = request;
  let snapshot: typeof serializable;
  try {
    snapshot = structuredClone(serializable);
  } catch (cause) {
    throw new ProviderError("OpenAI Responses WebSocket request contains data that cannot be snapshotted safely.", {
      kind: "malformed_response",
      providerId,
      cause,
    });
  }
  return {
    ...snapshot,
    ...(signal ? { signal } : {}),
    ...(onRetry ? { onRetry } : {}),
  };
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
