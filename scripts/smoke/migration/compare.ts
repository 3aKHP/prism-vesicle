import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { treeManifest } from "./harness";
import { sha256 } from "../../check/migration/check";

const caseIds = ["tool-loop", "gate", "candidate", "config", "path-guard"].sort();
/** Compare executed observations, not fixture responses or an implementation's declarations. */
export async function compareOracleRuns(left: string, right: string) {
  const read = async (root: string) => {
    const run: unknown = JSON.parse(await readFile(join(root, "RUN.json"), "utf8"));
    assert(run && typeof run === "object" && "schemaVersion" in run && run.schemaVersion === 1 && "results" in run && Array.isArray(run.results));
    const rows = run.results as Array<Record<string, unknown>>;
    assert.deepEqual(rows.map((r) => r.id).sort(), caseIds, "oracle cases missing or duplicated");
    const observations = new Map<string, unknown>();
    const assertions = new Map<string, string[]>();
    assert("tsSha" in run && typeof run.tsSha === "string" && /^[a-f0-9]{40}$/.test(run.tsSha));
    assert("rustSha" in run && (run.rustSha === null || (typeof run.rustSha === "string" && /^[a-f0-9]{40}$/.test(run.rustSha))));
    for (const row of rows) {
      const id = String(row.id);
      assert.equal(row.artifact, `${id}/result.json`);
      assert.equal(row.comparison, `${id}/comparison.json`);
      assert.equal(row.rawManifest, `${id}/manifest.json`);
      const manifestBytes = await readFile(join(root, `${id}/manifest.json`));
      assert.equal(sha256(manifestBytes), row.rawManifestHash, `${id}: raw manifest hash mismatch`);
      const expectedFiles: unknown = JSON.parse(manifestBytes.toString());
      const actualFiles = await treeManifest(join(root, id));
      delete actualFiles["manifest.json"];
      assert.deepEqual(actualFiles, expectedFiles, `${id}: retained raw evidence changed`);
      const resultBytes = await readFile(join(root, `${id}/result.json`));
      assert.equal(sha256(resultBytes), row.sha256, `${id}: result hash mismatch`);
      const result = JSON.parse(resultBytes.toString());
      assert.equal(result.schemaVersion, 1, `${id}: unsupported result schema`);
      assert.equal(result.tsSha, run.tsSha, `${id}: result TS provenance mismatch`);
      assert.equal(result.rustSha, run.rustSha, `${id}: result Rust provenance mismatch`);
      assert.equal(result.status, "passed", `${id}: non-passing oracle`);
      assert.equal(result.scenarioId, `SC-S0-${id}`);
      assert(Array.isArray(result.assertions) && result.assertions.length > 0 && result.assertions.every((a: unknown) => typeof a === "string" && a.trim().length > 0));
      assert.equal(new Set(result.assertions).size, result.assertions.length);
      assertions.set(id, result.assertions);
      const bytes = await readFile(join(root, `${id}/comparison.json`));
      assert.equal(sha256(bytes), row.comparisonHash, `${id}: comparison hash mismatch`);
      observations.set(id, JSON.parse(bytes.toString()));
    }
    assert("fixtureHash" in run && typeof run.fixtureHash === "string" && /^[a-f0-9]{64}$/.test(run.fixtureHash));
    assert("tsSha" in run && typeof run.tsSha === "string" && /^[a-f0-9]{40}$/.test(run.tsSha));
    return { observations, assertions, fixtureHash: run.fixtureHash, tsSha: run.tsSha };
  };
  const a = await read(left), b = await read(right);
  assert.equal(a.fixtureHash, b.fixtureHash, "comparison inputs differ");
  assert.equal(a.tsSha, b.tsSha, "comparison baselines differ");
  assert.deepEqual(a.assertions, b.assertions, "comparison assertion coverage differs");
  for (const id of caseIds) assert.deepEqual(a.observations.get(id), b.observations.get(id), `${id}: observable behavior differs`);
  return { passed: caseIds };
}

if (import.meta.main) {
  const [left, right] = process.argv.slice(2);
  assert(left && right, "Usage: bun scripts/smoke/migration/compare.ts <left-run> <right-run>");
  console.log(JSON.stringify(await compareOracleRuns(left, right), null, 2));
}
