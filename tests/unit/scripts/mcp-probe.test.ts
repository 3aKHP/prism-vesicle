import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readLiveBudget, reserveLiveSession } from "../../../scripts/probe/mcp-live-budget";
import { mcpExecutableFromCargo } from "../../../scripts/smoke/migration/rust-mcp-command";

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))); });
async function ledger() {
  const directory = await mkdtemp(join(tmpdir(), "mcp-live-budget-"));
  directories.push(directory);
  return join(directory, "budget.json");
}

test("spent reservations survive reopening and an abandoned partial temporary write", async () => {
  const path = await ledger();
  let budget = await readLiveBudget(path);
  for (let attempt = 0; attempt < 3; attempt++) budget = await reserveLiveSession(path, budget);
  await writeFile(`${path}.interrupted.tmp`, '{"sessionsStarted":');
  const recovered = await readLiveBudget(path);
  expect(recovered.sessionsStarted).toBe(3); expect(recovered.rpcReservations).toBe(12);
  const exhausted = await reserveLiveSession(path, recovered);
  expect(exhausted.sessionsStarted).toBe(4); expect(exhausted.rpcReservations).toBe(16);
  await expect(reserveLiveSession(path, exhausted)).rejects.toThrow("exhausted");
  expect(JSON.parse(await readFile(path, "utf8"))).toEqual(exhausted);
});

test("empty, truncated and inconsistent existing ledgers fail closed", async () => {
  const path = await ledger();
  for (const corrupted of ["", '{"sessionsStarted":', JSON.stringify({ schemaVersion: 1, maxSessions: 4, maxRpcReservations: 16, sessionsStarted: 3, rpcReservations: 0 })]) {
    await writeFile(path, corrupted);
    await expect(readLiveBudget(path)).rejects.toThrow();
    expect(await readFile(path, "utf8")).toBe(corrupted);
  }
});

test("Cargo artifact reports select the built executable under a custom target directory", () => {
  const executable = join(tmpdir(), "alternate-target", "native-triple", "debug", "vesicle-mcp-probe");
  const messages = [
    { reason: "compiler-artifact", target: { name: "dependency", kind: ["lib"] }, executable: null },
    { reason: "compiler-artifact", target: { name: "vesicle-mcp-probe", kind: ["bin"] }, executable, fresh: true },
    { reason: "build-finished", success: true },
  ].map((message) => JSON.stringify(message)).join("\n");
  expect(mcpExecutableFromCargo(messages)).toBe(executable);
  expect(() => mcpExecutableFromCargo('{"reason":"build-finished","success":true}')).toThrow("did not report");
});
