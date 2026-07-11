import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { McpStreamableHttpClient, parseSseEnvelopes } from "../src/mcp/client";
import { parseMcpConfig } from "../src/mcp/config";
import { createMcpRegistryForEngine } from "../src/mcp/registry";
import { inspectMcpConfig } from "../src/mcp/registry";
import { buildMcpToolAlias } from "../src/mcp/types";

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

describe("MCP alias helpers", () => {
  test("sanitizes aliases and caps long names", () => {
    expect(buildMcpToolAlias("prts wiki", "search/prts", "prts")).toBe("mcp_prts_search_prts");
    const alias = buildMcpToolAlias("server", "x".repeat(100), "very-long-prefix");
    expect(alias.length).toBeLessThanOrEqual(64);
    expect(alias).toMatch(/_[a-f0-9]{8}$/);
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
      content: "fetched page",
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

    const result = await etl.execute({ id: "call-1", name: "mcp_math_add", arguments: "{\"a\":1,\"b\":2}" });
    expect(result).toMatchObject({
      callId: "call-1",
      name: "mcp_math_add",
      ok: true,
      content: "{\"sum\":3}",
      mcpEvent: {
        kind: "mcp_tool",
        serverId: "math",
        alias: "mcp_math_add",
        toolName: "add",
        isError: false,
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
