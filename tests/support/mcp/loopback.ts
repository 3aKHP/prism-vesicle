import { createServer, type Server, type ServerResponse } from "node:http";
import { type AddressInfo } from "node:net";

/**
 * Sanitized structured observation of a single HTTP request received by a
 * loopback MCP fixture. Records wire shape for protocol assertions without
 * retaining auth values or raw payloads.
 */
export type RequestObservation = {
  ordinal: number;
  method: string;
  jsonRpcId: unknown;
  hasSessionId: boolean;
  hasProtocolVersionHeader: boolean;
  protocolVersionHeader?: string;
  hasMethodHeader: boolean;
  methodHeader?: string;
  hasNameHeader: boolean;
  nameHeader?: string;
  paramKeys: string[];
  hasMetaEnvelope: boolean;
};

export type FixtureCounts = {
  requests: number;
  toolCalls: number;
};

export type LoopbackFixtureOptions = {
  mode: "legacy" | "modern";
  toolName?: string;
};

export type LoopbackFixture = {
  server: Server;
  url: string;
  observations: RequestObservation[];
  counts: FixtureCounts;
  close: () => Promise<void>;
};

/**
 * Create a deterministic loopback MCP server for protocol testing. The server
 * records sanitized wire observations and supports both legacy and modern
 * protocol eras. Each fixture is independent: separate origins, separate
 * counters, separate lifecycle.
 */
export async function createLoopbackFixture(options: LoopbackFixtureOptions): Promise<LoopbackFixture> {
  const observations: RequestObservation[] = [];
  const counts: FixtureCounts = { requests: 0, toolCalls: 0 };
  const toolName = options.toolName ?? "ping";
  const mode = options.mode;
  let sessionId: string | undefined;

  const server = createServer((req, res) => {
    if (req.method === "GET") {
      res.writeHead(405);
      res.end();
      return;
    }
    let body = "";
    req.on("data", (chunk: Buffer) => (body += chunk.toString()));
    req.on("end", () => {
      counts.requests += 1;
      if (!body.trim()) {
        res.writeHead(400);
        res.end();
        return;
      }
      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(body) as Record<string, unknown>;
      } catch {
        res.writeHead(400);
        res.end();
        return;
      }
      const method = String(parsed.method ?? "");
      const params = isRecord(parsed.params) ? parsed.params : {};
      const meta = (params as Record<string, unknown>)._meta;
      const pv = req.headers["mcp-protocol-version"] as string | undefined;
      const mh = req.headers["mcp-method"] as string | undefined;
      const nh = req.headers["mcp-name"] as string | undefined;
      const sh = req.headers["mcp-session-id"] as string | undefined;

      observations.push({
        ordinal: observations.length + 1,
        method,
        jsonRpcId: parsed.id,
        hasSessionId: sh !== undefined,
        hasProtocolVersionHeader: pv !== undefined,
        ...(pv ? { protocolVersionHeader: pv } : {}),
        hasMethodHeader: mh !== undefined,
        ...(mh ? { methodHeader: mh } : {}),
        hasNameHeader: nh !== undefined,
        ...(nh ? { nameHeader: nh } : {}),
        paramKeys: Object.keys(params),
        hasMetaEnvelope: isRecord(meta),
      });

      if (mode === "legacy" && method === "initialize") {
        sessionId = `session-${Date.now()}`;
        respondJson(res, parsed.id, {
          protocolVersion: "2025-03-26",
          capabilities: { tools: {} },
          serverInfo: { name: "legacy-fixture", version: "1.0.0" },
        }, { "Mcp-Session-Id": sessionId });
        return;
      }
      if (mode === "legacy" && method === "notifications/initialized") {
        res.writeHead(202);
        res.end();
        return;
      }
      if (mode === "modern" && method === "server/discover") {
        respondJson(res, parsed.id, {
          supportedVersions: ["2026-07-28"],
          capabilities: { tools: {} },
          ttlMs: 0,
          cacheScope: "private",
        });
        return;
      }
      if (mode === "modern" && method === "initialize") {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ jsonrpc: "2.0", id: parsed.id, error: { code: -32601, message: "Method not found" } }));
        return;
      }
      if (mode === "modern" && method === "notifications/initialized") {
        res.writeHead(400);
        res.end();
        return;
      }
      if (method === "tools/list") {
        respondJson(res, parsed.id, {
          ...(mode === "modern" ? { resultType: "complete", ttlMs: 0, cacheScope: "private" } : {}),
          tools: [{ name: toolName, description: "Test tool", inputSchema: { type: "object" } }],
        });
        return;
      }
      if (method === "tools/call") {
        counts.toolCalls += 1;
        respondJson(res, parsed.id, {
          ...(mode === "modern" ? { resultType: "complete", ttlMs: 0, cacheScope: "private" } : {}),
          content: [{ type: "text", text: `${mode} result from ${toolName}` }],
        });
        return;
      }
      respondJson(res, parsed.id, {}, undefined, { code: -32601, message: "Method not found" });
    });
  });

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address() as AddressInfo;
      resolve({
        server,
        url: `http://127.0.0.1:${addr.port}/mcp`,
        observations,
        counts,
        close: () => new Promise<void>((r) => server.close(() => r())),
      });
    });
  });
}

function respondJson(
  res: ServerResponse,
  id: unknown,
  result: Record<string, unknown>,
  extraHeaders?: Record<string, string>,
  error?: { code: number; message: string },
): void {
  const headers: Record<string, string> = { "Content-Type": "application/json", ...(extraHeaders ?? {}) };
  res.writeHead(200, headers);
  if (error) {
    res.end(JSON.stringify({ jsonrpc: "2.0", id, error }));
  } else {
    res.end(JSON.stringify({ jsonrpc: "2.0", id, result }));
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
