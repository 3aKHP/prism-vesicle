import { createHash } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { isDeepStrictEqual } from "node:util";
import type { BaselineEntry, EvidenceBundle, HashedFile, Stage, Verification } from "./model";
import { parseEvidence } from "./parse";

export interface CheckOptions {
  root: string;
  tsSourceSha: string;
  stage: Stage;
  /** Reviewed definitions, supplied independently from mutable execution evidence. */
  requirements: Pick<EvidenceBundle, "capabilities" | "scenarios" | "baseline" | "boundaryGates" | "differences">;
  /** Independently scanned source inventory, never copied from the submitted evidence. */
  baseline: BaselineEntry[];
}
export interface CheckResult { ok: boolean; errors: string[]; required: number; passed: number }
export function sha256(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}
function due(stage: string, current: string) { return Number(stage.slice(1)) <= Number(current.slice(1)); }

async function readHashed(root: string, file: HashedFile): Promise<Buffer> {
  if (isAbsolute(file.path) || file.path.split(/[\\/]/).includes("..")) throw new Error(`unsafe evidence path: ${file.path}`);
  const canonicalRoot = await realpath(root);
  const path = await realpath(resolve(canonicalRoot, file.path));
  const rel = relative(canonicalRoot, path);
  if (isAbsolute(rel) || rel === ".." || rel.startsWith(`..${sep}`)) throw new Error(`evidence symlink escapes root: ${file.path}`);
  const bytes = await readFile(path);
  if (sha256(bytes) !== file.sha256) throw new Error(`hash mismatch: ${file.path}`);
  if (!bytes.length) throw new Error(`empty evidence file: ${file.path}`);
  return bytes;
}

function checkReferences(bundle: EvidenceBundle, baseline: BaselineEntry[]): string[] {
  const errors: string[] = [];
  const caps = new Map(bundle.capabilities.map((c) => [c.id, c]));
  const scenarios = new Map(bundle.scenarios.map((s) => [s.id, s]));
  const verifications = new Map(bundle.verifications.map((v) => [v.id, v]));
  const entries = new Map(bundle.baseline.map((b) => [b.id, b]));
  if (!caps.size || !scenarios.size || !baseline.length) errors.push("empty capability, scenario or independent baseline inventory");
  const expectedIds = new Set(baseline.map((b) => b.id));
  for (const expected of baseline) {
    const row = entries.get(expected.id);
    if (!row) { errors.push(`missing baseline entry: ${expected.id}`); continue; }
    if (row.source !== expected.source || row.sourceHash !== expected.sourceHash) errors.push(`baseline changed: ${row.id}`);
  }
  for (const b of bundle.baseline) {
    if (!expectedIds.has(b.id)) errors.push(`baseline entry no longer scanned: ${b.id}`);
    if (Boolean(b.capabilityIds.length) === Boolean(b.nonCapabilityReason)) errors.push(`baseline disposition must be capability OR non-capability: ${b.id}`);
    for (const id of b.capabilityIds) if (!caps.has(id)) errors.push(`${b.id}: unknown capability ${id}`);
  }
  for (const cap of caps.values()) {
    if (!cap.anchors.length || !cap.conditions.length || !cap.scenarioIds.length) errors.push(`${cap.id}: missing anchors, conditions or scenarios`);
    if (cap.kind === "infrastructure") {
      if (cap.rustStatus !== "not_started") errors.push(`${cap.id}: infrastructure must not claim Rust implementation status`);
    } else if (due(cap.targetStage, bundle.stage) && cap.rustStatus !== "verified") errors.push(`${cap.id}: due capability is ${cap.rustStatus}`);
    if (cap.rustStatus === "verified" && (!cap.implementation.length || !cap.verificationIds.length)) errors.push(`${cap.id}: verified without implementation/evidence`);
    for (const id of cap.scenarioIds) {
      const scenario = scenarios.get(id);
      if (!scenario || !scenario.capabilityIds.includes(cap.id)) errors.push(`${cap.id}: missing reciprocal scenario ${id}`);
      if (scenario && !due(scenario.requiredStage, cap.targetStage)) errors.push(`${cap.id}: scenario ${id} scheduled after capability deadline`);
      if (cap.rustStatus === "verified" && !cap.verificationIds.some((vid) => verifications.get(vid)?.scenarioId === id && verifications.get(vid)?.status === "passed" && verifications.get(vid)?.rustSha === expectedCandidate(bundle, id))) errors.push(`${cap.id}: unverified scenario ${id}`);
    }
    for (const id of cap.verificationIds) {
      const v = verifications.get(id);
      if (!v || !cap.scenarioIds.includes(v.scenarioId)) errors.push(`${cap.id}: unrelated or missing verification ${id}`);
    }
  }
  for (const s of scenarios.values()) {
    if (!s.assertions.length || !s.capabilityIds.length) errors.push(`${s.id}: missing assertions or capabilities`);
    const infrastructure = s.capabilityIds.filter((id) => caps.get(id)?.kind === "infrastructure");
    if (infrastructure.length && infrastructure.length !== s.capabilityIds.length) errors.push(`${s.id}: infrastructure and preservation ownership must be separate`);
    for (const id of s.capabilityIds) if (!caps.get(id)?.scenarioIds.includes(s.id)) errors.push(`${s.id}: missing reciprocal capability ${id}`);
  }
  for (const v of verifications.values()) if (!scenarios.has(v.scenarioId)) errors.push(`${v.id}: unknown scenario ${v.scenarioId}`);
  for (const d of bundle.differences) {
    if (!caps.has(d.capabilityId)) errors.push(`${d.id}: unknown capability`);
    if (!d.scenarioIds.length || d.scenarioIds.some((id) => !scenarios.get(id)?.capabilityIds.includes(d.capabilityId))) errors.push(`${d.id}: missing related scenarios`);
    if (d.classification === "regression" && d.status === "open") errors.push(`${d.id}: unresolved regression`);
  }
  return errors;
}


function expectedCandidate(bundle: EvidenceBundle, scenarioId: string): string {
  const scenario = bundle.scenarios.find((s) => s.id === scenarioId);
  const gate = scenario?.kind === "human" ? bundle.boundaryGates.find((g) => g.scenarioIds.includes(scenarioId)) : undefined;
  return gate?.candidateSha ?? bundle.candidateSha;
}

async function checkVerification(v: Verification, bundle: EvidenceBundle, root: string): Promise<void> {
  const bytes = await readHashed(root, v.artifact);
  await readHashed(root, v.log);
  if (v.tsSha !== bundle.tsBaselineSha) throw new Error(`${v.id}: TS SHA mismatch`);
  const candidate = expectedCandidate(bundle, v.scenarioId);
  if (v.rustSha !== null && v.rustSha !== candidate) throw new Error(`${v.id}: Rust SHA mismatch`);
  if (!v.toolVersions.length) throw new Error(`${v.id}: missing tool versions`);
  if (v.status !== "passed") {
    if (!v.gapReason) throw new Error(`${v.id}: non-passing evidence needs a gap reason`);
    return;
  }
  if (v.exitCode !== 0 || v.gapReason !== null) throw new Error(`${v.id}: passed with failure, skipped execution or gap`);
  const scenario = bundle.scenarios.find((s) => s.id === v.scenarioId);
  // Infrastructure observations cannot prove a ported feature. Human evidence
  // always names its observed candidate, even when owned by an acceptance CAP.
  const infrastructure = scenario && scenario.kind !== "human" && scenario.capabilityIds.length > 0
    && scenario.capabilityIds.every((id) => bundle.capabilities.find((c) => c.id === id)?.kind === "infrastructure");
  // A preparation/CI observation may name a real candidate (already checked
  // above). Allowing TS-only infrastructure evidence does not discard provenance.
  if (!infrastructure && bundle.stage !== "S0" && v.rustSha !== candidate) throw new Error(`${v.id}: missing candidate evidence`);
  const required = bundle.scenarios.find((s) => s.id === v.scenarioId)?.assertions ?? [];
  if (required.some((a) => !v.assertions.includes(a))) throw new Error(`${v.id}: required assertion missing`);
  // The producer's result is independent of the verifier's bookkeeping. A skipped
  // result must not become green simply by changing VERIFICATION metadata.
  const result: unknown = JSON.parse(bytes.toString("utf8"));
  if (!result || typeof result !== "object") throw new Error(`${v.id}: invalid result artifact`);
  const r = result as Record<string, unknown>;
  const assertions = r.assertions;
  if (r.schemaVersion !== 1 || r.status !== "passed" || r.scenarioId !== v.scenarioId || r.tsSha !== v.tsSha || r.rustSha !== v.rustSha || !Array.isArray(assertions) || required.some((a) => !assertions.includes(a))) throw new Error(`${v.id}: result artifact contradicts passed evidence`);
}

async function checkBoundaryGates(bundle: EvidenceBundle, root: string): Promise<string[]> {
  const errors: string[] = [];
  for (const [id, before] of [["H1", "S2"], ["H4", "S5"], ["H5", "S6"]]) {
    const gate = bundle.boundaryGates.find((g) => g.id === id);
    if (!gate) { if (due(before, bundle.stage)) errors.push(`${id}: missing prerequisite human gate`); continue; }
    if (gate.requiredBefore !== before) errors.push(`${id}: wrong prerequisite stage`);
    try { await readHashed(root, gate.package); } catch (error) { errors.push(String(error)); }
    for (const sid of gate.scenarioIds) if (bundle.scenarios.find((s) => s.id === sid)?.kind !== "human") errors.push(`${id}: unknown or non-human scenario ${sid}`);
    for (const vid of gate.verificationIds) if (!bundle.verifications.some((v) => v.id === vid && gate.scenarioIds.includes(v.scenarioId))) errors.push(`${id}: unrelated or missing verification ${vid}`);
    if (gate.candidate) {
      try { await readHashed(root, gate.candidate); } catch (error) { errors.push(String(error)); }
    }
    if (gate.status === "passed" || due(before, bundle.stage)) {
      if (gate.status !== "passed" || !gate.observer || !gate.scenarioIds.length) errors.push(`${id}: human gate is not observed and passed`);
      if (!gate.candidate || !gate.candidateSha) errors.push(`${id}: missing observed candidate artifact or commit`);
      for (const sid of gate.scenarioIds) {
        const scenario = bundle.scenarios.find((s) => s.id === sid);
        // Missing/non-human references already have a precise diagnostic above.
        if (!scenario || scenario.kind !== "human") continue;
        if (!gate.verificationIds.some((vid) => bundle.verifications.some((v) => v.id === vid && v.scenarioId === sid && v.status === "passed" && v.rustSha === gate.candidateSha))) errors.push(`${id}: missing human evidence for ${sid}`);
      }
    }
  }
  return errors;
}

/** Checks the evidence contract, not the truth of an untrusted producer's assertions. */
export async function checkEvidence(value: unknown, options: CheckOptions): Promise<CheckResult> {
  let bundle: EvidenceBundle;
  try { bundle = parseEvidence(value); } catch (error) { return { ok: false, errors: [String(error)], required: 0, passed: 0 }; }
  const errors = checkReferences(bundle, options.baseline);
  if (bundle.stage !== options.stage) errors.push("reported stage differs from requested acceptance stage");
  errors.push(...checkRequirements(bundle, options.requirements));
  if (bundle.tsBaselineSha !== options.tsSourceSha) errors.push("baseline checkout SHA differs from declared TS baseline");
  for (const scenario of bundle.scenarios) {
    if (scenario.kind === "human" && due(scenario.requiredStage, bundle.stage) && !bundle.boundaryGates.some((g) => g.scenarioIds.includes(scenario.id))) errors.push(`${scenario.id}: due human scenario has no boundary gate`);
    try { await readHashed(options.root, scenario.input); } catch (error) { errors.push(`${scenario.id}: ${String(error)}`); }
  }
  const valid = new Set<string>();
  for (const v of bundle.verifications) {
    try { await checkVerification(v, bundle, options.root); if (v.status === "passed") valid.add(v.id); }
    catch (error) { errors.push(String(error)); }
  }
  for (const d of bundle.differences) {
    if (d.status === "resolved" && d.scenarioIds.some((sid) => !bundle.verifications.some((v) => v.scenarioId === sid && valid.has(v.id)))) errors.push(`${d.id}: resolved difference lacks passing evidence`);
  }
  const required = bundle.scenarios.filter((s) => due(s.requiredStage, bundle.stage) && s.kind !== "human");
  let passed = 0;
  for (const s of required) {
    if (bundle.verifications.some((v) => v.scenarioId === s.id && valid.has(v.id))) passed++;
    else errors.push(`${s.id}: required evidence has not passed`);
  }
  errors.push(...await checkBoundaryGates(bundle, options.root));
  return { ok: errors.length === 0, errors, required: required.length, passed };
}

function checkRequirements(bundle: EvidenceBundle, requirements: CheckOptions["requirements"]): string[] {
  const errors: string[] = [];
  // Implementations and evidence evolve; reviewed behavior, scope and deadlines
  // do not change merely because an execution report omits or reclassifies them.
  const definition = ({ implementation: _i, verificationIds: _v, rustStatus: _r, ...cap }: EvidenceBundle["capabilities"][number]) => cap;
  for (const key of ["capabilities", "scenarios", "baseline"] as const) {
    const expected = new Map(requirements[key].map((row) => [row.id, row]));
    const actual = new Map(bundle[key].map((row) => [row.id, row]));
    for (const id of new Set([...expected.keys(), ...actual.keys()])) {
      let a: unknown = actual.get(id), e: unknown = expected.get(id);
      if (key === "capabilities") {
        const ac = bundle.capabilities.find((c) => c.id === id), ec = requirements.capabilities.find((c) => c.id === id);
        a = ac ? definition(ac) : undefined;
        e = ec ? definition(ec) : undefined;
      }
      if (!isDeepStrictEqual(a, e)) errors.push(`reviewed ${key} definition changed or missing: ${id}`);
    }
  }
  const gateDefinitions = (gates: EvidenceBundle["boundaryGates"]) => gates.map(({ id, requiredBefore, scenarioIds }) => ({ id, requiredBefore, scenarioIds })).sort((a, b) => a.id.localeCompare(b.id));
  if (!isDeepStrictEqual(gateDefinitions(bundle.boundaryGates), gateDefinitions(requirements.boundaryGates))) errors.push("reviewed human gate ownership changed or missing");
  for (const expected of requirements.differences) {
    const actual = bundle.differences.find((d) => d.id === expected.id);
    const { status: _expectedStatus, ...definition } = expected;
    const { status: _actualStatus, ...submitted } = actual ?? {};
    if (!isDeepStrictEqual(definition, submitted)) errors.push(`reviewed difference changed or missing: ${expected.id}`);
  }
  return errors;
}
