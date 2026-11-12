import assert from "node:assert/strict";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { sha256 } from "../../check/migration/check";
import { treeManifest } from "./harness";
import { compareOracleRuns } from "./compare";

const [arg] = process.argv.slice(2);
assert(arg, "Usage: bun scripts/smoke/migration/self-check.ts <completed-oracle-run>");
const original = resolve(arg), root = await mkdtemp(join(tmpdir(), "vesicle-oracle-corruption-"));
type Run = { results: Array<{ id: string; comparisonHash: string; rawManifestHash: string; sha256: string }> };
async function refreshHashes(changed: string) {
  const runPath = join(changed, "RUN.json"), folder = join(changed, "tool-loop");
  const run = JSON.parse(await readFile(runPath, "utf8")) as Run;
  const row = run.results.find((r) => r.id === "tool-loop")!;
  const files = await treeManifest(folder);
  delete files["manifest.json"];
  const manifest = JSON.stringify(files, null, 2);
  await writeFile(join(folder, "manifest.json"), manifest);
  row.rawManifestHash = sha256(manifest);
  row.comparisonHash = sha256(await readFile(join(folder, "comparison.json")));
  row.sha256 = sha256(await readFile(join(folder, "result.json")));
  await writeFile(runPath, JSON.stringify(run));
}
try {
  const changed = join(root, "changed");
  const restore = () => cp(original, changed, { recursive: true });
  await restore();
  await compareOracleRuns(original, changed);
  await writeFile(join(changed, "tool-loop/wire.raw.json"), "[]");
  await writeFile(join(changed, "tool-loop/project/workspace/note.txt"), "corrupt bytes");
  await assert.rejects(compareOracleRuns(original, changed), /retained raw evidence changed/);
  console.log("changed raw wire and retained artifact: rejected");
  await restore();
  const comparisonFile = join(changed, "tool-loop/comparison.json");
  const observation = JSON.parse(await readFile(comparisonFile, "utf8"));
  observation.artifacts["workspace/note.txt"] = "0".repeat(64);
  await writeFile(comparisonFile, JSON.stringify(observation, null, 2));
  await assert.rejects(compareOracleRuns(original, changed), /retained raw evidence changed|comparison hash mismatch/);
  console.log("corrupted comparison hash: rejected");
  await refreshHashes(changed);
  await assert.rejects(compareOracleRuns(original, changed), /observable behavior differs/);
  console.log("changed artifact with recomputed hashes: rejected");
  for (const [key, value, failure] of [["schemaVersion", 99, /unsupported result schema/], ["tsSha", "0".repeat(40), /result TS provenance mismatch/]] as const) {
    await restore();
    const resultPath = join(changed, "tool-loop/result.json");
    const result = JSON.parse(await readFile(resultPath, "utf8"));
    result[key] = value;
    await writeFile(resultPath, JSON.stringify(result));
    await refreshHashes(changed);
    await assert.rejects(compareOracleRuns(original, changed), failure);
    console.log(`changed ${key} with recomputed hashes: rejected`);
  }
  await restore();
  const runPath = join(changed, "RUN.json");
  const run = JSON.parse(await readFile(runPath, "utf8")) as Run;
  run.results.pop();
  await writeFile(runPath, JSON.stringify(run));
  await assert.rejects(compareOracleRuns(original, changed), /oracle cases missing or duplicated/);
  console.log("missing scenario: rejected");
} finally { await rm(root, { recursive: true, force: true }); }
