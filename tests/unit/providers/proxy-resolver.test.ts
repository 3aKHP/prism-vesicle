import { describe, expect, test } from "bun:test";
import {
  describeProviderProxy,
  formatProviderProxyDiagnostic,
  loadProviderProxyPolicy,
  matchesNoProxy,
  proxyRouteFingerprint,
  resolveHttpRoute,
  resolveWebSocketRoute,
  validateProxyUrl,
  type ProviderProxyPolicy,
} from "../../../src/providers/shared/proxy";
import { ProviderError } from "../../../src/providers/shared/errors";

const WSS = new URL("wss://provider.test/v1/responses");
const HTTPS = new URL("https://provider.test/v1/responses");

function policy(args: { userFileEnv?: NodeJS.ProcessEnv; processEnv?: NodeJS.ProcessEnv }): ProviderProxyPolicy {
  return loadProviderProxyPolicy({
    userFileEnv: args.userFileEnv ?? {},
    processEnv: args.processEnv ?? {},
  });
}

describe("proxy policy validation", () => {
  test("accepts http and https URLs without credentials", () => {
    expect(validateProxyUrl("http://proxy.example:8080").scheme).toBe("http");
    expect(validateProxyUrl("https://proxy.example:8080").scheme).toBe("https");
    expect(validateProxyUrl("http://proxy.example:8080").authConfigured).toBe(false);
  });

  test("recognizes URL userinfo as Basic auth configured", () => {
    expect(validateProxyUrl("http://u:p@proxy.example:8080").authConfigured).toBe(true);
  });

  test("rejects unsupported schemes with unsupported_proxy_scheme", () => {
    for (const raw of ["socks5://h:1080", "ftp://h:21", "socks://h"]) {
      expect(() => validateProxyUrl(raw)).toThrow(expect.objectContaining({ code: "unsupported_proxy_scheme" }));
    }
  });

  test("rejects malformed URLs with invalid_proxy_config and never echoes secrets", () => {
    // Each input is invalid for a distinct reason AND carries a unique secret;
    // the fixed safe message must not echo any secret-bearing token.
    const cases = [
      "http://leak-user:leak-pass@bad-host:1/extra-path", // path present
      "http://leak-user@bad-host:1?x=1",                  // query present
      "http://leak-user@bad-host:1#frag",                 // fragment present
      "ftp://leak-user@bad-host:1",                        // unsupported scheme (separate code)
    ];
    for (const raw of cases) {
      let caught: unknown;
      try { validateProxyUrl(raw); } catch (e) { caught = e; }
      expect(caught).toBeInstanceOf(ProviderError);
      const msg = caught instanceof Error ? caught.message : "";
      for (const secret of ["leak-user", "leak-pass", "bad-host"]) {
        expect(msg).not.toContain(secret);
      }
    }
  });
});

describe("proxy policy precedence", () => {
  test("explicit user-file wins over process standard vars", () => {
    const p = policy({ userFileEnv: { VESICLE_PROVIDER_PROXY: "http://uf:8080" }, processEnv: { HTTPS_PROXY: "http://std:8080" } });
    expect(p).toEqual(expect.objectContaining({ kind: "explicit", source: "user-file" }));
  });

  test("process-vesicle wins over standard vars", () => {
    const p = policy({ processEnv: { VESICLE_PROVIDER_PROXY: "http://pv:8080", HTTPS_PROXY: "http://std:8080" } });
    expect(p).toEqual(expect.objectContaining({ kind: "explicit", source: "process-vesicle" }));
  });

  test("blank user-file key falls through to standard env", () => {
    const p = policy({ userFileEnv: { VESICLE_PROVIDER_PROXY: "   " }, processEnv: { HTTPS_PROXY: "http://std:8080" } });
    expect(p.kind).toBe("environment");
  });

  test("whitespace-only is absent", () => {
    expect(policy({ userFileEnv: { VESICLE_PROVIDER_PROXY: "\t " } }).kind).toBe("direct");
  });

  test("no proxy vars anywhere is direct", () => {
    expect(policy({}).kind).toBe("direct");
  });
});

describe("HTTP route resolution", () => {
  test("explicit policy yields a proxy route", () => {
    const p = policy({ userFileEnv: { VESICLE_PROVIDER_PROXY: "http://u:p@proxy.example:8080" } });
    expect(resolveHttpRoute(p)).toEqual(expect.objectContaining({ kind: "proxy", source: "user-file", auth: "basic" }));
  });

  test("inherited and direct defer to Bun (transport-default)", () => {
    expect(resolveHttpRoute(policy({ processEnv: { HTTPS_PROXY: "http://std:8080" } })).kind).toBe("transport-default");
    expect(resolveHttpRoute(policy({})).kind).toBe("transport-default");
  });
});

describe("WebSocket route resolution (mirrors Bun 1.3.14)", () => {
  test("explicit Vesicle proxy is never bypassed by terminal NO_PROXY", () => {
    const p = policy({ userFileEnv: { VESICLE_PROVIDER_PROXY: "http://u:p@proxy.example:8080" } });
    expect(resolveWebSocketRoute(WSS, p).kind).toBe("proxy");
  });

  test("direct policy resolves direct", () => {
    expect(resolveWebSocketRoute(WSS, policy({}))).toEqual({ kind: "direct", reason: "none" });
  });

  test("selects https_proxy / HTTPS_PROXY for wss; lowercase preferred", () => {
    const lower = resolveWebSocketRoute(WSS, policy({ processEnv: { https_proxy: "http://lowhost:8080", HTTPS_PROXY: "http://upphost:8080" } })) as { kind: string; secretUrl: { forBun: () => string } };
    expect(lower.kind).toBe("proxy");
    expect(lower.secretUrl.forBun()).toContain("lowhost");
    const onlyUp = resolveWebSocketRoute(WSS, policy({ processEnv: { HTTPS_PROXY: "http://upphost:8080" } })) as { secretUrl: { forBun: () => string } };
    expect(onlyUp.secretUrl.forBun()).toContain("upphost");
  });

  test("HTTP_PROXY / ALL_PROXY are ignored for wss (parity with Bun fetch)", () => {
    expect(resolveWebSocketRoute(WSS, policy({ processEnv: { HTTP_PROXY: "http://h:8080" } })).kind).toBe("direct");
    expect(resolveWebSocketRoute(WSS, policy({ processEnv: { ALL_PROXY: "http://h:8080" } })).kind).toBe("direct");
  });

  test("NO_PROXY bypasses: *, exact host, dot suffix; case-insensitive", () => {
    for (const noProxy of ["*", "provider.test", ".test", "PROVIDER.TEST", "other,provider.test"]) {
      const route = resolveWebSocketRoute(WSS, policy({ processEnv: { HTTPS_PROXY: "http://h:8080", NO_PROXY: noProxy } }));
      expect(route).toEqual({ kind: "direct", reason: "no-proxy" });
    }
  });

  test("NO_PROXY port and *. wildcard forms do NOT bypass (Bun does not support them)", () => {
    for (const noProxy of ["provider.test:443", "*.test", "other.com"]) {
      const route = resolveWebSocketRoute(WSS, policy({ processEnv: { HTTPS_PROXY: "http://h:8080", NO_PROXY: noProxy } }));
      expect(route.kind).toBe("proxy");
    }
  });

  test("no_proxy lowercase honored when uppercase NO_PROXY is blank/absent", () => {
    expect(resolveWebSocketRoute(WSS, policy({ processEnv: { HTTPS_PROXY: "http://h:8080", no_proxy: "provider.test" } })).kind).toBe("direct");
    expect(resolveWebSocketRoute(WSS, policy({ processEnv: { HTTPS_PROXY: "http://h:8080", NO_PROXY: "", no_proxy: "provider.test" } })).kind).toBe("direct");
  });

  test("malformed NO_PROXY entries are ignored individually", () => {
    expect(resolveWebSocketRoute(WSS, policy({ processEnv: { HTTPS_PROXY: "http://h:8080", NO_PROXY: ":::bad,provider.test" } })).kind).toBe("direct");
  });
});

describe("NO_PROXY matcher", () => {
  const cases: Array<[string, string, boolean]> = [
    ["*", "anything.test", true],
    ["provider.test", "provider.test", true],
    ["PROVIDER.TEST", "provider.test", true],
    [".test", "provider.test", true],
    [".test", "test", true],
    ["provider.test", "other.test", false],
    ["*.test", "provider.test", false],
    ["provider.test:443", "provider.test", false],
    ["other.com,provider.test", "provider.test", true],
    ["  provider.test  ", "provider.test", true],
    [":::bad,provider.test", "provider.test", true],
    ["127.0.0.1", "127.0.0.1", true],
  ];
  for (const [noProxy, host, expected] of cases) {
    test(`NO_PROXY=${JSON.stringify(noProxy)} host=${host} -> ${expected}`, () => {
      expect(matchesNoProxy(noProxy, host)).toBe(expected);
    });
  }
});

describe("route fingerprint and redaction", () => {
  const canaryPolicy = policy({
    userFileEnv: { VESICLE_PROVIDER_PROXY: "http://canary-user:canary-pass@canary-host.example:8099" },
  });

  test("fingerprint is stable and changes with route or URL", () => {
    const route = resolveWebSocketRoute(WSS, canaryPolicy);
    const same = resolveWebSocketRoute(WSS, canaryPolicy);
    expect(proxyRouteFingerprint(route)).toBe(proxyRouteFingerprint(same));
    const differentUrl = policy({ userFileEnv: { VESICLE_PROVIDER_PROXY: "http://canary-user:canary-pass@canary-host.example:8100" } });
    expect(proxyRouteFingerprint(route)).not.toBe(proxyRouteFingerprint(resolveWebSocketRoute(WSS, differentUrl)));
    expect(proxyRouteFingerprint(route)).not.toBe(proxyRouteFingerprint({ kind: "direct", reason: "none" }));
  });

  test("no proxy URL/credential appears in route JSON, diagnostic, formatted line, or fingerprint", () => {
    const canaries = ["canary-user", "canary-pass", "canary-host", "8099"];
    const route = resolveWebSocketRoute(WSS, canaryPolicy);
    const diag = describeProviderProxy(canaryPolicy, WSS);
    const line = formatProviderProxyDiagnostic(diag);
    const fp = proxyRouteFingerprint(route);
    const routeJson = JSON.stringify(route);
    for (const c of canaries) {
      expect(routeJson).not.toContain(c);
      expect(line).not.toContain(c);
      expect(fp).not.toContain(c);
    }
  });
});

describe("doctor diagnostic", () => {
  test("explicit reports source, scheme, and auth without revealing the URL", () => {
    const p = policy({ userFileEnv: { VESICLE_PROVIDER_PROXY: "http://secret-user:secret-pass@secret-host:9000" } });
    const diag = describeProviderProxy(p, HTTPS);
    expect(diag).toEqual(expect.objectContaining({ route: "proxy-configured", source: "user-file", scheme: "http", authConfigured: true }));
    expect(formatProviderProxyDiagnostic(diag)).not.toContain("secret");
  });

  test("inherited bypass reports bypassed state", () => {
    const p = policy({ processEnv: { HTTPS_PROXY: "http://h:8080", NO_PROXY: "provider.test" } });
    expect(describeProviderProxy(p, HTTPS).route).toBe("bypassed");
  });

  test("direct reports no route", () => {
    expect(describeProviderProxy(policy({}), HTTPS).route).toBe("direct");
  });
});
