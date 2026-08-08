import { describe, expect, test } from "bun:test";
import { testMcpServer } from "../../../src/setup/mcp-test";

describe("guided Setup MCP connection test", () => {
  test("connects with auto negotiation, falls back to legacy, and reports discovered tools", async () => {
    const requests: Request[] = [];
    const result = await testMcpServer({
      name: "research",
      url: "https://mcp.example.com/mcp",
      auth: "bearer",
      secret: "mcp-secret",
      enabledEngines: ["etl"],
    }, {
      fetchImpl: Object.assign(async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = new Request(input, init);
        requests.push(request);
        const body = JSON.parse(await request.text()) as { id?: unknown; method: string };
        // Auto probe: server/discover returns method-not-found (triggers legacy fallback)
        if (body.method === "server/discover") {
          return Response.json({ jsonrpc: "2.0", id: body.id, error: { code: -32601, message: "Method not found" } });
        }
        if (body.method === "notifications/initialized") return new Response("", { status: 202 });
        const result = body.method === "initialize"
          ? { protocolVersion: "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "Test MCP", version: "1.0" } }
          : { tools: [{ name: "search", inputSchema: { type: "object" } }] };
        return Response.json({ jsonrpc: "2.0", id: body.id, result });
      }, { preconnect: () => undefined }) as typeof fetch,
    });
    expect(result.toolCount).toBe(1);
    expect(result.serverName).toBe("Test MCP");
    expect(result.era).toBe("legacy");
    expect(result.protocolVersion).toBe("2025-03-26");
    // Auth header present on every request
    expect(requests.every((r) => r.headers.get("authorization") === "Bearer mcp-secret")).toBe(true);
  });
});
