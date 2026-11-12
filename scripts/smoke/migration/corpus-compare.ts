import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { sha256 } from "../../check/migration/check";
import { parseCorpus, verifyCorpusObservation } from "./corpus-contract";
import { treeManifest } from "./harness";

const fixtures = resolve(import.meta.dir, "../../../tests/fixtures/migration/corpus");

export async function validateCorpusRun(root: string) {
  const casesBytes = await readFile(join(fixtures, "cases.json"));
  const cases = parseCorpus(JSON.parse(casesBytes.toString()));
  const run = JSON.parse(await readFile(join(root, "RUN.json"), "utf8"));
  assert.equal(run.schemaVersion, 1);
  assert.equal(run.rustSha, null);
  assert.match(run.tsSha, /^[0-9a-f]{40}$/);
  assert.equal(run.casesHash, sha256(casesBytes));
  assert.deepEqual(run.expectedCases, cases.map((scenario) => scenario.id));
  assert.deepEqual(run.results.map((row: { id: string }) => row.id), run.expectedCases);
  const observations: Record<string, unknown> = {};
  for (const [index, scenario] of cases.entries()) {
    const row = run.results[index];
    assert.equal(row.status, "passed");
    const folder = join(root, scenario.id);
    const manifestBytes = await readFile(join(folder, "manifest.json"));
    assert.equal(sha256(manifestBytes), row.manifestHash);
    const actualFiles = await treeManifest(folder);
    delete actualFiles["manifest.json"];
    assert.deepEqual(actualFiles, JSON.parse(manifestBytes.toString()), `retained files: ${scenario.id}`);
    assert.deepEqual(JSON.parse(await readFile(join(folder, "scenario.json"), "utf8")), scenario);
    const original = JSON.parse(await readFile(join(fixtures, scenario.id, "manifest.json"), "utf8"));
    assert.deepEqual(await treeManifest(join(fixtures, scenario.id, "project")), original);
    assert.deepEqual(await treeManifest(join(folder, "project")), original, `preserved corpus tree: ${scenario.id}`);
    const resultBytes = await readFile(join(folder, "result.json"));
    assert.equal(sha256(resultBytes), row.resultHash);
    const result = JSON.parse(resultBytes.toString());
    assert.equal(result.schemaVersion, 1);
    assert.equal(result.scenarioId, `CORPUS-${scenario.id}`);
    assert.equal(result.status, "passed");
    assert.equal(result.tsSha, run.tsSha);
    assert.equal(result.rustSha, null);
    const command = JSON.parse(await readFile(join(folder, "command.log"), "utf8"));
    assert.equal(command.exitCode, 0);
    assert.equal(command.timedOut, false);
    const observation: unknown = JSON.parse(await readFile(join(folder, "observation.json"), "utf8"));
    assert.deepEqual(result.assertions, [...verifyCorpusObservation(scenario, observation), "sandbox and original trees unchanged"]);
    observations[scenario.id] = observation;
  }
  return { tsSha: run.tsSha as string, observations };
}

if (import.meta.main) {
  const [left, right] = process.argv.slice(2);
  assert(left && right, "Usage: bun scripts/smoke/migration/corpus-compare.ts <left-run> <right-run>");
  assert.deepEqual(await validateCorpusRun(resolve(left)), await validateCorpusRun(resolve(right)));
  console.log("Corpus observations match; evidence hashes, assertions and original trees verified.");
}
