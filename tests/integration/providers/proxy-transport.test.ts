import { afterEach, describe, expect, test } from "bun:test";
import { fetchProvider } from "../../../src/providers/shared/fetch";
import { ProviderError } from "../../../src/providers/shared/errors";
import { loadProviderProxyPolicy, type ProviderProxyPolicy } from "../../../src/providers/shared/proxy";
import { startProxyFixture } from "../../support/providers/proxy-fixture";

let fixture: Awaited<ReturnType<typeof startProxyFixture>> | undefined;

afterEach(() => {
  fixture?.stop();
  fixture = undefined;
});

function explicitPolicy(proxyUrl: string): ProviderProxyPolicy {
  return loadProviderProxyPolicy({ userFileEnv: { VESICLE_PROVIDER_PROXY: proxyUrl }, processEnv: {} });
}

describe("provider fetch proxy boundary (real CONNECT)", () => {
  test("explicit proxy routes HTTPS JSON through the CONNECT tunnel", async () => {
    fixture = await startProxyFixture();
    fixture.observer.reset();
    const response = await fetchProvider(
      "https://provider.test/json?echo=proxied",
      { method: "GET" },
      { providerId: "test", proxyPolicy: explicitPolicy(fixture.proxyUrl), tlsCa: [fixture.ca], policy: { maxRetries: 0 } },
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, echo: "proxied" });
    expect(fixture.observer.connects).toBe(1);
    expect(fixture.observer.events[0]).toEqual({ authPresent: true, authValid: true });
  });

  test("explicit proxy carries an SSE stream through the tunnel", async () => {
    fixture = await startProxyFixture();
    const response = await fetchProvider(
      "https://provider.test/sse",
      { method: "GET" },
      { providerId: "test", proxyPolicy: explicitPolicy(fixture.proxyUrl), tlsCa: [fixture.ca], policy: { maxRetries: 0 } },
    );
    const text = await response.text();
    expect((text.match(/data:/g) ?? []).length).toBe(2);
    expect(fixture.observer.connects).toBe(1);
  });

  test("proxy 407 is terminal with proxy_authentication_required and is not retried", async () => {
    fixture = await startProxyFixture();
    fixture.observer.reset();
    let caught: unknown;
    try {
      await fetchProvider(
        "https://provider.test/json",
        { method: "GET" },
        { providerId: "test", proxyPolicy: explicitPolicy(fixture.badAuthProxyUrl), tlsCa: [fixture.ca], policy: { maxRetries: 5 } },
      );
    } catch (error) { caught = error; }
    expect(caught).toBeInstanceOf(ProviderError);
    expect((caught as ProviderError).code).toBe("proxy_authentication_required");
    expect((caught as ProviderError).retryable).toBe(false);
    // Terminal: exactly one CONNECT, no retry of known-bad credentials.
    expect(fixture.observer.connects).toBe(1);
  });

  test("unreachable proxy is retried as a transport attempt, then sanitized", async () => {
    const delays: number[] = [];
    let caught: unknown;
    try {
      await fetchProvider(
        "https://provider.test/json",
        { method: "GET" },
        {
          providerId: "test",
          proxyPolicy: explicitPolicy("http://canary-user:canary-pass@127.0.0.1:9"),
          tlsCa: [], // unreachable proxy; origin TLS never reached
          policy: { maxRetries: 2, baseDelayMs: 10, maxDelayMs: 10 },
          random: () => 0.5,
          sleep: async (delay) => { delays.push(delay); },
        },
      );
    } catch (error) { caught = error; }
    expect(caught).toBeInstanceOf(ProviderError);
    const err = caught as ProviderError;
    expect(err.code).toBe("proxy_connect_failed");
    expect(err.attempts).toBe(3);
    expect(delays).toHaveLength(2);
    // Sanitized: no credentials leak into the message.
    expect(err.message).not.toContain("canary-user");
    expect(err.message).not.toContain("canary-pass");
  });

  test("without a proxy policy the synthetic host is unreachable directly (direct oracle)", async () => {
    fixture = await startProxyFixture();
    fixture.observer.reset();
    let caught: unknown;
    try {
      await fetchProvider(
        "https://provider.test/json",
        { method: "GET" },
        { providerId: "test", tlsCa: [fixture.ca], policy: { maxRetries: 0 } },
      );
    } catch (error) { caught = error; }
    expect(caught).toBeInstanceOf(ProviderError);
    // provider.test does not resolve, so direct routing cannot reach it; and the
    // proxy observed no CONNECT, proving the request did not cross the tunnel.
    expect(fixture.observer.connects).toBe(0);
  });
});
