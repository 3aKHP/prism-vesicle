import type { EvidenceBundle } from "./model";

type ObjectValue = Record<string, unknown>;
function object(value: unknown, at: string): ObjectValue {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${at}: expected object`);
  return value as ObjectValue;
}
function string(value: unknown, at: string): asserts value is string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${at}: expected nonempty string`);
}
function strings(value: unknown, at: string) {
  if (!Array.isArray(value)) throw new Error(`${at}: expected array`);
  for (const item of value) string(item, at);
  if (new Set(value).size !== value.length) throw new Error(`${at}: duplicate value`);
}
function fields(row: ObjectValue, names: string[], at: string) {
  for (const name of names) string(row[name], `${at}.${name}`);
}
function lists(row: ObjectValue, names: string[], at: string) {
  for (const name of names) strings(row[name], `${at}.${name}`);
}
function nullableString(value: unknown, at: string) { if (value !== null) string(value, at); }
function choice(value: unknown, choices: string[], at: string) {
  if (typeof value !== "string" || !choices.includes(value)) throw new Error(`${at}: invalid value`);
}
function hash(value: unknown, length: number, at: string) {
  if (typeof value !== "string" || !new RegExp(`^[a-f0-9]{${length}}$`).test(value)) throw new Error(`${at}: invalid hash`);
}
function file(value: unknown, at: string) {
  const row = object(value, at);
  string(row.path, `${at}.path`);
  hash(row.sha256, 64, `${at}.sha256`);
}
const stages = ["S0", "S1", "S2", "S3", "S4", "S5", "S6"];
function rows(value: unknown, at: string, check: (row: ObjectValue, at: string) => void) {
  if (!Array.isArray(value)) throw new Error(`${at}: expected array`);
  const ids = new Set<string>();
  for (const [index, valueRow] of value.entries()) {
    const location = `${at}[${index}]`;
    const row = object(valueRow, location);
    string(row.id, `${location}.id`);
    if (ids.has(row.id)) throw new Error(`${at}: duplicate ID ${row.id}`);
    ids.add(row.id);
    check(row, location);
  }
}

/** Reject malformed external evidence before checking references or reading its files. */
export function parseEvidence(value: unknown): EvidenceBundle {
  const root = object(value, "evidence");
  if (root.schemaVersion !== 1) throw new Error("evidence: unsupported schemaVersion");
  choice(root.stage, stages, "stage");
  hash(root.tsBaselineSha, 40, "tsBaselineSha");
  hash(root.candidateSha, 40, "candidateSha");
  rows(root.capabilities, "capabilities", (r, at) => {
    fields(r, ["domain", "behavior", "introducedAt"], at);
    lists(r, ["anchors", "scenarioIds", "conditions", "implementation", "verificationIds"], at);
    choice(r.tsStatus, ["implemented", "experimental"], `${at}.tsStatus`);
    choice(r.targetStage, stages, `${at}.targetStage`);
    choice(r.rustStatus, ["not_started", "partial", "implemented", "verified"], `${at}.rustStatus`);
  });
  rows(root.scenarios, "scenarios", (r, at) => {
    lists(r, ["capabilityIds", "prerequisites", "assertions", "normalization"], at);
    fields(r, ["action", "negativeCase"], at);
    file(r.input, `${at}.input`);
    choice(r.requiredStage, stages, `${at}.requiredStage`);
    choice(r.kind, ["offline", "live", "native", "human"], `${at}.kind`);
  });
  rows(root.baseline, "baseline", (r, at) => {
    string(r.source, `${at}.source`);
    hash(r.sourceHash, 64, `${at}.sourceHash`);
    lists(r, ["capabilityIds"], at);
    nullableString(r.nonCapabilityReason, `${at}.nonCapabilityReason`);
  });
  rows(root.verifications, "verifications", (r, at) => {
    fields(r, ["scenarioId", "environment", "command", "startedAt", "endedAt"], at);
    lists(r, ["toolVersions", "assertions"], at);
    hash(r.tsSha, 40, `${at}.tsSha`);
    if (r.rustSha !== null) hash(r.rustSha, 40, `${at}.rustSha`);
    file(r.artifact, `${at}.artifact`);
    file(r.log, `${at}.log`);
    choice(r.status, ["passed", "failed", "skipped", "unavailable"], `${at}.status`);
    nullableString(r.gapReason, `${at}.gapReason`);
    if (r.exitCode !== null && !Number.isInteger(r.exitCode)) throw new Error(`${at}.exitCode: expected integer or null`);
    const start = Date.parse(String(r.startedAt)), end = Date.parse(String(r.endedAt));
    if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) throw new Error(`${at}: invalid time interval`);
  });
  rows(root.differences, "differences", (r, at) => {
    fields(r, ["capabilityId", "oldBehavior", "newBehavior", "impact", "basis"], at);
    if (!String(r.id).startsWith("DIFF-")) throw new Error(`${at}: expected DIFF- ID`);
    choice(r.classification, ["regression", "fix", "addition"], `${at}.classification`);
    choice(r.status, ["open", "resolved"], `${at}.status`);
    nullableString(r.ownerDecision, `${at}.ownerDecision`);
    lists(r, ["scenarioIds"], at);
  });
  rows(root.boundaryGates, "boundaryGates", (r, at) => {
    choice(r.id, ["H1", "H4", "H5"], `${at}.id`);
    choice(r.requiredBefore, stages, `${at}.requiredBefore`);
    lists(r, ["scenarioIds", "verificationIds"], at);
    file(r.package, `${at}.package`);
    nullableString(r.observer, `${at}.observer`);
    if (r.candidate !== null) file(r.candidate, `${at}.candidate`);
    if (r.candidateSha !== null) hash(r.candidateSha, 40, `${at}.candidateSha`);
    choice(r.status, ["pending", "passed", "failed"], `${at}.status`);
  });
  // Every field consumed by the checker has been validated above.
  return root as unknown as EvidenceBundle;
}
