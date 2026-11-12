// Run under Node 24: this oracle needs native ServerResponse close events for
// modern HTTP cancellation. Bun remains the build/test orchestrator.
import { rename, writeFile } from "node:fs/promises";
import { createLoopbackFixture } from "../../../tests/support/mcp/loopback.ts";

const path = process.argv[2];
if (!path) throw new Error("ready-file argument required");
const legacy = await createLoopbackFixture({ mode: "legacy", toolName: "probe", probeBehavior: true });
const modern = await createLoopbackFixture({ mode: "modern", toolName: "probe", probeBehavior: true });
try {
  await writeFile(`${path}.tmp`, JSON.stringify({ legacy: legacy.url, modern: modern.url }));
  await rename(`${path}.tmp`, path);
  for await (const _chunk of process.stdin) { /* EOF is the lifetime boundary. */ }
} finally {
  legacy.server.closeAllConnections(); modern.server.closeAllConnections();
  await legacy.close(); await modern.close();
}
console.log(JSON.stringify({
  legacy: { observations: legacy.observations, counts: legacy.counts, closedRequestIds: legacy.closedRequestIds },
  modern: { observations: modern.observations, counts: modern.counts, closedRequestIds: modern.closedRequestIds },
}));
