import { describe, expect, test } from "bun:test";
import { testMcpServer } from "../../../src/setup/mcp-test";

describe("guided Setup MCP connection test", () => {
  test("initializes with the selected auth and reports discovered tools", async () => {
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
        const body = JSON.parse(await request.text()) as { id?: number; method: string };
        if (body.method === "notifications/initialized") return new Response(null, { status: 204 });
        const result = body.method === "initialize"
          ? { serverInfo: { name: "Test MCP" } }
          : { tools: [{ name: "search", inputSchema: { type: "object" } }] };
        return Response.json({ jsonrpc: "2.0", id: body.id, result });
      }, { preconnect: () => undefined }) as typeof fetch,
    });
    expect(result).toEqual({ toolCount: 1, serverName: "Test MCP" });
    expect(requests[0].headers.get("authorization")).toBe("Bearer mcp-secret");
  });
});
