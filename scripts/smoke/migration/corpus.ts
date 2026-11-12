import assert from "node:assert/strict";
import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { baselineSha } from "../../check/migration/baseline";
import { sha256 } from "../../check/migration/check";
import { execute, isolatedConfig, treeManifest } from "./harness";

import { parseCorpus, verifyCorpusObservation } from "./corpus-contract";

const [sourceArg, outputArg] = process.argv.slice(2);
assert(sourceArg && outputArg, "Usage: bun scripts/smoke/migration/corpus.ts <clean-TS-checkout> <new-output-directory>");
const source = resolve(sourceArg), output = resolve(outputArg);
const tsSha = await baselineSha(source);
const fixtures = resolve(import.meta.dir, "../../../tests/fixtures/migration/corpus");
const casesBytes = await readFile(join(fixtures, "cases.json"));
const cases = parseCorpus(JSON.parse(casesBytes.toString()));
await mkdir(output);
const results: Array<{ id: string; status: string; resultHash: string; manifestHash: string }> = [];
let complete = false;
try {
  for (const scenario of cases) {
    assert(/^[a-z0-9-]+$/.test(scenario.id) && /^[a-z0-9-]+$/.test(scenario.sessionId));
    assert(scenario.assertions.length > 0 || scenario.expectedError);
    const original = join(fixtures, scenario.id, "project");
    const originalManifest = JSON.parse(await readFile(join(fixtures, scenario.id, "manifest.json"), "utf8"));
    assert.deepEqual(await treeManifest(original), originalManifest, `source fixture integrity: ${scenario.id}`);
    const folder = join(output, scenario.id), project = join(folder, "project");
    await mkdir(folder);
    await cp(original, project, { recursive: true, errorOnExist: true, force: false });
    const before = await treeManifest(project);
    const scenarioPath = join(folder, "scenario.json");
    await writeFile(scenarioPath, `${JSON.stringify(scenario, null, 2)}\n`);
    const env = await isolatedConfig(folder, "http://127.0.0.1:1");
    const observationPath = join(folder, "observation.json");
    await execute([join(import.meta.dir, "corpus-worker.ts"), source, project, scenarioPath, observationPath], project, env, join(folder, "command.log"));
    const observation: unknown = JSON.parse(await readFile(observationPath, "utf8"));
    const assertions = verifyCorpusObservation(scenario, observation);
    assert.deepEqual(await treeManifest(project), before, `reader mutated sandbox: ${scenario.id}`);
    assert.deepEqual(await treeManifest(original), originalManifest, `reader mutated original: ${scenario.id}`);
    assertions.push("sandbox and original trees unchanged");
    const result = { schemaVersion: 1, scenarioId: `CORPUS-${scenario.id}`, status: "passed", tsSha, rustSha: null, assertions };
    const bytes = `${JSON.stringify(result, null, 2)}\n`;
    await writeFile(join(folder, "result.json"), bytes);
    const manifestBytes = `${JSON.stringify(await treeManifest(folder), null, 2)}\n`;
    await writeFile(join(folder, "manifest.json"), manifestBytes);
    results.push({ id: scenario.id, status: "passed", resultHash: sha256(bytes), manifestHash: sha256(manifestBytes) });
    console.log(`${scenario.id}: ${assertions.length} assertions passed`);
  }
  assert.equal(await baselineSha(source), tsSha, "source checkout changed during corpus execution");
  complete = true;
} finally {
  await writeFile(join(output, "RUN.json"), `${JSON.stringify({ schemaVersion: 1, status: complete ? "passed" : "failed", tsSha, rustSha: null, casesHash: sha256(casesBytes), expectedCases: cases.map((item) => item.id), results }, null, 2)}\n`);
}
