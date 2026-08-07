import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { McpStreamableHttpClient, parseSseEnvelopes } from "../../../src/mcp/client";
import { parseMcpConfig } from "../../../src/mcp/config";
import { createMcpRegistryForEngine } from "../../../src/mcp/registry";
import { inspectMcpConfig } from "../../../src/mcp/registry";
import { buildMcpToolAlias, normalizeMcpToolResult } from "../../../src/mcp/types";

describe("MCP config", () => {
  test("defaults an existing mcp.yaml to enabled with minimal server fields", () => {
    const config = parseMcpConfig(
      [
        "servers:",
        "  local_math:",
        "    url: http://127.0.0.1:5100/mcp",
        "",
      ].join("\n"),
      "/tmp/mcp.yaml",
      {},
    );

    expect(config.enabled).toBe(true);
    expect(config.servers[0]).toMatchObject({
      id: "local_math",
      enabled: true,
      transport: "streamable-http",
      url: "http://127.0.0.1:5100/mcp",
      headers: {},
      timeoutSeconds: 30,
      protocolVersion: "2025-03-26",
      includeTools: [],
      excludeTools: [],
      enabledEngines: [],
    });
  });

  test("parses Streamable HTTP servers with env expansion and filters", () => {
    const config = parseMcpConfig(
      [
        "enabled: true",
        "servers:",
        "  prts:",
        "    enabled: true",
        "    transport: http",
        "    url: https://mcp.example.test/prts/mcp",
        "    timeoutSeconds: 12",
        "    toolPrefix: prts",
        "    headers:",
        "      Authorization: \"Bearer ${MCP_TOKEN}\"",
        "      X-Optional: \"${MISSING:-fallback}\"",
        "    includeTools:",
        "      - search_prts",
        "      - mcp_prts_page",
        "    excludeTools: [debug_dump]",
        "    enabledEngines: [etl, evaluate]",
        "",
      ].join("\n"),
      "/tmp/mcp.yaml",
      { MCP_TOKEN: "secret-token" },
    );

    expect(config.enabled).toBe(true);
    expect(config.servers[0]).toMatchObject({
      id: "prts",
      enabled: true,
      transport: "streamable-http",
      url: "https://mcp.example.test/prts/mcp",
      timeoutSeconds: 12,
      toolPrefix: "prts",
      includeTools: ["search_prts", "mcp_prts_page"],
      excludeTools: ["debug_dump"],
      enabledEngines: ["etl", "evaluate"],
    });
    expect(config.servers[0].headers).toEqual({
      Authorization: "Bearer secret-token",
      "X-Optional": "fallback",
    });
  });

  test("rejects missing env variables before exposing a server", () => {
    expect(() =>
      parseMcpConfig(
        [
          "enabled: true",
          "servers:",
          "  prts:",
          "    url: https://mcp.example.test/prts/mcp",
          "    headers:",
          "      Authorization: \"Bearer ${MCP_TOKEN}\"",
          "",
        ].join("\n"),
        "/tmp/mcp.yaml",
        {},
      ),
    ).toThrow("MCP_TOKEN");
  });
});

describe("MCP negotiation config", () => {
  test("absent negotiation defaults to legacy and supportedProtocolVersions defaults to the modern list", () => {
    const config = parseMcpConfig(
      ["servers:", "  old:", "    url: http://127.0.0.1:5100/mcp", ""].join("\n"),
      "/tmp/mcp.yaml",
      {},
    );
    expect(config.servers[0].negotiation).toBe("legacy");
    expect(config.servers[0].supportedProtocolVersions).toEqual(["2026-07-28"]);
  });

  test("explicit legacy negotiation is identical to absent", () => {
    const config = parseMcpConfig(
      [
        "servers:",
        "  old:",
        "    url: http://127.0.0.1:5100/mcp",
        "    negotiation: legacy",
        "",
      ].join("\n"),
      "/tmp/mcp.yaml",
      {},
    );
    expect(config.servers[0].negotiation).toBe("legacy");
  });

  test("parses auto and modern negotiation with supportedProtocolVersions", () => {
    const config = parseMcpConfig(
      [
        "servers:",
        "  flex:",
        "    url: http://127.0.0.1:5100/mcp",
        "    negotiation: auto",
        "    supportedProtocolVersions:",
        "      - \"2026-07-28\"",
        "  strict:",
        "    url: http://127.0.0.1:5101/mcp",
        "    negotiation: modern",
        "    supportedProtocolVersions: [\"2026-07-28\"]",
        "",
      ].join("\n"),
      "/tmp/mcp.yaml",
      {},
    );
    expect(config.servers[0]).toMatchObject({ id: "flex", negotiation: "auto", supportedProtocolVersions: ["2026-07-28"] });
    expect(config.servers[1]).toMatchObject({ id: "strict", negotiation: "modern", supportedProtocolVersions: ["2026-07-28"] });
  });

  test("accepts snake_case aliases for new fields", () => {
    const config = parseMcpConfig(
      [
        "servers:",
        "  srv:",
        "    url: http://127.0.0.1:5100/mcp",
        "    supported_protocol_versions:",
        "      - \"2026-07-28\"",
        "",
      ].join("\n"),
      "/tmp/mcp.yaml",
      {},
    );
    expect(config.servers[0].supportedProtocolVersions).toEqual(["2026-07-28"]);
  });

  test("de-duplicates supportedProtocolVersions and preserves declared order", () => {
    const config = parseMcpConfig(
      [
        "servers:",
        "  srv:",
        "    url: http://127.0.0.1:5100/mcp",
        "    supportedProtocolVersions: [\"2026-07-28\", \"2026-07-28\"]",
        "",
      ].join("\n"),
      "/tmp/mcp.yaml",
      {},
    );
    expect(config.servers[0].supportedProtocolVersions).toEqual(["2026-07-28"]);
  });

  test("rejects an invalid negotiation value", () => {
    expect(() =>
      parseMcpConfig(
        ["servers:", "  bad:", "    url: http://127.0.0.1:5100/mcp", "    negotiation: speedy", ""].join("\n"),
        "/tmp/mcp.yaml",
        {},
      ),
    ).toThrow("legacy, modern, or auto");
  });

  test("rejects a malformed protocol revision date", () => {
    expect(() =>
      parseMcpConfig(
        [
          "servers:",
          "  bad:",
          "    url: http://127.0.0.1:5100/mcp",
          "    supportedProtocolVersions: [\"not-a-date\"]",
          "",
        ].join("\n"),
        "/tmp/mcp.yaml",
        {},
      ),
    ).toThrow("YYYY-MM-DD");
  });

  test("rejects supportedProtocolVersions with no Vesicle-supported modern revision", () => {
    expect(() =>
      parseMcpConfig(
        [
          "servers:",
          "  bad:",
          "    url: http://127.0.0.1:5100/mcp",
          "    supportedProtocolVersions: [\"2099-01-01\"]",
          "",
        ].join("\n"),
        "/tmp/mcp.yaml",
        {},
      ),
    ).toThrow("no Vesicle-supported modern revision");
  });

  test("rejects an explicitly empty supportedProtocolVersions list", () => {
    expect(() =>
      parseMcpConfig(
        [
          "servers:",
          "  bad:",
          "    url: http://127.0.0.1:5100/mcp",
          "    supportedProtocolVersions: []",
          "",
        ].join("\n"),
        "/tmp/mcp.yaml",
        {},
      ),
    ).toThrow("empty supportedProtocolVersions");
  });

  test("rejects negotiation: modern with no usable modern versions after filtering", () => {
    expect(() =>
      parseMcpConfig(
        [
          "servers:",
          "  bad:",
          "    url: http://127.0.0.1:5100/mcp",
          "    negotiation: modern",
          "    supportedProtocolVersions: [\"2099-01-01\"]",
          "",
        ].join("\n"),
        "/tmp/mcp.yaml",
        {},
      ),
    ).toThrow("no Vesicle-supported modern revision");
  });
});

describe("MCP alias helpers", () => {
  test("sanitizes aliases and caps long names", () => {
    expect(buildMcpToolAlias("prts wiki", "search/prts", "prts")).toBe("mcp_prts_search_prts");
    const alias = buildMcpToolAlias("server", "x".repeat(100), "very-long-prefix");
    expect(alias.length).toBeLessThanOrEqual(64);
    expect(alias).toMatch(/_[a-f0-9]{8}$/);
  });

  test("normalizes ordered content kinds without retaining deferred payload bodies", () => {
    const normalized = normalizeMcpToolResult({
      content: [
        { type: "text", text: " first " },
        { type: "image", data: "aW1hZ2U=", mimeType: "image/png", filename: "remote.png" },
        { type: "text", text: "second" },
        { type: "audio", data: "c2VjcmV0", mimeType: "audio/wav" },
        { type: "resource", resource: { uri: "file:///private/path", mimeType: "text/plain", text: "secret body" } },
        { type: "resource_link", uri: "https://user:pass@example.test/private?token=secret", name: "private" },
        { type: "future_binary", data: "must-not-survive" },
      ],
      structuredContent: { count: 2 },
    });

    expect(normalized.text).toEqual(["first", "second"]);
    expect(normalized.structuredContent).toEqual({ count: 2 });
    expect(normalized.images).toEqual([{
      kind: "image",
      contentIndex: 1,
      data: "aW1hZ2U=",
      mimeType: "image/png",
    }]);
    expect(normalized.deferred).toEqual([
      { kind: "audio", contentIndex: 3, mimeType: "audio/wav" },
      { kind: "resource", contentIndex: 4, mimeType: "text/plain", scheme: "file", hasText: true, hasBlob: false },
      { kind: "link", contentIndex: 5, scheme: "https" },
    ]);
    expect(normalized.diagnostics).toEqual([{
      contentIndex: 6,
      code: "unknown-content-type",
      declaredType: "future_binary",
    }]);
    expect(JSON.stringify(normalized.deferred)).not.toContain("secret");
    expect(JSON.stringify(normalized.diagnostics)).not.toContain("must-not-survive");
  });

  test("diagnoses malformed result envelopes without misclassifying empty text or resources", () => {
    const normalized = normalizeMcpToolResult({
      content: [
        { type: "text", text: "  " },
        { type: "resource", resource: "private body" },
      ],
    });

    expect(normalized.text).toEqual([]);
    expect(normalized.deferred).toEqual([]);
    expect(normalized.diagnostics).toEqual([{
      contentIndex: 1,
      code: "invalid-content-item",
      declaredType: "resource",
    }]);
    expect(normalizeMcpToolResult({ content: "private body" }).diagnostics).toEqual([{
      code: "invalid-response",
    }]);
  });
});

describe("Streamable HTTP MCP client", () => {
  test("parses inline SSE JSON-RPC envelopes", () => {
    expect(parseSseEnvelopes([
      "event: message",
      "data: {\"jsonrpc\":\"2.0\",\"id\":1,\"result\":{\"ok\":true}}",
      "",
      ": keepalive",
      "",
    ].join("\n"))).toEqual([
      { jsonrpc: "2.0", id: 1, result: { ok: true } },
    ]);
  });

  test("initializes, lists paginated tools, reuses session id, and calls a tool", async () => {
    const requests: Array<{ body: Record<string, unknown>; session?: string }> = [];
    const client = new McpStreamableHttpClient({
      id: "fetch",
      enabled: true,
      transport: "streamable-http",
      url: "https://mcp.example.test/fetch/mcp",
      headers: { Authorization: "Bearer test" },
      timeoutSeconds: 5,
      protocolVersion: "2025-03-26",
      negotiation: "legacy",
      supportedProtocolVersions: [],
      includeTools: [],
      excludeTools: [],
      enabledEngines: [],
    }, {
      fetchImpl: (async (_url, init) => {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        const headers = new Headers(init?.headers);
        requests.push({ body, session: headers.get("MCP-Session-Id") ?? undefined });
        if (body.method === "initialize") {
          return Response.json({
            jsonrpc: "2.0",
            id: body.id,
            result: { serverInfo: { name: "mcp-fetch", version: "2.0.0" } },
          }, { headers: { "MCP-Session-Id": "session-1" } });
        }
        if (body.method === "notifications/initialized") return new Response("", { status: 202 });
        if (body.method === "tools/list") {
          const params = body.params as Record<string, unknown>;
          return Response.json({
            jsonrpc: "2.0",
            id: body.id,
            result: params.cursor
              ? { tools: [{ name: "fetch_url", inputSchema: { type: "object", properties: { url: { type: "string" } } } }] }
              : { tools: [{ name: "map_url" }], nextCursor: "next" },
          });
        }
        if (body.method === "tools/call") {
          return new Response([
            "event: message",
            `data: ${JSON.stringify({ jsonrpc: "2.0", id: body.id, result: { content: [{ type: "text", text: "fetched page" }] } })}`,
            "",
          ].join("\n"), { headers: { "content-type": "text/event-stream" } });
        }
        throw new Error(`unexpected method ${String(body.method)}`);
      }) as typeof fetch,
    });

    await client.initialize();
    expect(client.serverInfo).toEqual({ name: "mcp-fetch", version: "2.0.0" });
    expect(await client.listTools()).toEqual([
      { name: "map_url" },
      { name: "fetch_url", inputSchema: { type: "object", properties: { url: { type: "string" } } } },
    ]);
    expect(await client.callTool("fetch_url", { url: "https://example.test" })).toEqual({
      text: ["fetched page"],
      images: [],
      deferred: [],
      diagnostics: [],
      isError: false,
    });
    expect(requests.map((request) => request.session)).toEqual([
      undefined,
      "session-1",
      "session-1",
      "session-1",
      "session-1",
    ]);
  });

  test("aborts an in-flight tool call with the turn cancellation signal", async () => {
    const controller = new AbortController();
    const client = new McpStreamableHttpClient({
      id: "slow",
      enabled: true,
      transport: "streamable-http",
      url: "https://mcp.example.test/slow/mcp",
      headers: {},
      timeoutSeconds: 30,
      protocolVersion: "2025-03-26",
      negotiation: "legacy",
      supportedProtocolVersions: [],
      includeTools: [],
      excludeTools: [],
      enabledEngines: [],
    }, {
      fetchImpl: ((_url, init) => new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
      })) as typeof fetch,
    });

    const running = client.callTool("wait", {}, { signal: controller.signal });
    controller.abort(new DOMException("user cancelled", "AbortError"));

    await expect(running).rejects.toMatchObject({ name: "AbortError" });
  });
});

describe("MCP registry", () => {
  test("filters tools by engine and include/exclude rules, then executes aliases", async () => {
    const configDir = await makeConfigDir("mcp-registry");
    await writeFile(join(configDir, ".env"), "MCP_TOKEN=secret\n", "utf8");
    await writeFile(join(configDir, "mcp.yaml"), [
      "enabled: true",
      "servers:",
      "  math:",
      "    enabled: true",
      "    transport: http",
      "    url: https://mcp.example.test/math/mcp",
      "    toolPrefix: math",
      "    headers:",
      "      Authorization: \"Bearer ${MCP_TOKEN}\"",
      "    includeTools:",
      "      - add",
      "      - mcp_math_echo",
      "    excludeTools:",
      "      - echo",
      "    enabledEngines:",
      "      - etl",
      "",
    ].join("\n"), "utf8");

    const fetchImpl = (async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      if (body.method === "initialize") {
        return Response.json({ jsonrpc: "2.0", id: body.id, result: { serverInfo: { name: "math", version: "1.0" } } });
      }
      if (body.method === "notifications/initialized") return new Response("", { status: 202 });
      if (body.method === "tools/list") {
        return Response.json({
          jsonrpc: "2.0",
          id: body.id,
          result: {
            tools: [
              { name: "add", description: "Add numbers", inputSchema: { type: "object", properties: { a: { type: "number" } } } },
              { name: "echo", description: "Echo text" },
              { name: "subtract", description: "Subtract numbers" },
            ],
          },
        });
      }
      if (body.method === "tools/call") {
        return Response.json({ jsonrpc: "2.0", id: body.id, result: { structuredContent: { sum: 3 } } });
      }
      throw new Error(`unexpected method ${String(body.method)}`);
    }) as typeof fetch;

    const env = { VESICLE_PROVIDERS_FILE: join(configDir, "providers.yaml") };
    const etl = await createMcpRegistryForEngine("etl", { env, fetchImpl });
    const runtime = await createMcpRegistryForEngine("runtime", { env, fetchImpl });

    expect(etl.definitions.map((tool) => tool.function.name)).toEqual(["mcp_math_add"]);
    expect(etl.definitions[0].function.description).toBe("[MCP/math] Add numbers");
    expect(runtime.definitions).toEqual([]);

    const result = await etl.execute(
      { id: "call-1", name: "mcp_math_add", arguments: "{\"a\":1,\"b\":2}" },
      { rootDir: configDir, visionEnabled: false },
    );
    expect(result).toMatchObject({
      callId: "call-1",
      name: "mcp_math_add",
      ok: true,
      content: "MCP tool returned structured content.",
      mcpEvent: {
        kind: "mcp_tool",
        serverId: "math",
        alias: "mcp_math_add",
        toolName: "add",
        isError: false,
        hasStructuredContent: true,
      },
    });
  });

  test("does not expose MCP tools when config has missing secret placeholders", async () => {
    const configDir = await makeConfigDir("mcp-missing-secret");
    await writeFile(join(configDir, "mcp.yaml"), [
      "enabled: true",
      "servers:",
      "  prts:",
      "    url: https://mcp.example.test/prts/mcp",
      "    headers:",
      "      Authorization: \"Bearer ${MCP_TOKEN}\"",
      "",
    ].join("\n"), "utf8");

    const env = { VESICLE_PROVIDERS_FILE: join(configDir, "providers.yaml") };
    const registry = await createMcpRegistryForEngine("etl", { env });
    const inspection = await inspectMcpConfig({ env });

    expect(registry.definitions).toEqual([]);
    expect(inspection.statuses[0].id).toBe("config");
    expect(inspection.statuses[0].error).toContain("MCP_TOKEN");
  });
});

async function makeConfigDir(prefix: string): Promise<string> {
  const dir = join(tmpdir(), `prism-vesicle-${prefix}-${crypto.randomUUID()}`);
  await mkdir(dir, { recursive: true });
  return dir;
}
