import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { baselineDelta } from "../../../scripts/check/migration/baseline";
import { checkEvidence, sha256 } from "../../../scripts/check/migration/check";
import type { BaselineEntry, EvidenceBundle } from "../../../scripts/check/migration/model";

// Protect the acceptance gate against incomplete inventories, forged green
// bookkeeping, stale artifacts and cross-stage evidence. These are file-backed
// corruption tests, not assertions about checker source text.
const tsSha = "a".repeat(40), candidateSha = "b".repeat(40);
let root: string;
let bundle: EvidenceBundle;
let baseline: BaselineEntry[];
let requirements: EvidenceBundle;
async function save(path: string, content: string) {
  await writeFile(join(root, path), content);
  return { path, sha256: sha256(content) };
}
async function result(status = "passed") {
  return save("result.json", JSON.stringify({ schemaVersion: 1, scenarioId: "SC-guard", status, tsSha, rustSha: null, assertions: ["outside unchanged"] }));
}
async function check() { return checkEvidence(bundle, { root, baseline, tsSourceSha: tsSha, requirements, stage: bundle.stage }); }

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "vesicle-evidence-"));
  baseline = [{ id: "FILE:guard.ts", source: "guard.ts", sourceHash: sha256("source"), capabilityIds: ["CAP-FILES-guard"], nonCapabilityReason: null }];
  bundle = {
    schemaVersion: 1, stage: "S0", tsBaselineSha: tsSha, candidateSha,
    baseline: structuredClone(baseline),
    capabilities: [{ id: "CAP-FILES-guard", domain: "files", behavior: "Reject writes outside approved roots", anchors: ["docs/dev/TOOLS.md"], introducedAt: tsSha, tsStatus: "implemented", targetStage: "S2", scenarioIds: ["SC-guard"], conditions: ["all platforms"], implementation: [], verificationIds: [], rustStatus: "not_started" }],
    scenarios: [{ id: "SC-guard", capabilityIds: ["CAP-FILES-guard"], requiredStage: "S0", prerequisites: [], input: await save("input.json", '{"path":"../outside"}'), action: "execute guarded write", assertions: ["outside unchanged"], normalization: [], negativeCase: "outside changes", kind: "offline" }],
    verifications: [{ id: "V-guard", scenarioId: "SC-guard", tsSha, rustSha: null, artifact: await result(), environment: "isolated fixture", toolVersions: ["Bun test"], command: "fixture producer", startedAt: "2026-11-12T00:00:00Z", endedAt: "2026-11-12T00:00:01Z", exitCode: 0, status: "passed", assertions: ["outside unchanged"], log: await save("run.log", "guard rejected path\n"), gapReason: null }],
    differences: [], boundaryGates: [],
  };
  requirements = structuredClone(bundle);
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

describe("migration evidence gate", () => {
  test("accepts complete S0 evidence without pretending Rust is implemented", async () => {
    expect(await check()).toEqual({ ok: true, errors: [], required: 1, passed: 1 });
  });
  test("rejects a removed baseline row independently of submitted inventory", async () => {
    bundle.baseline = [];
    expect((await check()).errors).toContain("missing baseline entry: FILE:guard.ts");
  });
  test("rejects a changed source and exposes new unknown entries in delta", async () => {
    baseline[0]!.sourceHash = sha256("changed");
    baseline.push({ ...baseline[0]!, id: "FILE:new.ts", source: "new.ts" });
    expect(baselineDelta(bundle.baseline, baseline)).toEqual({ added: ["FILE:new.ts"], changed: ["FILE:guard.ts"], removed: [] });
    expect((await check()).ok).toBe(false);
  });
  test("rejects duplicate IDs, empty assertions and dangling CAP references", async () => {
    bundle.scenarios.push(structuredClone(bundle.scenarios[0]!));
    expect((await check()).errors.join()).toContain("duplicate ID");
    bundle.scenarios.pop();
    bundle.scenarios[0]!.assertions = [];
    bundle.baseline[0]!.capabilityIds = ["CAP-missing"];
    expect((await check()).errors.join()).toContain("unknown capability");
    expect((await check()).errors.join()).toContain("missing assertions");
  });
  test("rejects tampered fixture and missing log", async () => {
    await writeFile(join(root, "input.json"), "corrupted");
    await rm(join(root, "run.log"));
    const checked = await check();
    expect(checked.ok).toBe(false);
    expect(checked.errors.join()).toContain("hash mismatch");
    expect(checked.errors.join()).toContain("run.log");
  });
  test.each(["skipped", "unavailable"] as const)("does not count %s as passed", async (status) => {
    bundle.verifications[0]!.status = status;
    bundle.verifications[0]!.exitCode = null;
    bundle.verifications[0]!.gapReason = "fixture environment missing";
    const checked = await check();
    expect(checked.ok).toBe(false);
    expect(checked.passed).toBe(0);
  });
  test("rejects skipped producer result even with green metadata and correct hash", async () => {
    bundle.verifications[0]!.artifact = await result("skipped");
    expect((await check()).errors.join()).toContain("contradicts passed evidence");
  });
  test("rejects SHA drift, missing assertion and unexecuted command", async () => {
    bundle.verifications[0]!.tsSha = candidateSha;
    expect((await check()).errors.join()).toContain("SHA mismatch");
    bundle.verifications[0]!.tsSha = tsSha;
    bundle.verifications[0]!.assertions = [];
    expect((await check()).errors.join()).toContain("required assertion missing");
    bundle.verifications[0]!.exitCode = null;
    expect((await check()).errors.join()).toContain("skipped execution");
  });
  test("does not allow path traversal or symlink escapes in evidence", async () => {
    bundle.scenarios[0]!.input.path = "../outside.json";
    expect((await check()).errors.join()).toContain("unsafe evidence path");
    const outside = await mkdtemp(join(tmpdir(), "vesicle-evidence-outside-"));
    try {
      await writeFile(join(outside, "input.json"), "outside");
      await symlink(join(outside, "input.json"), join(root, "escaped.json"));
      bundle.scenarios[0]!.input.path = "escaped.json";
      expect((await check()).errors.join()).toContain("symlink escapes root");
    } finally { await rm(outside, { recursive: true, force: true }); }
  });
  test("due Rust coverage and prerequisite human gates cannot be bypassed", async () => {
    bundle.stage = "S2";
    const checked = await check();
    expect(checked.errors.join()).toContain("due capability is not_started");
    expect(checked.errors.join()).toContain("missing candidate evidence");
    expect(checked.errors.join()).toContain("H1: missing prerequisite human gate");
  });
  test("future scenarios remain in the denominator without requiring premature execution", async () => {
    bundle.scenarios[0]!.requiredStage = "S2";
    requirements.scenarios[0]!.requiredStage = "S2";
    bundle.verifications = [];
    expect(await check()).toEqual({ ok: true, errors: [], required: 0, passed: 0 });
    bundle.stage = "S2";
    expect((await check()).errors.join()).toContain("required evidence has not passed");
  });
});

describe("reviewed requirements and human observations", () => {
  test("execution reports cannot shrink scope or defer deadlines", async () => {
    bundle.scenarios[0]!.requiredStage = "S6";
    bundle.verifications = [];
    expect((await check()).errors.join()).toContain("reviewed scenarios definition changed");
    bundle.scenarios = [];
    bundle.capabilities = [];
    bundle.baseline[0]!.capabilityIds = [];
    bundle.baseline[0]!.nonCapabilityReason = "silently excluded";
    expect((await check()).errors.join()).toContain("reviewed capabilities definition changed or missing");
    expect((await check()).errors.join()).toContain("reviewed baseline definition changed");
  });
  test("a report cannot select a lower acceptance stage", async () => {
    const checked = await checkEvidence(bundle, { root, baseline, tsSourceSha: tsSha, requirements, stage: "S6" });
    expect(checked.errors.join()).toContain("reported stage differs from requested acceptance stage");
  });
  test("TS evidence never proves Rust verified even during S0", async () => {
    const cap = bundle.capabilities[0]!;
    cap.rustStatus = "verified";
    cap.implementation = ["rust/src/guard.rs"];
    cap.verificationIds = ["V-guard"];
    expect((await check()).errors.join()).toContain("unverified scenario");
  });
  test("due human scenarios require an explicit prepared boundary gate", async () => {
    bundle.scenarios[0]!.kind = "human";
    requirements.scenarios[0]!.kind = "human";
    bundle.verifications = [];
    expect((await check()).errors.join()).toContain("due human scenario has no boundary gate");
    bundle.boundaryGates = [{ id: "H1", requiredBefore: "S2", scenarioIds: ["SC-guard"], package: await save("observe.md", "Run the candidate and inspect the rejected path."), observer: null, candidate: null, candidateSha: null, status: "pending", verificationIds: [] }];
    requirements.boundaryGates = structuredClone(bundle.boundaryGates);
    expect((await check()).ok).toBe(true);
    bundle.stage = "S2";
    expect((await check()).errors.join()).toContain("human gate is not observed and passed");
  });
  test("pending boundary packages still validate their references", async () => {
    bundle.boundaryGates = [{ id: "H1", requiredBefore: "S2", scenarioIds: ["SC-missing"], package: await save("observe.md", "instructions"), observer: null, candidate: null, candidateSha: null, status: "pending", verificationIds: ["V-missing"] }];
    const checked = await check();
    expect(checked.errors.join()).toContain("unknown or non-human scenario");
    expect(checked.errors.join()).toContain("unrelated or missing verification");
  });
  test("observed candidate and instructions are separate artifacts bound to the observation", async () => {
    bundle.scenarios[0]!.kind = "human";
    requirements.scenarios[0]!.kind = "human";
    // A prior-stage observation may refer to an older, explicitly recorded candidate.
    const observedSha = "c".repeat(40);
    bundle.verifications[0]!.rustSha = observedSha;
    bundle.verifications[0]!.artifact = await save("result.json", JSON.stringify({ schemaVersion: 1, scenarioId: "SC-guard", status: "passed", tsSha, rustSha: observedSha, assertions: ["outside unchanged"] }));
    bundle.boundaryGates = [{ id: "H1", requiredBefore: "S2", scenarioIds: ["SC-guard"], package: await save("observe.md", "instructions"), observer: "fixture observer", candidate: await save("candidate.bin", "synthetic candidate"), candidateSha: observedSha, status: "passed", verificationIds: ["V-guard"] }];
    requirements.boundaryGates = structuredClone(bundle.boundaryGates);
    expect((await check()).ok).toBe(true);
    bundle.stage = "S2";
    bundle.capabilities[0]!.rustStatus = "verified";
    bundle.capabilities[0]!.implementation = ["rust/guard.rs"];
    bundle.capabilities[0]!.verificationIds = ["V-guard"];
    expect((await check()).ok).toBe(true);
    bundle.boundaryGates[0]!.candidateSha = candidateSha;
    expect((await check()).errors.join()).toContain("Rust SHA mismatch");
    bundle.boundaryGates[0]!.candidate = null;
    expect((await check()).errors.join()).toContain("missing observed candidate artifact");
  });
});

test("CLI binds a real clean checkout, detects tracked increments and fails on dirty source", async () => {
  if (!Bun.which("git")) throw new Error("Migration CLI integration requires Git on PATH (Bun is the test runner).");
  const { mkdir } = await import("node:fs/promises");
  const { resolve } = await import("node:path");
  const { scanBaseline } = await import("../../../scripts/check/migration/baseline");
  const source = join(root, "source");
  await mkdir(join(source, "src"), { recursive: true });
  await writeFile(join(source, "src", "guard.ts"), "export const syntheticFixture = true;\n");
  async function git(...args: string[]) {
    const child = Bun.spawn(["git", ...args], { cwd: source, stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    if (exit !== 0) throw new Error(stderr);
    return stdout.trim();
  }
  await git("init", "--quiet");
  await git("add", "src");
  await git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgsign=false", "commit", "--quiet", "-m", "synthetic baseline");
  bundle.tsBaselineSha = await git("rev-parse", "HEAD");
  bundle.baseline = await scanBaseline(source);
  for (const row of bundle.baseline) row.capabilityIds = ["CAP-FILES-guard"];
  bundle.verifications[0]!.tsSha = bundle.tsBaselineSha;
  bundle.verifications[0]!.artifact = await save("result.json", JSON.stringify({ schemaVersion: 1, scenarioId: "SC-guard", status: "passed", tsSha: bundle.tsBaselineSha, rustSha: null, assertions: ["outside unchanged"] }));
  await save("coverage.json", JSON.stringify(bundle));
  await save("evidence.json", JSON.stringify(bundle));
  async function cli(command: string) {
    const child = Bun.spawn([process.execPath, resolve("scripts/check/migration/main.ts"), command, source, join(root, "evidence.json"), root, join(root, "coverage.json"), "S0"], { stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    return { stdout, stderr, exit };
  }
  expect((await cli("check")).exit).toBe(0);
  expect((await cli("diff")).exit).toBe(0);
  await writeFile(join(source, "src", "new-entry.ts"), "export const addedEntry = true;\n");
  await git("add", "src");
  expect((await cli("check")).stderr).toContain("tracked modifications");
  await git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgsign=false", "commit", "--quiet", "-m", "new entry");
  const delta = await cli("diff");
  expect(delta.exit).toBe(1);
  expect(JSON.parse(delta.stdout).added).toContain("FILE:src/new-entry.ts");
  expect((await cli("check")).exit).toBe(1);
});

test("known regressions cannot disappear and resolution needs passing observations", async () => {
  bundle.differences = [{ id: "DIFF-guard", capabilityId: "CAP-FILES-guard", oldBehavior: "guard rejects outside writes", newBehavior: "outside write succeeds", classification: "regression", impact: "outside file changed", basis: "TOOLS.md relative-path boundary", ownerDecision: null, scenarioIds: ["SC-guard"], status: "open" }];
  requirements.differences = structuredClone(bundle.differences);
  expect((await check()).errors.join()).toContain("unresolved regression");
  bundle.differences = [];
  expect((await check()).errors.join()).toContain("reviewed difference changed or missing");
  bundle.differences = structuredClone(requirements.differences);
  bundle.differences[0]!.status = "resolved";
  expect((await check()).ok).toBe(true);
  bundle.verifications = [];
  expect((await check()).errors.join()).toContain("resolved difference lacks passing evidence");
});

test("versioned evidence rejects unknown root and nested fields", async () => {
  const options = { root, baseline, requirements, tsSourceSha: tsSha, stage: bundle.stage };
  expect((await checkEvidence({ ...bundle, passed: true }, options)).errors.join()).toContain("unknown field passed");
  const bad = structuredClone(bundle) as unknown as Record<string, unknown>;
  bad.verifications = [{ ...bundle.verifications[0], assumedPassed: true }];
  expect((await checkEvidence(bad, options)).errors.join()).toContain("unknown field assumedPassed");
  bundle.scenarios[0]!.input = { ...bundle.scenarios[0]!.input, ignoredHash: "wrong" } as typeof bundle.scenarios[0]["input"];
  expect((await check()).errors.join()).toContain("unknown field ignoredHash");
});
