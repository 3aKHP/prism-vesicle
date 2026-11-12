import assert from "node:assert/strict";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import cases from "../../../tests/fixtures/migration/oracle/cases.json";
import { baselineSha } from "../../check/migration/baseline";
import { sha256 } from "../../check/migration/check";
import { execute, isolatedConfig, treeManifest, workerPath } from "./harness";
import { normalizeObservation } from "./normalize";

const [sourceArg, outputArg] = process.argv.slice(2);
assert(sourceArg && outputArg, "Usage: bun scripts/smoke/migration/main.ts <clean-TS-checkout> <new-output-directory>");
const source = resolve(sourceArg), output = resolve(outputArg);
const tsSha = await baselineSha(source);
await mkdir(output); // Never replace another run's evidence.
type ScriptedResponse = { content: string; tool?: { id: string; name: string; arguments: Record<string, unknown> } };
type WireRequest = { messages: Array<Record<string, unknown>>; [key: string]: unknown };
let script: readonly ScriptedResponse[] = [], requests: WireRequest[] = [];
let serverFailure: string | undefined;
let activeProject: string | undefined;
let durability: Array<{ request: number; toolCallIds: string[]; transcriptHash: string }> = [];
const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
  try {
    assert.equal(new URL(request.url).pathname, "/v1/chat/completions");
    assert.equal(request.method, "POST");
    const body: unknown = await request.json();
    assert(body && typeof body === "object" && "messages" in body && Array.isArray(body.messages));
    const wire = body as WireRequest;
    requests.push(wire);
    const toolMessages = wire.messages.filter((m) => m.role === "tool");
    if (toolMessages.length) {
      assert(activeProject);
      const directory = join(activeProject, ".vesicle/sessions");
      const paths = (await readdir(directory)).filter((p) => p.endsWith(".jsonl"));
      assert.equal(paths.length, 1, "scenario must own exactly one transcript");
      const transcript = await readFile(join(directory, paths[0]!), "utf8");
      const records = transcript.trim().split("\n").map((line) => JSON.parse(line));
      const ids: string[] = [];
      for (const message of toolMessages) {
        assert.equal(typeof message.tool_call_id, "string");
        assert(records.some((r) => r.role === "tool" && r.metadata?.toolCallId === message.tool_call_id && r.content === message.content), "paired tool result must already be durable when the next request arrives");
        ids.push(String(message.tool_call_id));
      }
      durability.push({ request: requests.length, toolCallIds: ids, transcriptHash: sha256(transcript) });
    }
    const reply = script[requests.length - 1];
    assert(reply, "unexpected provider request (title, retry or auxiliary call)");
    return Response.json({ id: `oracle-${requests.length}`, choices: [{ finish_reason: reply.tool ? "tool_calls" : "stop", message: {
      role: "assistant", content: reply.content,
      ...(reply.tool ? { tool_calls: [{ id: reply.tool.id, type: "function", function: { name: reply.tool.name, arguments: JSON.stringify(reply.tool.arguments) } }] } : {}),
    } }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } });
  } catch (error) {
    serverFailure = String(error);
    return Response.json({ error: { message: "oracle provider fixture rejected request" } }, { status: 400 });
  }
} });

const results: Array<{ id: string; artifact: string; sha256: string; comparison: string; comparisonHash: string; rawManifest: string; rawManifestHash: string }> = [];
try {
  for (const scenario of ["tool-loop", "gate", "candidate", "config", "path-guard"] as const) {
    const folder = join(output, scenario), project = join(folder, "project");
    await mkdir(project, { recursive: true });
    const env = await isolatedConfig(folder, server.url.origin);
    requests = [];
    durability = [];
    activeProject = project;
    serverFailure = undefined;
    script = scenario in cases && "responses" in cases[scenario] ? (cases[scenario] as { responses: ScriptedResponse[] }).responses : [];
    const assertions: string[] = [];
    const verify = (name: string, condition: unknown) => { assert(condition, name); assertions.push(name); };
    const before = await treeManifest(project);
    let observation: unknown = {};
    if (scenario === "config") {
      const cli = join(source, "src/cli/main.ts"), registry = join(folder, "config/providers.yaml");
      const originalRegistry = await readFile(registry, "utf8");
      await execute([cli, "config", "set", "providers", "default.model", cases.config.model], project, env, join(folder, "config-valid.log"));
      const changed = await readFile(registry, "utf8");
      observation = { registry: changed.replace(server.url.origin, "<loopback-origin>") };
      await writeFile(join(folder, "providers.after.yaml"), changed);
      assert.equal(changed, originalRegistry.replace("  model: oracle-model", `  model: ${cases.config.model}`), "config transaction changes only the requested selection");
      verify("valid config transaction preserves comments and updates the selected model", changed.includes(cases.config.comment) && changed.includes(`model: ${cases.config.model}`));
      await execute([cli, "config", "set", "providers", "default.model", cases.config.invalidModel], project, env, join(folder, "config-invalid.log"), 1);
      verify("invalid config transaction preserves the original bytes", await readFile(registry, "utf8") === changed);
    } else if (scenario === "path-guard") {
      const sentinel = join(folder, "outside.txt");
      await writeFile(sentinel, cases[scenario].sentinel);
      await execute([workerPath, source, project, scenario, "start", join(folder, "phase-start.json")], project, env, join(folder, "phase-start.log"));
      observation = JSON.parse(await readFile(join(folder, "phase-start.json"), "utf8"));
      verify("out-of-root write is rejected and outside bytes are preserved", await readFile(sentinel, "utf8") === cases[scenario].sentinel);
      verify("rejected write leaves project tree unchanged", JSON.stringify(await treeManifest(project)) === JSON.stringify(before));
    } else {
      await execute([workerPath, source, project, scenario, "start", join(folder, "phase-start.json")], project, env, join(folder, "phase-start.log"));
      const paused: unknown = JSON.parse(await readFile(join(folder, "phase-start.json"), "utf8"));
      assert(paused && typeof paused === "object");
      if (scenario !== "tool-loop") {
        verify("pause or first candidate completes without a hidden provider continuation", requests.length === (scenario === "gate" ? 1 : 2));
        await execute([workerPath, source, project, scenario, "resume", join(folder, "phase-resume.json")], project, env, join(folder, "phase-resume.log"));
      }
      verify("provider request count equals the bounded script", requests.length === cases[scenario].expected.requests);
      const snapshotResult = JSON.parse(await readFile(join(folder, scenario === "tool-loop" ? "phase-start.json" : "phase-resume.json"), "utf8")) as {
        appendOnly?: boolean; records: Array<{ role: string; content: string; metadata?: Record<string, unknown> }>;
        snapshot: { messages: Array<{ role: string; content: string }>; pendingGate?: unknown };
      };
      observation = { start: paused, resumed: snapshotResult };
      if (scenario === "candidate") {
        verify("candidate switch restores exact original file bytes", await readFile(join(project, cases.candidate.expected.file), "utf8") === cases.candidate.expected.content);
        verify("candidate projection selects alpha while retaining beta in durable history", snapshotResult.snapshot.messages.some((m) => m.content === cases.candidate.expected.activeReply) && !snapshotResult.snapshot.messages.some((m) => m.content === cases.candidate.expected.inactiveReply) && snapshotResult.records.some((r) => r.content === cases.candidate.expected.inactiveReply));
      } else {
        verify("provider reply survives durable projection", snapshotResult.snapshot.messages.at(-1)?.content === cases[scenario].expected.reply);
        const callId = cases[scenario].responses[0]!.tool!.id;
        const next = requests[1]!.messages;
        verify("next wire request contains the paired tool result", next.some((m) => m.role === "tool" && m.tool_call_id === callId));
        verify("tool result is durable before continuation", durability.some((entry) => entry.toolCallIds.includes(callId)));
        if (scenario === "tool-loop") verify("successful tool write matches artifact bytes", await readFile(join(project, cases[scenario].expected.file), "utf8") === cases[scenario].expected.content);
        else verify("restart resolves the pending gate", !snapshotResult.snapshot.pendingGate);
      }
      if (scenario !== "tool-loop") verify("resume and branching retain the transcript prefix", snapshotResult.appendOnly === true);
    }
    assert.equal(serverFailure, undefined);
    await writeFile(join(folder, "wire.raw.json"), JSON.stringify(requests, null, 2));
    await writeFile(join(folder, "durability.raw.json"), JSON.stringify(durability, null, 2));
    const tree = await treeManifest(project);
    await writeFile(join(folder, "tree.raw.json"), JSON.stringify(tree, null, 2));
    const artifacts = Object.fromEntries(Object.entries(tree).filter(([path]) => /^(source_materials|workspace|test_runs|novels|reports|tmp)\//.test(path)));
    await writeFile(join(folder, "comparison.json"), JSON.stringify(normalizeObservation({ wire: requests, observation, artifacts }), null, 2));
    const artifact = JSON.stringify({ schemaVersion: 1, scenarioId: `SC-S0-${scenario}`, tsSha, rustSha: null, status: "passed", assertions }, null, 2);
    await writeFile(join(folder, "result.json"), artifact);
    const rawManifest = JSON.stringify(await treeManifest(folder), null, 2);
    await writeFile(join(folder, "manifest.json"), rawManifest);
    results.push({ id: scenario, artifact: `${scenario}/result.json`, sha256: sha256(artifact), comparison: `${scenario}/comparison.json`, comparisonHash: sha256(await readFile(join(folder, "comparison.json"))), rawManifest: `${scenario}/manifest.json`, rawManifestHash: sha256(rawManifest) });
    console.log(`${scenario}: passed (${assertions.length} assertions)`);
  }
  assert.equal(await baselineSha(source), tsSha, "TS baseline changed during execution");
  await writeFile(join(output, "RUN.json"), JSON.stringify({ schemaVersion: 1, tsSha, rustSha: null, fixtureHash: sha256(await readFile(resolve(import.meta.dir, "../../../tests/fixtures/migration/oracle/cases.json"))), bun: Bun.version, platform: process.platform, results }, null, 2));
} finally { await server.stop(true); }
