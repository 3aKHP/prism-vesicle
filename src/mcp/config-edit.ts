// Line-preserving editor for the deliberately constrained mcp.yaml subset.
// Only new server blocks are generated here; existing source lines are kept
// byte-for-byte so comments, ordering, and `${ENV}` references survive.

import { readYamlLines } from "../config/yaml-line-reader";
import { yamlKey, yamlScalar } from "../config/yaml-writer";
import type { EngineId } from "../core/engine/profile";
import type { McpNegotiationMode, McpTransport } from "./types";

export type McpServerBlock = {
  id: string;
  enabled: boolean;
  transport: McpTransport;
  url: string;
  timeoutSeconds?: number;
  protocolVersion?: string;
  toolPrefix?: string;
  negotiation?: McpNegotiationMode;
  supportedProtocolVersions?: string[];
  headers?: Record<string, string>;
  includeTools?: string[];
  excludeTools?: string[];
  enabledEngines?: EngineId[];
};

export function mcpTokenEnvKey(id: string): string {
  return `MCP_${id.replace(/[^A-Za-z0-9]+/g, "_").toUpperCase()}_TOKEN`;
}

export function collectEnvReferences(values: Iterable<string>): string[] {
  const keys = new Set<string>();
  for (const value of values) {
    for (const match of value.matchAll(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g)) {
      keys.add(match[1]!);
    }
  }
  return [...keys];
}

export function serializeMcpServerBlock(block: McpServerBlock): string[] {
  const lines = [
    `  ${yamlKey(block.id)}:`,
    `    enabled: ${block.enabled}`,
    `    transport: ${block.transport}`,
    `    url: ${yamlScalar(block.url)}`,
  ];
  if (block.timeoutSeconds !== undefined) lines.push(`    timeoutSeconds: ${block.timeoutSeconds}`);
  if (block.protocolVersion !== undefined) lines.push(`    protocolVersion: ${yamlScalar(block.protocolVersion)}`);
  if (block.toolPrefix !== undefined) lines.push(`    toolPrefix: ${yamlScalar(block.toolPrefix)}`);
  if (block.negotiation !== undefined) lines.push(`    negotiation: ${block.negotiation}`);
  if (block.supportedProtocolVersions !== undefined && block.supportedProtocolVersions.length > 0) {
    lines.push("    supportedProtocolVersions:");
    for (const version of block.supportedProtocolVersions) lines.push(`      - ${yamlScalar(version)}`);
  }
  if (block.headers && Object.keys(block.headers).length > 0) {
    lines.push("    headers:");
    for (const [name, value] of Object.entries(block.headers)) {
      lines.push(`      ${yamlKey(name)}: ${yamlScalar(value)}`);
    }
  }
  if (block.includeTools && block.includeTools.length > 0) {
    lines.push("    includeTools:");
    for (const tool of block.includeTools) lines.push(`      - ${yamlScalar(tool)}`);
  }
  if (block.excludeTools && block.excludeTools.length > 0) {
    lines.push("    excludeTools:");
    for (const tool of block.excludeTools) lines.push(`      - ${yamlScalar(tool)}`);
  }
  if (block.enabledEngines && block.enabledEngines.length > 0) {
    lines.push("    enabledEngines:");
    for (const engine of block.enabledEngines) lines.push(`      - ${engine}`);
  }
  return lines;
}

/**
 * Append a serialized server block to an mcp.yaml source. The existing source
 * is only normalized at the edges (line endings, trailing whitespace, the
 * global enabled: false gate, and the optional missing servers: section);
 * every other line is preserved exactly.
 */
export function appendMcpServerBlock(source: string | undefined, blockLines: string[]): string {
  let result = source === undefined ? "" : source.replace(/\r\n/g, "\n");
  result = result.replace(/\s*$/, "");
  if (!result) result = "enabled: true\n\nservers:";

  // Adding a server is an explicit enable action, matching Guided Setup.
  result = result.replace(/^enabled:\s*false(?:\s+#.*)?$/m, "enabled: true");

  if (!/^servers:\s*(?:#.*)?$/m.test(result)) result += "\n\nservers:";
  return `${result}\n${blockLines.join("\n")}\n`;
}

/**
 * Server ids already declared at indent 2 under the top-level servers:
 * section. This deliberately does not expand `${ENV}`, so add-mcp can inspect
 * a disabled example file before its referenced secrets exist.
 */
export function existingMcpServerIds(source: string | undefined): string[] {
  if (source === undefined) return [];
  let inServers = false;
  const ids: string[] = [];
  for (const line of readYamlLines(source)) {
    if (line.indent === 0) {
      inServers = line.text === "servers:";
      continue;
    }
    if (inServers && line.indent === 2 && line.text.endsWith(":")) {
      ids.push(line.text.slice(0, -1).trim());
    }
  }
  return ids;
}
