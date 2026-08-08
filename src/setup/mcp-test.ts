import { createMcpConnection } from "../mcp/connection";
import { isRecord, type McpServerConfig } from "../mcp/types";
import type { SetupMcpServer } from "./config-writer";

export type McpTestResult = {
  toolCount: number;
  serverName?: string;
  era?: string;
  protocolVersion?: string;
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
    negotiation: "auto",
    supportedProtocolVersions: ["2026-07-28"],
    includeTools: [],
    excludeTools: [],
    enabledEngines: draft.enabledEngines,
  };
  const result = await createMcpConnection(config, options);
  if (!result.ok) {
    throw new Error(result.error);
  }
  const connection = result.connection;
  try {
    const tools = await connection.listTools();
    const serverInfo = connection.info.serverInfo;
    const serverName = isRecord(serverInfo) && typeof serverInfo.name === "string" ? serverInfo.name : undefined;
    return {
      toolCount: tools.length,
      ...(serverName ? { serverName } : {}),
      era: connection.info.era,
      protocolVersion: connection.info.protocolVersion,
    };
  } finally {
    await connection.close();
  }
}

function authHeaders(draft: SetupMcpServer): Record<string, string> {
  if (draft.auth === "none") return {};
  if (draft.auth === "bearer") return { Authorization: `Bearer ${draft.secret ?? ""}` };
  return { [draft.headerName ?? "Authorization"]: draft.secret ?? "" };
}
