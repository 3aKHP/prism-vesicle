import { describe, expect, test } from "bun:test";
import { createMcpConnection } from "../../../src/mcp/connection";
import { createMcpRegistryForEngine } from "../../../src/mcp/registry";
import { createLoopbackFixture } from "../../support/mcp/loopback";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

function serverConfig(url: string, negotiation: "legacy" | "modern" | "auto", id = "test") {
  return {
    id,
    enabled: true,
    transport: "streamable-http" as const,
    url,
    headers: {},
    timeoutSeconds: 5,
    protocolVersion: "2025-03-26",
    negotiation,
    supportedProtocolVersions: negotiation === "legacy" ? [] : ["2026-07-28"],
    includeTools: [],
    excludeTools: [],
    enabledEngines: [],
  };
}

// ─── Wave 3: Strict modern connection ─────────────────────────────────────

describe("MCP strict modern connection", () => {
  test("connects via server/discover and never sends initialize", async () => {
    const fixture = await createLoopbackFixture({ mode: "modern" });
    try {
      const result = await createMcpConnection(serverConfig(fixture.url, "modern"));
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.connection.info.era).toBe("modern");
      expect(result.connection.info.protocolVersion).toBe("2026-07-28");

      const methods = fixture.observations.map((o) => o.method);
      expect(methods).toContain("server/discover");
      expect(methods).not.toContain("initialize");
      expect(methods).not.toContain("notifications/initialized");

      // Modern routing headers present on requests after discover
      await result.connection.listTools();
      const listObs = fixture.observations.find((o) => o.method === "tools/list");
      expect(listObs?.hasProtocolVersionHeader).toBe(true);
      expect(listObs?.hasMethodHeader).toBe(true);
      expect(listObs?.hasMetaEnvelope).toBe(true);

      // No session id on any modern request
      expect(fixture.observations.every((o) => !o.hasSessionId)).toBe(true);

      await result.connection.close();
    } finally {
      await fixture.close();
    }
  });

  test("lists and calls tools over modern protocol", async () => {
    const fixture = await createLoopbackFixture({ mode: "modern", toolName: "compute" });
    try {
      const result = await createMcpConnection(serverConfig(fixture.url, "modern"));
      if (!result.ok) throw new Error("connect failed");

      const tools = await result.connection.listTools();
      expect(tools).toHaveLength(1);
      expect(tools[0]?.name).toBe("compute");

      const callResult = await result.connection.callTool("compute", {});
      expect(callResult.text).toEqual(["modern result from compute"]);
      expect(callResult.isError).toBe(false);
      expect(fixture.counts.toolCalls).toBe(1);

      await result.connection.close();
    } finally {
      await fixture.close();
    }
  });

  test("aborts a modern tool call without executing a retry", async () => {
    const fixture = await createLoopbackFixture({ mode: "modern", toolName: "slow" });
    try {
      const result = await createMcpConnection(serverConfig(fixture.url, "modern"));
      if (!result.ok) throw new Error("connect failed");

      const controller = new AbortController();
      const running = result.connection.callTool("slow", {}, { signal: controller.signal });
      controller.abort(new DOMException("cancelled", "AbortError"));
      await expect(running).rejects.toThrow();

      // Tool call executed at most once (the aborted call may or may not reach the server)
      expect(fixture.counts.toolCalls).toBeLessThanOrEqual(1);

      await result.connection.close();
    } finally {
      await fixture.close();
    }
  });
});

// ─── Wave 4: Auto negotiation ─────────────────────────────────────────────

describe("MCP auto negotiation", () => {
  test("auto selects modern when server supports server/discover", async () => {
    const fixture = await createLoopbackFixture({ mode: "modern" });
    try {
      const result = await createMcpConnection(serverConfig(fixture.url, "auto"));
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.connection.info.era).toBe("modern");
      expect(fixture.observations.some((o) => o.method === "server/discover")).toBe(true);
      expect(fixture.observations.some((o) => o.method === "initialize")).toBe(false);
      await result.connection.close();
    } finally {
      await fixture.close();
    }
  });

  test("auto falls back to legacy when server does not support discover", async () => {
    const fixture = await createLoopbackFixture({ mode: "legacy" });
    try {
      const result = await createMcpConnection(serverConfig(fixture.url, "auto"));
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.connection.info.era).toBe("legacy");
      // Auto probes with server/discover first, then falls back to initialize
      expect(fixture.observations.some((o) => o.method === "server/discover")).toBe(true);
      expect(fixture.observations.some((o) => o.method === "initialize")).toBe(true);
      await result.connection.close();
    } finally {
      await fixture.close();
    }
  });
});

// ─── Wave 5: Mixed Registry ───────────────────────────────────────────────

describe("MCP mixed registry", () => {
  test("one registry holds legacy and modern servers with independent state", async () => {
    const legacy = await createLoopbackFixture({ mode: "legacy", toolName: "legacy_tool" });
    const modern = await createLoopbackFixture({ mode: "modern", toolName: "modern_tool" });
    try {
      const configDir = join(tmpdir(), `prism-vesicle-mixed-${crypto.randomUUID()}`);
      await mkdir(configDir, { recursive: true });
      await writeFile(join(configDir, "mcp.yaml"), [
        "enabled: true",
        "servers:",
        "  old:",
        "    url: " + legacy.url,
        "  new:",
        "    negotiation: modern",
        "    supportedProtocolVersions: [\"2026-07-28\"]",
        "    url: " + modern.url,
        "",
      ].join("\n"), "utf8");

      const env = { VESICLE_PROVIDERS_FILE: join(configDir, "providers.yaml") };
      const registry = await createMcpRegistryForEngine("etl", { env });

      // Both servers' tools appear
      expect(registry.definitions.map((d) => d.function.name).sort()).toEqual(["mcp_new_modern_tool", "mcp_old_legacy_tool"]);

      // Statuses reflect era
      const oldStatus = registry.statuses.find((s) => s.id === "old");
      const newStatus = registry.statuses.find((s) => s.id === "new");
      expect(oldStatus?.era).toBe("legacy");
      expect(oldStatus?.connected).toBe(true);
      expect(newStatus?.era).toBe("modern");
      expect(newStatus?.connected).toBe(true);

      // Same-turn calls to both servers
      const legacyResult = await registry.execute(
        { id: "call-1", name: "mcp_old_legacy_tool", arguments: "{}" },
        { rootDir: configDir, visionEnabled: false },
      );
      expect(legacyResult.ok).toBe(true);
      expect(legacyResult.content).toContain("legacy result from legacy_tool");

      const modernResult = await registry.execute(
        { id: "call-2", name: "mcp_new_modern_tool", arguments: "{}" },
        { rootDir: configDir, visionEnabled: false },
      );
      expect(modernResult.ok).toBe(true);
      expect(modernResult.content).toContain("modern result from modern_tool");

      // Each server executed exactly one tool call
      expect(legacy.counts.toolCalls).toBe(1);
      expect(modern.counts.toolCalls).toBe(1);

      // Era/SDK types don't leak into provider-visible content
      expect(JSON.stringify(legacyResult)).not.toContain("@modelcontextprotocol");
      expect(JSON.stringify(modernResult)).not.toContain("@modelcontextprotocol");
    } finally {
      await legacy.close();
      await modern.close();
    }
  });

  test("one server failure does not remove another server's tools", async () => {
    const working = await createLoopbackFixture({ mode: "legacy", toolName: "working_tool" });
    try {
      const configDir = join(tmpdir(), `prism-vesicle-partial-${crypto.randomUUID()}`);
      await mkdir(configDir, { recursive: true });
      await writeFile(join(configDir, "mcp.yaml"), [
        "enabled: true",
        "servers:",
        "  working:",
        "    url: " + working.url,
        "  broken:",
        "    url: http://127.0.0.1:1/mcp",
        "",
      ].join("\n"), "utf8");

      const env = { VESICLE_PROVIDERS_FILE: join(configDir, "providers.yaml") };
      const registry = await createMcpRegistryForEngine("etl", { env });

      // Working server keeps its tools despite broken server failure
      expect(registry.definitions.map((d) => d.function.name)).toEqual(["mcp_working_working_tool"]);

      const brokenStatus = registry.statuses.find((s) => s.id === "broken");
      expect(brokenStatus?.connected).toBe(false);
      expect(brokenStatus?.failureKind).toBeDefined();

      const workingStatus = registry.statuses.find((s) => s.id === "working");
      expect(workingStatus?.connected).toBe(true);
    } finally {
      await working.close();
    }
  });
});

// ─── Forbidden fallback and stale-session fault tests ──────────────────────

describe("MCP auto negotiation forbidden fallbacks", () => {
  test("auth failure (401) during auto does not fall back to legacy", async () => {
    const result = await createMcpConnection({
      ...serverConfig("https://mcp.example.test/auth/mcp", "auto"),
      id: "auth-fail",
    }, {
      fetchImpl: (() => Promise.resolve(new Response("Unauthorized", { status: 401 }))) as unknown as typeof fetch,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failureKind).toBe("auth");
    }
  });

  test("server error (5xx) during auto does not fall back to legacy", async () => {
    const result = await createMcpConnection({
      ...serverConfig("https://mcp.example.test/err/mcp", "auto"),
      id: "server-err",
    }, {
      fetchImpl: (() => Promise.resolve(new Response("Internal Server Error", { status: 503 }))) as unknown as typeof fetch,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failureKind).not.toBe("legacy-handshake");
    }
  });

  test("network/connection failure during auto does not fall back to legacy", async () => {
    const result = await createMcpConnection({
      ...serverConfig("http://127.0.0.1:1/unreachable/mcp", "auto"),
      id: "net-fail",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failureKind).not.toBe("legacy-handshake");
    }
  });
});

describe("MCP stale-session no-replay", () => {
  test("connection-level error during tools/call does not replay the call", async () => {
    let toolCallCount = 0;
    const result = await createMcpConnection({
      ...serverConfig("https://mcp.example.test/stale/mcp", "legacy"),
      id: "stale-test",
    }, {
      fetchImpl: (async (_url: RequestInfo | URL, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        const method = body.method as string;
        if (method === "initialize") {
          return Response.json({ jsonrpc: "2.0", id: body.id, result: {
            protocolVersion: "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "stale", version: "1.0" },
          }}, { headers: { "Mcp-Session-Id": "session-1" } });
        }
        if (method === "notifications/initialized") return new Response("", { status: 202 });
        if (method === "tools/list") {
          return Response.json({ jsonrpc: "2.0", id: body.id, result: {
            tools: [{ name: "write", inputSchema: { type: "object" } }],
          }});
        }
        if (method === "tools/call") {
          toolCallCount += 1;
          return new Response("Not Found", { status: 404 });
        }
        throw new Error(`unexpected: ${method}`);
      }) as typeof fetch,
    });

    if (!result.ok) throw new Error("connection failed");
    await expect(result.connection.callTool("write", {})).rejects.toThrow();
    // The key assertion: exactly one tool call reached the server (no replay).
    expect(toolCallCount).toBe(1);
    await result.connection.close();
  });
});
