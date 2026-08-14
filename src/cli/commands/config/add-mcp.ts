// vesicle config add-mcp — append an MCP server via JSON entry.
// The entry never contains secret values: bearer/custom-header auth produces
// an `${ENV}` reference in mcp.yaml and an empty slot in the sibling .env.
// Existing mcp.yaml lines are preserved; only the new server block is appended.

import { loadUserConfigEnvironment, parseEnvFile } from "../../../config/providers";
import { setEnvValues } from "../../../setup/config-writer";
import { atomicWrite } from "../../../config/atomic-write";
import { readOptionalText as readOptional } from "../../../config/file-read";
import { parseMcpConfig, mcpConfigPathFromEnv } from "../../../mcp/config";
import { appendMcpServerBlock, serializeMcpServerBlock } from "../../../mcp/config-edit";
import { materializeMcpServerBlock, parseAddMcpServerEntry } from "../../../mcp/config-entry";

type AddMcpResult = {
  ok: true;
  operation: "add-mcp";
  serverId: string;
  path: string;
  envPath: string;
  envKeys: string[];
  createdEnvKeys: string[];
  summary: string;
  restartRequired: boolean;
};

export async function runAddMcp(args: string[]): Promise<void> {
  if (args.length !== 2 || args[0] !== "--json") {
    console.error("Usage: vesicle config add-mcp --json '<entry>'");
    process.exitCode = 1;
    return;
  }
  let input: unknown;
  try {
    input = JSON.parse(args[1]!);
  } catch {
    console.error("Invalid JSON. Provide a valid JSON object as the --json argument.");
    process.exitCode = 1;
    return;
  }

  try {
    const result = await addMcp(input);
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

async function addMcp(input: unknown): Promise<AddMcpResult> {
  const entry = parseAddMcpServerEntry(input);
  const path = mcpConfigPathFromEnv();
  const existingSource = await readOptional(path);
  const userEnv = await loadUserConfigEnvironment();
  const envPath = userEnv.path;

  // Validate the existing file before editing. A missing `${ENV}` referenced
  // by an existing server is a pre-existing broken state: refuse rather than
  // silently papering over it with empty slots.
  const usedIds = new Set<string>();
  if (existingSource !== undefined) {
    const parsed = parseMcpConfig(existingSource, path, userEnv.effectiveEnv);
    for (const server of parsed.servers) usedIds.add(server.id);
  }

  const { block, envKeys } = materializeMcpServerBlock(entry, usedIds);
  const nextSource = appendMcpServerBlock(existingSource, serializeMcpServerBlock(block));

  const existingEnv = await readOptional(envPath);
  const envUpdates: Record<string, string> = {};
  for (const key of envKeys) {
    if (userEnv.effectiveEnv[key] === undefined) envUpdates[key] = "";
  }
  const nextEnv = setEnvValues(existingEnv ?? "", envUpdates);

  // Re-parse the exact bytes that would be written, with the exact effective
  // environment that will exist after the .env update. Any schema violation
  // throws before a single byte lands on disk.
  parseMcpConfig(
    nextSource,
    path,
    { ...process.env, ...parseEnvFile(nextEnv, envPath) },
  );

  if (Object.keys(envUpdates).length > 0) {
    await atomicWrite(envPath, nextEnv, 0o600);
  }
  await atomicWrite(path, nextSource);

  const createdEnvKeys = Object.keys(envUpdates);
  const summary = createdEnvKeys.length > 0
    ? `MCP server "${block.id}" added with ${createdEnvKeys.length} env slot(s) created in .env. `
      + `Edit ${envPath} and paste the token value(s) after "=", then restart Vesicle.`
    : `MCP server "${block.id}" added. Restart Vesicle to use it.`;

  return {
    ok: true,
    operation: "add-mcp",
    serverId: block.id,
    path,
    envPath,
    envKeys,
    createdEnvKeys,
    summary,
    restartRequired: true,
  };
}
