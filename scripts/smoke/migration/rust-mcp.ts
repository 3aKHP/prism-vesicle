import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { RequestObservation } from "../../../tests/support/mcp/loopback";
import { buildMcpProbe, executeMcpProbe } from "./rust-mcp-command";

const binary = await buildMcpProbe();
const sandbox = await mkdtemp(join(tmpdir(), "vesicle-mcp-oracle-"));
const ready = join(sandbox, "ready.json");
const server = Bun.spawn(["node", "--experimental-strip-types", resolve(import.meta.dir, "rust-mcp-server.ts"), ready], { stdin: "pipe", stdout: "pipe", stderr: "inherit" });
const serverOutput = new Response(server.stdout).text();
try {
  const deadline = Date.now() + 10_000;
  while (!await Bun.file(ready).exists()) {
    assert(Date.now() < deadline && server.exitCode === null, "Node HTTP oracle did not start");
    await Bun.sleep(20);
  }
  const urls = await Bun.file(ready).json();
  const observed = await executeMcpProbe(binary, ["fixtures", urls.legacy, urls.modern]);
  assert.equal(observed.timedOut, false);
  assert.equal(observed.exit, 0, observed.stderr);
  assert.equal(observed.stderr, "");
  const result = JSON.parse(observed.stdout);

  const secret = "synthetic-do-not-log";
  const rejected = await executeMcpProbe(binary, ["live", "legacy"], JSON.stringify({ url: urls.legacy, headers: { Authorization: `Bearer ${secret}` } }));
  assert.equal(rejected.exit, 1); assert.equal(rejected.stdout, "");
  assert(!rejected.stderr.includes(secret)); assert(!rejected.stderr.includes(urls.legacy));
  let redirectedRequests = 0;
  const target = createServer((_request, response) => { redirectedRequests++; response.writeHead(500); response.end(); });
  await new Promise<void>((resolve) => target.listen(0, "127.0.0.1", resolve));
  const targetAddress = target.address() as AddressInfo;
  const redirect = createServer((_request, response) => { response.writeHead(302, { Location: `http://127.0.0.1:${targetAddress.port}/mcp` }); response.end(); });
  await new Promise<void>((resolve) => redirect.listen(0, "127.0.0.1", resolve));
  try {
    const address = redirect.address() as AddressInfo;
    const rejected = await executeMcpProbe(binary, ["fixtures", `http://127.0.0.1:${address.port}/mcp`, urls.modern]);
    assert.equal(rejected.timedOut, false); assert.equal(rejected.exit, 1); assert.equal(rejected.stdout, "");
    assert.equal(redirectedRequests, 0, "redirect destination must not be contacted by any HTTP method");
  } finally {
    redirect.closeAllConnections(); target.closeAllConnections();
    await Promise.all([new Promise<void>((resolve) => redirect.close(() => resolve())), new Promise<void>((resolve) => target.close(() => resolve()))]);
  }
  server.stdin.end();
  let stopTimer: ReturnType<typeof setTimeout> | undefined;
  try {
    const stopped = await Promise.race([server.exited, new Promise<null>((resolve) => { stopTimer = setTimeout(() => resolve(null), 5000); })]);
    assert.equal(stopped, 0, "HTTP oracle must shut down cleanly");
  } finally { clearTimeout(stopTimer); }
  const snapshots = JSON.parse(await serverOutput) as Record<string, { observations: RequestObservation[]; counts: { requests: number; toolCalls: number }; closedRequestIds: unknown[] }>;
  for (const era of ["legacy", "modern"] as const) {
    const fixture = snapshots[era]!;
    assert.deepEqual(result[era].tools, ["probe"]);
    assert.equal(result[era].content[0].text, `${era} result from probe`);
    assert.equal(result[era].toolError, true); assert.equal(result[era].rpcError, true); assert.equal(result[era].cancelled, true);
    assert.equal(fixture.counts.toolCalls, 4, "no failed or cancelled call may be replayed");
    assert(fixture.counts.requests <= 12, "bounded fixture request count");
    const slow = fixture.observations.find((request) => request.toolName === "slow");
    const cancelled = fixture.observations.filter((request) => request.method === "notifications/cancelled");
    assert(slow);
    const afterCancelList = fixture.observations.filter((request) => request.method === "tools/list").at(-1);
    assert(afterCancelList && afterCancelList.ordinal > slow.ordinal);
    assert(fixture.closedRequestIds.includes(slow.jsonRpcId), "cancelled response closed before the list barrier succeeded");
    if (era === "modern") {
      assert.equal(cancelled.length, 0);
      assert.equal(fixture.observations.filter((request) => request.method === "server/discover").length, 1);
      assert(!fixture.observations.some((request) => request.method === "initialize" || request.method === "notifications/initialized" || request.hasSessionId));
      for (const request of fixture.observations.filter((request) => ["tools/list", "tools/call"].includes(request.method))) {
        assert.equal(request.protocolVersionHeader, "2026-07-28");
        assert.equal(request.methodHeader, request.method); assert.equal(request.hasMetaEnvelope, true);
        if (request.method === "tools/call") assert.equal(request.nameHeader, request.toolName);
      }
    } else {
      assert.equal(cancelled.length, 1); assert.equal(cancelled[0]!.cancelledRequestId, slow.jsonRpcId);
      assert.equal(fixture.observations.filter((request) => request.method === "initialize").length, 1);
      assert.equal(fixture.observations.filter((request) => request.method === "notifications/initialized").length, 1);
      assert(!fixture.observations.some((request) => request.method === "server/discover"));
      assert(fixture.observations.filter((request) => request.method.startsWith("tools/")).every((request) => request.hasSessionId));
    }
  }
  console.log(JSON.stringify({ schemaVersion: 1, platform: process.platform, result, snapshots, checks: ["mixed-connections", "discovery", "list-call", "tool-rpc-errors", "bound-cancellation", "post-cancel-continuation", "no-replay", "routing-headers", "no-redirect", "redacted-errors"] }, null, 2));
} finally {
  if (server.exitCode === null) server.kill("SIGKILL");
  await server.exited;
  await rm(sandbox, { recursive: true, force: true });
}
