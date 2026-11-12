import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execute } from "../../../scripts/smoke/migration/harness";

test("oracle timeout terminates a child that ignores graceful shutdown", async () => {
  const root = await mkdtemp(join(tmpdir(), "vesicle-oracle-timeout-"));
  try {
    const log = join(root, "child.log");
    await expect(execute(["-e", 'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000);'], root, {}, log, 0, 100)).rejects.toThrow("oracle child exceeded 100 ms");
    const result = JSON.parse(await readFile(log, "utf8"));
    expect(result.timedOut).toBe(true);
    expect(result.exitCode).not.toBe(0);
  } finally { await rm(root, { recursive: true, force: true }); }
}, 3000);
