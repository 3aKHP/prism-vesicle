import assert from "node:assert/strict";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { sha256 } from "../../check/migration/check";
import { validateCorpusRun } from "./corpus-compare";
import { treeManifest } from "./harness";

const source = process.argv[2];
assert(source, "Usage: bun scripts/smoke/migration/corpus-self-check.ts <completed-run>");
await validateCorpusRun(resolve(source));
const temporary = await mkdtemp(join(tmpdir(), "vesicle-corpus-corruption-"));
try {
  for (const corruption of ["raw-tree", "rehashed-observation", "wrong-sha", "skipped", "missing-case", "weakened-scenario", "failed-run"]) {
    const root = join(temporary, corruption);
    await cp(resolve(source), root, { recursive: true });
    const runPath = join(root, "RUN.json");
    const run = JSON.parse(await readFile(runPath, "utf8"));
    const row = run.results.find((entry: { id: string }) => entry.id === "legacy-linear");
    assert(row);
    const folder = join(root, "legacy-linear");
    if (corruption === "raw-tree") {
      await writeFile(join(folder, "project/.vesicle/sessions/fixture.jsonl"), "damaged\n");
    } else if (corruption === "missing-case") {
      run.results.pop();
    } else if (corruption === "failed-run") {
      run.status = "failed";
    } else {
      if (corruption === "rehashed-observation") {
        const file = join(folder, "observation.json");
        const observation = JSON.parse(await readFile(file, "utf8"));
        observation.views.default.contents[0] = "wrong projected behavior";
        await writeFile(file, `${JSON.stringify(observation)}\n`);
      } else if (corruption === "weakened-scenario") {
        const file = join(folder, "scenario.json");
        const scenario = JSON.parse(await readFile(file, "utf8"));
        scenario.assertions.pop();
        await writeFile(file, `${JSON.stringify(scenario)}\n`);
      } else {
        const file = join(folder, "result.json");
        const result = JSON.parse(await readFile(file, "utf8"));
        if (corruption === "wrong-sha") result.tsSha = "0".repeat(40);
        else result.status = "skipped";
        const bytes = `${JSON.stringify(result)}\n`;
        await writeFile(file, bytes);
        row.resultHash = sha256(bytes);
      }
      const files = await treeManifest(folder);
      delete files["manifest.json"];
      const bytes = `${JSON.stringify(files)}\n`;
      await writeFile(join(folder, "manifest.json"), bytes);
      row.manifestHash = sha256(bytes);
    }
    await writeFile(runPath, `${JSON.stringify(run)}\n`);
    await assert.rejects(validateCorpusRun(root), (error: unknown) => error instanceof Error, `${corruption} must be rejected`);
    console.log(`${corruption}: rejected`);
  }
} finally {
  await rm(temporary, { recursive: true, force: true });
}
