import { afterEach, describe, expect, test } from "bun:test";
import { fetchProvider, exponentialDelayMs, isRetryableStatus } from "../src/providers/shared/fetch";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("provider fetch retries", () => {
  test("retries transient network failures with exponential delays", async () => {
    const delays: number[] = [];
    let attempts = 0;
    globalThis.fetch = (async () => {
      attempts += 1;
      if (attempts < 3) throw new TypeError("socket closed");
      return Response.json({ ok: true });
    }) as unknown as typeof fetch;

    const response = await fetchProvider("https://provider.test", {}, {
      providerId: "test",
      random: () => 0.5,
      sleep: async (delay) => { delays.push(delay); },
    });

    expect(response.ok).toBe(true);
    expect(attempts).toBe(3);
    expect(delays).toEqual([500, 1_000]);
  });

  test("recomputes attempt-specific headers for every retry", async () => {
    const retryCounts: string[] = [];
    globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
      retryCounts.push(new Headers(init?.headers).get("x-retry-count") ?? "missing");
      if (retryCounts.length < 3) return new Response("busy", { status: 503 });
      return Response.json({ ok: true });
    }) as unknown as typeof fetch;

    await fetchProvider("https://provider.test", { headers: { "x-static": "value" } }, {
      attemptHeaders: (retryCount) => ({ "x-retry-count": String(retryCount) }),
      random: () => 0.5,
      sleep: async () => undefined,
    });

    expect(retryCounts).toEqual(["0", "1", "2"]);
  });

  test("honors Retry-After for retryable HTTP responses", async () => {
    const delays: number[] = [];
    let attempts = 0;
    globalThis.fetch = (async () => {
      attempts += 1;
      if (attempts === 1) return new Response("busy", { status: 429, headers: { "retry-after": "2" } });
      return Response.json({ ok: true });
    }) as unknown as typeof fetch;

    const response = await fetchProvider("https://provider.test", {}, {
      sleep: async (delay) => { delays.push(delay); },
    });

    expect(response.ok).toBe(true);
    expect(attempts).toBe(2);
    expect(delays).toEqual([2_000]);
  });

  test("caps an HTTP-date Retry-After value", async () => {
    const delays: number[] = [];
    let attempts = 0;
    globalThis.fetch = (async () => {
      attempts += 1;
      if (attempts === 1) {
        return new Response("busy", {
          status: 503,
          headers: { "retry-after": "Wed, 01 Jan 2025 00:00:20 GMT" },
        });
      }
      return Response.json({ ok: true });
    }) as unknown as typeof fetch;

    await fetchProvider("https://provider.test", {}, {
      now: () => Date.parse("Wed, 01 Jan 2025 00:00:00 GMT"),
      sleep: async (delay) => { delays.push(delay); },
    });

    expect(delays).toEqual([8_000]);
  });

  test("does not retry ordinary client errors", async () => {
    let attempts = 0;
    globalThis.fetch = (async () => {
      attempts += 1;
      return new Response("bad request", { status: 400 });
    }) as unknown as typeof fetch;

    const response = await fetchProvider("https://provider.test", {});

    expect(response.status).toBe(400);
    expect(attempts).toBe(1);
  });

  test("wraps an exhausted transport failure with attempt metadata", async () => {
    globalThis.fetch = (async () => {
      throw new TypeError("The socket connection was closed unexpectedly.");
    }) as unknown as typeof fetch;

    await expect(fetchProvider("https://provider.test", {}, {
      providerId: "doro-grok",
      sleep: async () => undefined,
    })).rejects.toMatchObject({
      name: "ProviderError",
      kind: "network_error",
      providerId: "doro-grok",
      retryable: true,
      attempts: 3,
    });
  });

  test("aborts during backoff without starting another request", async () => {
    const controller = new AbortController();
    let attempts = 0;
    globalThis.fetch = (async () => {
      attempts += 1;
      return new Response("busy", { status: 503 });
    }) as unknown as typeof fetch;

    const pending = fetchProvider("https://provider.test", { signal: controller.signal }, {
      signal: controller.signal,
      policy: { baseDelayMs: 100 },
      random: () => 0.5,
    });
    controller.abort("user-cancel");

    await expect(pending).rejects.toMatchObject({ name: "AbortError", message: "user-cancel" });
    expect(attempts).toBe(1);
  });

  test("classifies only timeout, rate-limit, and server statuses as retryable", () => {
    expect([408, 429, 500, 503].map(isRetryableStatus)).toEqual([true, true, true, true]);
    expect([400, 401, 403, 404].map(isRetryableStatus)).toEqual([false, false, false, false]);
  });

  test("caps exponential backoff and applies bounded jitter", () => {
    const policy = { maxRetries: 20, baseDelayMs: 500, maxDelayMs: 8_000 };
    expect(exponentialDelayMs(0, policy, () => 0)).toBe(450);
    expect(exponentialDelayMs(1, policy, () => 0.5)).toBe(1_000);
    expect(exponentialDelayMs(10, policy, () => 1)).toBe(8_000);
  });
});
