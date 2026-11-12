import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { buildActiveSessionBranch, normalizeSessionRecords } from "../../../src/core/session/record-model";
import { treeManifest } from "./harness";

const binary = resolve("target/debug", process.platform === "win32" ? "vesicle-rust-dev.exe" : "vesicle-rust-dev");
const corpus = resolve("tests/fixtures/migration/corpus");
const before = await treeManifest(corpus);
const results: Array<{ scenario: string; status: "passed" }> = [];

async function inspect(path: string, head?: string, error?: string, project?: string) {
  const command = [binary, ...(project ? ["verify-attachments", project] : ["inspect-session"]), path, ...(head ? ["--head", head] : [])];
  const child = Bun.spawn(command, { stdout: "pipe", stderr: "pipe" });
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; child.kill(); }, 10_000);
  try {
    const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    assert.equal(timedOut, false, "native inspector timed out");
    if (error) {
      assert.equal(exit, 1);
      assert.equal(stdout, "", "failed inspection must not emit a success document");
      assert.equal(JSON.parse(stderr).error, error);
      return;
    }
    assert.equal(exit, 0, stderr);
    assert.equal(stderr, "");
    const result = JSON.parse(stdout);
    assert.equal(result.schemaVersion, 1);
    assert.equal(result.mode, "read-only-inspection");
    assert.equal(result.attachmentsVerified, project !== undefined);
    return result;
  } finally { clearTimeout(timer); }
}

for (const [name, heads] of [
  ["legacy-linear", [undefined]],
  ["nested-candidates", [undefined, "a2", "b2"]],
  ["attachment", [undefined]],
  ["migration-skill-host-state", [undefined, "r2"]],
] as const) {
  const path = join(corpus, name, "project/.vesicle/sessions/fixture.jsonl");
  const raw = (await readFile(path, "utf8")).split(/\r?\n/).filter((line) => line.trim()).map((line) => JSON.parse(line));
  const normalized = normalizeSessionRecords(raw);
  for (const head of heads) {
    const result = await inspect(path, head);
    assert.deepEqual(result.records, normalized, "normalized records must match TS, including opaque metadata");
    assert.deepEqual(result.activeBranch, buildActiveSessionBranch(normalized, head ? { headUuid: head } : {}));
    results.push({ scenario: `${name}:${head ?? "default"}`, status: "passed" });
  }
}

// Reuse S0's independently specified expectations, previously exercised against
// the real TS reader, instead of deriving expected identity from Rust output.
const definitions = await Bun.file(join(corpus, "cases.json")).json();
const migration = definitions.cases.find((item: { id: string }) => item.id === "migration-skill-host-state");
for (const head of [undefined, "r2"]) {
  const result = await inspect(join(corpus, "migration-skill-host-state/project/.vesicle/sessions/fixture.jsonl"), head);
  for (const field of ["harness", "skillCatalogSnapshot"]) {
    const expected = migration.assertions.find((item: { path: string[] }) => item.path[1] === "r2" && item.path[3] === field);
    assert(expected, `independent S0 expectation missing for ${field}`);
    assert.deepEqual(result.hostState[field], expected.equals);
  }
}
results.push({ scenario: "physical-migration-identity-and-skills", status: "passed" });

for (const [name, error] of [
  ["malformed-json", "session.invalid_record"],
  ["unsupported-provider-state", "session.unsupported_provider_state"],
  ["compact-state", "session.unsupported_kind"],
  ["malformed-migration", "session.invalid_migration"],
  ["pending-gate", "session.unsupported_tool_history"],
]) {
  await inspect(join(corpus, name!, "project/.vesicle/sessions/fixture.jsonl"), undefined, error);
  results.push({ scenario: `${name}:rejected`, status: "passed" });
}

for (const [name, error] of [["attachment", undefined], ["missing-attachment", "attachment.read_failed"], ["corrupt-attachment", "attachment.size_mismatch"]] as const) {
  const project = join(corpus, name, "project");
  const result = await inspect(join(project, ".vesicle/sessions/fixture.jsonl"), undefined, error, project);
  if (!error) assert.deepEqual(result.attachmentVerification, { references: 1, files: 1, bytes: 68 });
  results.push({ scenario: `${name}:integrity`, status: "passed" });
}

const sandbox = await mkdtemp(join(tmpdir(), "vesicle-rust-inspection-"));
try {
  const path = join(sandbox, "large.jsonl");
  await writeFile(path, " ".repeat(16 * 1024 * 1024 + 1));
  await inspect(path, undefined, "session.input_too_large");
  await inspect(sandbox, undefined, "session.regular_file_required");
  await inspect(join(sandbox, "missing.jsonl"), undefined, "session.read_failed");
  results.push({ scenario: "bounded-file-errors", status: "passed" });
  await writeFile(path, new Uint8Array([0xff]));
  await inspect(path, undefined, "session.invalid_utf8");
  const literal = { sessionId: "s", ts: "now", role: "user", content: "opaque", metadata: { opaque: { "$serde_json::private::Number": "123" } } };
  await writeFile(path, JSON.stringify(literal));
  const result = await inspect(path);
  assert.deepEqual(result.records[0].metadata, literal.metadata);
  results.push({ scenario: "opaque-object-preserved", status: "passed" });
} finally { await rm(sandbox, { recursive: true, force: true }); }

assert.deepEqual(await treeManifest(corpus), before, "entire original corpus tree must remain unchanged");
results.push({ scenario: "original-corpus-preserved", status: "passed" });
console.log(JSON.stringify({ schemaVersion: 1, platform: process.platform, binary, results }, null, 2));
