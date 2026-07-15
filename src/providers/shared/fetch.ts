import { ProviderError } from "./errors";

export type ProviderRetryPolicy = {
  maxRetries: number;
  baseDelayMs: number;
  maxDelayMs: number;
};

type ProviderFetchOptions = {
  providerId?: string;
  signal?: AbortSignal;
  policy?: Partial<ProviderRetryPolicy>;
  random?: () => number;
  now?: () => number;
  sleep?: (delayMs: number, signal?: AbortSignal) => Promise<void>;
  attemptHeaders?: (retryCount: number) => HeadersInit;
};

const defaultRetryPolicy: ProviderRetryPolicy = {
  maxRetries: 2,
  baseDelayMs: 500,
  maxDelayMs: 8_000,
};

/**
 * Retries failures that are safe before a provider response is consumed.
 * Streaming body failures stay with the stream parser so partial output is
 * never replayed implicitly by this transport helper.
 */
export async function fetchProvider(
  input: string | URL | Request,
  init: RequestInit,
  options: ProviderFetchOptions = {},
): Promise<Response> {
  const policy = { ...defaultRetryPolicy, ...options.policy };
  const random = options.random ?? Math.random;
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? abortableSleep;
  const signal = options.signal ?? init.signal ?? (input instanceof Request ? input.signal : undefined) ?? undefined;
  let retries = 0;

  while (true) {
    throwIfAborted(signal);
    try {
      const response = await fetch(input, withAttemptHeaders(init, options.attemptHeaders?.(retries)));
      if (!isRetryableStatus(response.status) || retries >= policy.maxRetries) return response;

      const delayMs = retryDelayMs(response, retries, policy, random, now);
      await response.body?.cancel().catch(() => undefined);
      await sleep(delayMs, signal);
      retries += 1;
    } catch (error) {
      if (signal?.aborted) throw abortError(signal);
      if (isAbortError(error)) throw error;
      if (retries >= policy.maxRetries) {
        const attempts = retries + 1;
        throw new ProviderError(
          `Provider network request failed after ${attempts} attempts: ${errorMessage(error)}`,
          {
            kind: "network_error",
            providerId: options.providerId,
            retryable: true,
            attempts,
            cause: error,
          },
        );
      }

      await sleep(exponentialDelayMs(retries, policy, random), signal);
      retries += 1;
    }
  }
}

function withAttemptHeaders(init: RequestInit, attemptHeaders?: HeadersInit): RequestInit {
  if (!attemptHeaders) return init;
  const headers = new Headers(init.headers);
  new Headers(attemptHeaders).forEach((value, key) => headers.set(key, value));
  return { ...init, headers };
}

export function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

export function exponentialDelayMs(
  retry: number,
  policy: ProviderRetryPolicy = defaultRetryPolicy,
  random: () => number = Math.random,
): number {
  const raw = Math.min(policy.maxDelayMs, policy.baseDelayMs * (2 ** retry));
  const jitter = 0.9 + (Math.max(0, Math.min(1, random())) * 0.2);
  return Math.min(policy.maxDelayMs, Math.round(raw * jitter));
}

function retryDelayMs(
  response: Response,
  retry: number,
  policy: ProviderRetryPolicy,
  random: () => number,
  now: () => number,
): number {
  const retryAfter = parseRetryAfterMs(response.headers.get("retry-after"), now());
  return retryAfter === undefined
    ? exponentialDelayMs(retry, policy, random)
    : Math.min(policy.maxDelayMs, retryAfter);
}

function parseRetryAfterMs(value: string | null, nowMs: number): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1_000;

  const at = Date.parse(value);
  if (!Number.isFinite(at)) return undefined;
  return Math.max(0, at - nowMs);
}

function abortableSleep(delayMs: number, signal?: AbortSignal): Promise<void> {
  throwIfAborted(signal);
  if (delayMs <= 0) {
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(done, delayMs);
    signal?.addEventListener("abort", aborted, { once: true });

    function done(): void {
      signal?.removeEventListener("abort", aborted);
      resolve();
    }
    function aborted(): void {
      clearTimeout(timer);
      reject(abortError(signal));
    }
  });
}

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  throw abortError(signal);
}

function abortError(signal?: AbortSignal): DOMException {
  const message = typeof signal?.reason === "string" && signal.reason.trim()
    ? signal.reason
    : "The operation was aborted.";
  return new DOMException(message, "AbortError");
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim()) return error.message;
  return String(error);
}
