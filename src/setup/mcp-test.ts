import { McpStreamableHttpClient } from "../mcp/client";
import type { McpServerConfig } from "../mcp/types";
import type { SetupMcpServer } from "./config-writer";

export type McpTestResult = {
  toolCount: number;
  serverName?: string;
};

export async function testMcpServer(
  draft: SetupMcpServer,
  options: { fetchImpl?: typeof fetch } = {},
): Promise<McpTestResult> {
  const config: McpServerConfig = {
    id: "setup-test",
    enabled: true,
    transport: "streamable-http",
    url: draft.url.trim(),
    headers: authHeaders(draft),
    timeoutSeconds: 12,
    protocolVersion: "2025-03-26",
    includeTools: [],
    excludeTools: [],
    enabledEngines: draft.enabledEngines,
  };
  const client = new McpStreamableHttpClient(config, options);
  await client.initialize();
  const tools = await client.listTools();
  const serverName = typeof client.serverInfo.name === "string" ? client.serverInfo.name : undefined;
  return { toolCount: tools.length, ...(serverName ? { serverName } : {}) };
}

function authHeaders(draft: SetupMcpServer): Record<string, string> {
  if (draft.auth === "none") return {};
  if (draft.auth === "bearer") return { Authorization: `Bearer ${draft.secret ?? ""}` };
  return { [draft.headerName ?? "Authorization"]: draft.secret ?? "" };
}
