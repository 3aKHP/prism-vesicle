import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import cases from "../../../tests/fixtures/migration/oracle/cases.json";

// A fresh process for each phase deliberately prevents paused continuation from
// succeeding solely because a turn's in-memory context survived.
const [sourceArg, rootArg, scenario, phase, resultPath] = process.argv.slice(2);
assert(sourceArg && rootArg && scenario && phase && resultPath, "worker requires source/project/scenario/phase/result");
const source = resolve(sourceArg), root = resolve(rootArg);
async function load<T>(path: string): Promise<T> { return import(pathToFileURL(join(source, path)).href) as Promise<T>; }
const session = await load<typeof import("../../../src/core/session/store")>("src/core/session/store.ts");
const runtime = await load<typeof import("../../../src/core/agent-loop/run")>("src/core/agent-loop/run.ts");
const checkpointPath = join(root, "oracle-checkpoint.json");
const permission = { mode: "MOMENTUM" as const };

if (scenario === "path-guard") {
  const tools = await load<typeof import("../../../src/core/tools/fs")>("src/core/tools/fs.ts");
  const result = await tools.executeFileTool(root, { id: "escape-write", name: "write_file", arguments: JSON.stringify({ path: cases["path-guard"].path, content: cases["path-guard"].content }) });
  assert.equal(result.ok, false, "out-of-root mutation must fail");
  await writeFile(resultPath, JSON.stringify({ result }, null, 2));
} else if (scenario === "tool-loop" || scenario === "gate" || scenario === "candidate") {
  if (phase === "start") {
    const result = await runtime.runPrompt({ input: cases[scenario].prompt, rootDir: root, engine: "etl", permission });
    assert.equal(result.kind, scenario === "gate" ? "needs_user" : "complete");
    const records = await session.loadSessionRecords(root, result.sessionId);
    const user = records.find((r) => r.role === "user");
    const leaf = records.filter((r) => r.role === "assistant").at(-1);
    assert(user && leaf);
    await writeFile(checkpointPath, JSON.stringify({ sessionId: result.sessionId, user: user.uuid, leaf: leaf.uuid }));
    await writeFile(resultPath, JSON.stringify({ kind: result.kind, records, snapshot: await session.loadSessionSnapshot(root, result.sessionId) }, null, 2));
  } else {
    const saved = JSON.parse(await readFile(checkpointPath, "utf8")) as { sessionId: string; user: string; leaf: string };
    const before = await readFile(join(root, ".vesicle/sessions", `${saved.sessionId}.jsonl`), "utf8");
    const snapshot = await session.loadSessionSnapshot(root, saved.sessionId);
    if (scenario === "gate") {
      assert(snapshot.pendingGate, "restart must recover pending gate");
      assert.equal(snapshot.pendingGate.gate.gate, cases.gate.expected.gate);
      const resumed = await runtime.resolveGate({ rootDir: root, engine: "etl", sessionId: saved.sessionId, messages: snapshot.messages, ...snapshot.pendingGate, resolution: { decision: "confirm" }, permission });
      assert.equal(resumed.kind, "complete");
    } else if (scenario === "candidate") {
      const regenerated = await runtime.regenerateTurn({ rootDir: root, sessionId: saved.sessionId, userRecordUuid: saved.user, permission });
      assert.equal(regenerated.kind, "complete");
      assert.equal(await readFile(join(root, cases.candidate.expected.file), "utf8"), "beta\n", "regenerated files must actually reach disk");
      const records = await session.loadSessionRecords(root, saved.sessionId);
      const newLeaf = records.filter((r) => r.role === "assistant").at(-1);
      assert(newLeaf && newLeaf.uuid !== saved.leaf);
      const files = await load<typeof import("../../../src/core/checkpoints/candidate-files")>("src/core/checkpoints/candidate-files.ts");
      const selection = await load<typeof import("../../../src/core/session/selection")>("src/core/session/selection.ts");
      const switched = await files.switchCandidateFileState(root, saved.sessionId, { forkPointUuid: saved.user, fromLeaf: newLeaf.uuid, toLeaf: saved.leaf });
      assert.equal(switched.restored, true);
      await selection.appendCandidateSelection(root, saved.sessionId, { forkPointUuid: saved.user, selectedLeafUuid: saved.leaf });
    }
    const after = await readFile(join(root, ".vesicle/sessions", `${saved.sessionId}.jsonl`), "utf8");
    assert(after.startsWith(before), "resume/regenerate/switch must preserve the existing transcript bytes");
    await writeFile(resultPath, JSON.stringify({ appendOnly: true, records: await session.loadSessionRecords(root, saved.sessionId), snapshot: await session.loadSessionSnapshot(root, saved.sessionId) }, null, 2));
  }
} else throw new Error(`Unknown oracle scenario: ${scenario}`);
