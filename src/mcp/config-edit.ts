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
 * Remove one server block while preserving every other source line that is
 * not clearly inside that block. Semantic lines of the target block are
 * dropped; comment lines indented inside the block are dropped too, while
 * comment lines at the surrounding section indentation are kept (they may
 * document the next server).
 */
export function removeMcpServerBlock(source: string, id: string): string {
  const lineEnding = source.includes("\r\n") ? "\r\n" : "\n";
  const rawLines = source.replace(/\r\n/g, "\n").split("\n");
  const semanticLines = readYamlLines(source);
  const blockSemanticRows = new Set<number>();
  let inServers = false;
  let startRow = -1;
  let endRow = rawLines.length;
  let found = false;

  for (const line of semanticLines) {
    const row = line.number - 1;
    if (line.indent === 0) {
      if (found) {
        endRow = row;
        break;
      }
      inServers = line.text === "servers:";
      continue;
    }
    if (!inServers) continue;
    if (line.indent === 2) {
      if (line.text === `${id}:`) {
        found = true;
        startRow = row;
        blockSemanticRows.add(row);
        continue;
      }
      if (found) {
        endRow = row;
        break;
      }
      continue;
    }
    if (found) blockSemanticRows.add(row);
  }
  if (!found) {
    throw new Error(`MCP server "${id}" was not found in the source.`);
  }

  const output: string[] = [];
  for (let row = 0; row < rawLines.length; row++) {
    if (row >= startRow && row < endRow) {
      if (blockSemanticRows.has(row)) continue;
      const indent = rawLines[row]!.match(/^ */)?.[0].length ?? 0;
      if (indent >= 4) continue;
    }
    output.push(rawLines[row]!);
  }
  while (output.length > 0 && output[output.length - 1] === "") output.pop();
  return `${output.join(lineEnding)}\n`;
}
