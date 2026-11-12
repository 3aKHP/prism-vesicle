import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, open, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { loadMcpConfig } from "../../src/mcp/config";
import { readLiveBudget, reserveLiveSession } from "./mcp-live-budget";
import { buildMcpProbe, executeMcpProbe } from "../smoke/migration/rust-mcp-command";

// Explicit, owner-authorized read-only acceptance. Never used by CI. Reuse the
// same evidence directory on retries; a reserved attempt is spent on failure.
async function main() {
  const [serverId, output, ...extra] = process.argv.slice(2);
  assert(serverId && output && !extra.length, "usage: rust-mcp-live.ts SERVER_ID EVIDENCE_DIRECTORY");
  const status = Bun.spawnSync(["git", "status", "--porcelain"]);
  assert.equal(status.exitCode, 0); assert.equal(status.stdout.toString().trim(), "", "commit the tested source first");
  const head = Bun.spawnSync(["git", "rev-parse", "HEAD"]);
  assert.equal(head.exitCode, 0); const sourceSha = head.stdout.toString().trim();
  const binary = await buildMcpProbe();
  const binarySha256 = createHash("sha256").update(await readFile(binary)).digest("hex");
  const config = await loadMcpConfig();
  assert(config.configured && config.config.enabled);
  const server = config.config.servers.find((server) => server.id === serverId && server.enabled);
  assert(server && server.transport === "streamable-http");
  assert(Object.entries(server.headers).some(([key, value]) => key.toLowerCase() === "authorization" && value));
  const directory = resolve(output); await mkdir(directory, { recursive: true });
  const lockPath = join(directory, "MCP_LIVE.lock");
  const lock = await open(lockPath, "wx");
  try {
    const budgetPath = join(directory, "MCP_LIVE_BUDGET.json");
    let budget = await readLiveBudget(budgetPath);
    assert(budget.sessionsStarted <= 2, "two session reservations required; no automatic budget reset");
    let failed = false;
    for (const era of ["legacy", "modern"]) {
      budget = await reserveLiveSession(budgetPath, budget);
      const startedAt = new Date().toISOString();
      // Credentials cross only this private stdin pipe, never argv or reports.
      const observed = await executeMcpProbe(binary, ["live", era], JSON.stringify({ url: server.url, headers: server.headers }));
      let result: unknown; let error: string | undefined;
      if (observed.exit === 0 && !observed.timedOut) {
        const candidate = JSON.parse(observed.stdout);
        assert(Number.isInteger(candidate.toolCount) && candidate.toolCount > 0);
        assert(/^\d{4}-\d{2}-\d{2}$/.test(candidate.protocolVersion));
        assert.equal(candidate.tool, "list_items"); assert.equal(candidate.isError, false);
        assert(Number.isInteger(candidate.contentBytes) && candidate.contentBytes > 0 && candidate.contentBytes <= 65536);
        assert(/^[a-f0-9]{64}$/.test(candidate.contentSha256));
        // Deliberately select fields; never retain arbitrary process output.
        result = { toolCount: candidate.toolCount, protocolVersion: candidate.protocolVersion, tool: "list_items", contentBytes: candidate.contentBytes, contentSha256: candidate.contentSha256, isError: false };
      } else {
        failed = true;
        try { const candidate = JSON.parse(observed.stderr).error; error = typeof candidate === "string" && /^probe\.[a-z_]+$/.test(candidate) ? candidate : "probe.process_failed"; }
        catch { error = "probe.process_failed"; }
      }
      const report = { schemaVersion: 1, sourceSha, binarySha256, serverId, endpointSha256: createHash("sha256").update(server.url).digest("hex"), authorizationPresent: true, era, attempt: budget.sessionsStarted, startedAt, endedAt: new Date().toISOString(), exitCode: observed.exit, timedOut: observed.timedOut, status: error ? "failed" : "passed", result, error };
      await writeFile(join(directory, `MCP-LIVE-${budget.sessionsStarted}-${era}.json`), `${JSON.stringify(report, null, 2)}\n`);
      console.log(JSON.stringify({ era, attempt: budget.sessionsStarted, status: report.status, error }));
    }
    if (failed) process.exitCode = 1;
  } finally { await lock.close(); await rm(lockPath); }
}

main().catch(() => { console.error("Live MCP setup or verification failed; inspect the bounded evidence and configuration without printing credentials."); process.exitCode = 1; });
