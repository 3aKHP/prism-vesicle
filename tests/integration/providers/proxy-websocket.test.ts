import { afterEach, describe, expect, test } from "bun:test";
import type { VesicleConfig } from "../../../src/config/env";
import { OpenAIResponsesAdapter } from "../../../src/providers/openai-responses/adapter";
import {
  closeResponsesWebSocketSession,
  responsesWebSocketSession,
  responsesWebSocketUrl,
  type ResponsesSocket,
} from "../../../src/providers/openai-responses/websocket";
import { ProviderError } from "../../../src/providers/shared/errors";
import {
  loadProviderProxyPolicy,
  proxyRouteFingerprint,
  resolveWebSocketRoute,
  validateProxyUrl,
  type ProviderProxyPolicy,
  type ProviderProxyRoute,
} from "../../../src/providers/shared/proxy";
import type { VesicleRequest } from "../../../src/providers/shared/types";
import { startProxyFixture } from "../../support/providers/proxy-fixture";

let fixture: Awaited<ReturnType<typeof startProxyFixture>> | undefined;
const sessions: string[] = [];

afterEach(() => {
  for (const id of sessions.splice(0)) closeResponsesWebSocketSession(id);
  fixture?.stop();
  fixture = undefined;
});

function explicitPolicy(proxyUrl: string): ProviderProxyPolicy {
  return loadProviderProxyPolicy({ userFileEnv: { VESICLE_PROVIDER_PROXY: proxyUrl }, processEnv: {} });
}

/** Real Bun WebSocket factory that mirrors production proxy logic and adds the
 *  test-only CA trust the fixture's self-signed origin requires. */
function realFactory(ca: string): (url: string, headers: Record<string, string>, route: ProviderProxyRoute) => ResponsesSocket {
  return (url, _headers, route) => {
    // lib.dom's WebSocket constructor hides Bun's options overload; name it.
    const BunWebSocket = WebSocket as unknown as { new(url: string, options: Bun.WebSocketOptions): WebSocket };
    const options = route.kind === "proxy"
      ? { proxy: route.secretUrl.forBun(), tls: { ca: [ca] } }
      : { tls: { ca: [ca] } };
    return new BunWebSocket(url, options) as unknown as ResponsesSocket;
  };
}

describe("Responses WebSocket proxy boundary (real WSS CONNECT)", () => {
  test("native WebSocket routes through the proxy and completes a request", async () => {
    fixture = await startProxyFixture();
    fixture.observer.reset();
    const sessionId = "ws-proxied";
    sessions.push(sessionId);
    const policy = explicitPolicy(fixture.proxyUrl);
    const route = resolveWebSocketRoute(new URL(responsesWebSocketUrl("https://ws-provider.test/v1")), policy);
    const session = responsesWebSocketSession({
      sessionId,
      owner: "test",
      baseUrl: "https://ws-provider.test/v1",
      providerId: "test",
      headers: {},
      factory: realFactory(fixture.ca),
      proxyRoute: route,
      routeFingerprint: proxyRouteFingerprint(route),
      requestTimeoutMs: 5_000,
    });
    const response = await session.request({ type: "response.create" });
    expect(response.headers.get("content-type")).toBe("text/event-stream");
    const text = await response.text();
    expect(text).toContain("response.completed");
    expect(fixture.observer.connects).toBe(1);
    expect(fixture.observer.events[0]).toEqual({ authPresent: true, authValid: true });
  });

  test("the session-scoped socket is reused across requests on an unchanged route", async () => {
    fixture = await startProxyFixture();
    fixture.observer.reset();
    const sessionId = "ws-reuse";
    sessions.push(sessionId);
    const policy = explicitPolicy(fixture.proxyUrl);
    const route = resolveWebSocketRoute(new URL(responsesWebSocketUrl("https://ws-provider.test/v1")), policy);
    const session = responsesWebSocketSession({
      sessionId,
      owner: "test",
      baseUrl: "https://ws-provider.test/v1",
      providerId: "test",
      headers: {},
      factory: realFactory(fixture.ca),
      proxyRoute: route,
      routeFingerprint: proxyRouteFingerprint(route),
      requestTimeoutMs: 5_000,
    });
    await session.request({ type: "response.create" });
    await session.request({ type: "response.create" });
    // One CONNECT tunneled one reused WebSocket for both logical requests.
    expect(fixture.observer.connects).toBe(1);
  });
});

describe("Responses WebSocket socket ownership respects the route fingerprint", () => {
  test("unchanged route reuses the session; a changed route replaces it", () => {
    fixture = undefined;
    const sessionId = "ws-owner";
    sessions.push(sessionId);
    const routeA: ProviderProxyRoute = { kind: "proxy", source: "user-file", secretUrl: validateProxyUrl("http://a-host:8080"), auth: "basic" };
    const routeB: ProviderProxyRoute = { kind: "proxy", source: "user-file", secretUrl: validateProxyUrl("http://b-host:8080"), auth: "basic" };
    const base = { sessionId, owner: "test", baseUrl: "https://ws-provider.test/v1", providerId: "test", headers: {} };
    const s1 = responsesWebSocketSession({ ...base, proxyRoute: routeA, routeFingerprint: proxyRouteFingerprint(routeA) });
    const s2 = responsesWebSocketSession({ ...base, proxyRoute: routeA, routeFingerprint: proxyRouteFingerprint(routeA) });
    expect(s2).toBe(s1); // unchanged route reuses
    const s3 = responsesWebSocketSession({ ...base, proxyRoute: routeB, routeFingerprint: proxyRouteFingerprint(routeB) });
    expect(s3).not.toBe(s1); // changed route replaces
  });

  test("a direct route and a proxy route have distinct fingerprints", () => {
    const proxy: ProviderProxyRoute = { kind: "proxy", source: "user-file", secretUrl: validateProxyUrl("http://h:8080"), auth: "none" };
    const direct: ProviderProxyRoute = { kind: "direct", reason: "none" };
    expect(proxyRouteFingerprint(proxy)).not.toBe(proxyRouteFingerprint(direct));
  });
});

describe("Responses WebSocket proxy auth is terminal (adapter-level)", () => {
  test("bounds a stalled proxy-auth preflight with the socket request timeout", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = ((_input: unknown, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
    })) as typeof fetch;
    try {
      const sessionId = "ws-preflight-timeout";
      sessions.push(sessionId);
      const route: ProviderProxyRoute = {
        kind: "proxy",
        source: "user-file",
        secretUrl: validateProxyUrl("http://stalled-proxy.test:8080"),
        auth: "none",
      };
      const session = responsesWebSocketSession({
        sessionId,
        owner: "test",
        baseUrl: "https://ws-provider.test/v1",
        providerId: "test",
        headers: {},
        requestTimeoutMs: 5,
      });

      await expect(session.verifyProxyAuth(route, "https://ws-provider.test/v1")).resolves.toBeUndefined();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("proxy 407 on the WS route raises immediately: no WS attempt, no HTTP fallback", async () => {
    fixture = await startProxyFixture();
    fixture.observer.reset();
    const sessionId = "ws-badcreds";
    sessions.push(sessionId);
    const config: VesicleConfig = {
      provider: "openai-responses",
      providerId: "test",
      baseUrl: "https://ws-provider.test/v1",
      model: "gpt-test",
      apiKey: "test-key",
      responsesProfile: "openai-public",
      responsesTransport: "websocket",
    };
    const request: VesicleRequest = {
      id: "badcreds-1",
      model: { provider: "test", model: "gpt-test" },
      system: ["s"],
      messages: [{ role: "user", content: "hi" }],
    };
    let factoryCalled = false;
    const adapter = new OpenAIResponsesAdapter(config, {
      sessionId,
      proxyPolicy: explicitPolicy(fixture.badAuthProxyUrl),
      // The WS factory must never run: proxy 407 is raised before the retry loop.
      webSocketFactory: () => { factoryCalled = true; throw new Error("WS factory must not be called on proxy 407"); },
    });
    let caught: unknown;
    try {
      for await (const event of adapter.stream(request)) void event;
    } catch (error) { caught = error; }
    expect(caught).toBeInstanceOf(ProviderError);
    expect((caught as ProviderError).code).toBe("proxy_authentication_required");
    expect((caught as ProviderError).retryable).toBe(false);
    expect(factoryCalled).toBe(false);
    // Exactly one CONNECT: the preflight, answered 407. No WS CONNECT, no HTTP fallback CONNECT.
    expect(fixture.observer.connects).toBe(1);
    expect(fixture.observer.events[0]).toEqual({ authPresent: true, authValid: false });
  });
});
