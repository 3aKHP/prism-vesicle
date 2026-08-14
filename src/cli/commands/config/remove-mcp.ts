// vesicle config remove-mcp — remove one MCP server from mcp.yaml.
// Non-last servers are removed by a line-preserving block edit. Removing the
// last server deletes mcp.yaml entirely (the same semantic as "MCP not
// configured") and leaves the sibling .env slots untouched.

import { loadUserConfigEnvironment } from "../../../config/providers";
import { atomicWrite, safeUnlink } from "../../../config/atomic-write";
import { readOptionalText } from "../../../config/file-read";
import { parseMcpConfig, mcpConfigPathFromEnv } from "../../../mcp/config";
import { removeMcpServerBlock } from "../../../mcp/config-edit";

type RemoveMcpResult = {
  ok: true;
  operation: "remove-mcp";
  serverId: string;
  path: string;
  envPath: string;
  removedFile: boolean;
  summary: string;
  restartRequired: boolean;
};

export async function runRemoveMcp(args: string[]): Promise<void> {
  if (args.length !== 1) {
    console.error("Usage: vesicle config remove-mcp <server-id>");
    process.exitCode = 1;
    return;
  }
  try {
    const result = await removeMcp(args[0]!);
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

async function removeMcp(serverId: string): Promise<RemoveMcpResult> {
  const path = mcpConfigPathFromEnv();
  const source = await readOptionalText(path);
  if (source === undefined) {
    throw new Error(`MCP config not found at ${path}. Nothing to remove.`);
  }

  const userEnv = await loadUserConfigEnvironment();
  const parsed = parseMcpConfig(source, path, userEnv.effectiveEnv);
  const server = parsed.servers.find((entry) => entry.id === serverId);
  if (!server) {
    throw new Error(
      `Unknown MCP server "${serverId}". Available: ${parsed.servers.map((entry) => entry.id).join(", ")}.`,
    );
  }

  if (parsed.servers.length === 1) {
    await safeUnlink(path);
    return {
      ok: true,
      operation: "remove-mcp",
      serverId,
      path,
      envPath: userEnv.path,
      removedFile: true,
      summary: `MCP server "${serverId}" was the only configured server, so ${path} was deleted. `
        + `Any token slots in ${userEnv.path} were left untouched. Restart Vesicle to apply.`,
      restartRequired: true,
    };
  }

  const nextSource = removeMcpServerBlock(source, serverId);
  parseMcpConfig(nextSource, path, userEnv.effectiveEnv);
  await atomicWrite(path, nextSource);
  return {
    ok: true,
    operation: "remove-mcp",
    serverId,
    path,
    envPath: userEnv.path,
    removedFile: false,
    summary: `MCP server "${serverId}" removed. Token slots in ${userEnv.path} were left untouched. Restart Vesicle to apply.`,
    restartRequired: true,
  };
}
