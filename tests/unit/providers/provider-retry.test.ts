import { describe, expect, it } from "bun:test";
import { fetchProvider } from "../../../src/providers/shared/fetch";

function stubResponse(status: number): Response {
  return new Response('{"error":{"message":"x"}}', {
    status,
    headers: { "content-type": "application/json" },
  });
}

/**
 * The transport retry loop is the single source of retry decisions. These
 * tests pin the `onRetry` notification contract that lets the TUI observe it
 * without owning its own retry loop.
 */
describe("fetchProvider onRetry notification", () => {
  it("fires onRetry before each retryable-status retry with attempt/maxRetries/status", async () => {
    const calls: Array<{ attempt: number; maxRetries: number; status?: number }> = [];
    let n = 0;
    const original = globalThis.fetch;
    globalThis.fetch = (async () => stubResponse(++n < 3 ? 429 : 200)) as unknown as typeof fetch;
    try {
      await fetchProvider("https://example.test", { method: "POST" }, {
        providerId: "p",
        policy: { maxRetries: 2, baseDelayMs: 1, maxDelayMs: 1 },
        sleep: async () => undefined,
        onRetry: (info) => calls.push({ attempt: info.attempt, maxRetries: info.maxRetries, status: info.status }),
      });
    } finally {
      globalThis.fetch = original;
    }
    expect(calls).toEqual([
      { attempt: 1, maxRetries: 2, status: 429 },
      { attempt: 2, maxRetries: 2, status: 429 },
    ]);
  });

  it("does not fire onRetry when the first response succeeds", async () => {
    let called = false;
    const original = globalThis.fetch;
    globalThis.fetch = (async () => stubResponse(200)) as unknown as typeof fetch;
    try {
      await fetchProvider("https://example.test", { method: "POST" }, {
        providerId: "p",
        sleep: async () => undefined,
        onRetry: () => { called = true; },
      });
    } finally {
      globalThis.fetch = original;
    }
    expect(called).toBe(false);
  });

  it("fires onRetry on network errors with no status", async () => {
    const calls: Array<{ attempt: number; status?: number }> = [];
    const original = globalThis.fetch;
    let n = 0;
    globalThis.fetch = (async () => {
      n += 1;
      if (n < 2) throw new TypeError("network down");
      return stubResponse(200);
    }) as unknown as typeof fetch;
    try {
      await fetchProvider("https://example.test", { method: "POST" }, {
        providerId: "p",
        policy: { maxRetries: 2, baseDelayMs: 1, maxDelayMs: 1 },
        sleep: async () => undefined,
        onRetry: (info) => calls.push({ attempt: info.attempt, status: info.status }),
      });
    } finally {
      globalThis.fetch = original;
    }
    expect(calls).toEqual([{ attempt: 1, status: undefined }]);
  });
});
