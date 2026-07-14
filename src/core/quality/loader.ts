import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import type {
  QualityDetectorRule,
  QualityMatcher,
  QualityRulePackManifest,
  QualityRuntimeContext,
  QualityRuntimeSource,
} from "./types";

const sha256Pattern = /^[a-f0-9]{64}$/;
const semverPattern = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;
const safeArtifactPattern = /^(?:[A-Za-z0-9._-]+\/)*[A-Za-z0-9._-]+$/;
const requiredProtectedRegions = [
  "markdown-fenced-code",
  "markdown-blockquote",
  "html-comment",
  "prism-hud",
  "host-provided-ranges",
] as const;

export async function loadQualityRuntime(source: QualityRuntimeSource): Promise<QualityRuntimeContext> {
  const module = source.manifest.ruleModules.find((entry) => entry.id === "anti-ai-flavor");
  if (!module) throw new Error("Harness Pack does not declare the anti-ai-flavor Rule Pack.");
  const moduleDirectory = dirname(resolvePackPath(source.directory, module.manifest));
  const manifest = parseRulePackManifest(await readJson(resolvePackPath(source.directory, module.manifest), "anti-ai-flavor Rule Pack manifest"));
  await verifyRulePackArtifacts(moduleDirectory, manifest);
  await validatePublishedSchemas(moduleDirectory, manifest);
  const rules = (await Promise.all(Object.keys(manifest.artifacts)
    .filter((path) => /^detector-rules\.[A-Za-z0-9-]+\.json$/.test(path))
    .sort()
    .map(async (path) => parseDetectorRules(await readJson(resolveModulePath(moduleDirectory, path), `Detector rules ${path}`), manifest.module))))
    .flat();
  if (rules.length !== manifest.projectionCounts.detector) {
    throw new Error(`Rule Pack detector count mismatch: manifest=${manifest.projectionCounts.detector}, loaded=${rules.length}.`);
  }
  if (new Set(rules.map((rule) => rule.id)).size !== rules.length) {
    throw new Error("Rule Pack detector rule ids must be unique across languages.");
  }
  return {
    packDirectory: source.directory,
    packId: source.manifest.id,
    packVersion: source.manifest.version,
    sourceCommit: source.manifest.sourceCommit,
    manifestSha256: source.manifestSha256,
    ruleManifest: manifest,
    rules,
    engineModes: Object.fromEntries(Object.entries(source.manifest.qualityBindings)
      .map(([owner, bindings]) => [owner, bindings["anti-ai-flavor"] ?? "off"])),
    agentModes: Object.fromEntries(Object.entries(source.manifest.agentQualityBindings)
      .map(([owner, bindings]) => [owner, bindings["anti-ai-flavor"] ?? "off"])),
  };
}

async function verifyRulePackArtifacts(moduleDirectory: string, manifest: QualityRulePackManifest): Promise<void> {
  for (const [path, expected] of Object.entries(manifest.artifacts)) {
    const bytes = await readFile(resolveModulePath(moduleDirectory, path)).catch((error: unknown) => {
      throw new Error(`Cannot load Rule Pack artifact ${path}: ${error instanceof Error ? error.message : String(error)}`);
    });
    const actual = createHash("sha256").update(bytes).digest("hex");
    if (actual !== expected) throw new Error(`Rule Pack artifact hash mismatch: ${path}.`);
  }
}

export function parseRulePackManifest(value: unknown): QualityRulePackManifest {
  const raw = strictObject(value, "Rule Pack manifest", [
    "schema", "module", "version", "primaryLanguage", "sourceRepository", "sourceCommit", "sourceState",
    "sourceHash", "moduleInputHash", "compilerHash", "ruleCount", "projectionCounts", "requiredCapabilities",
    "preprocessing", "sources", "corpora", "artifacts",
  ]);
  if (raw.schema !== "rule-pack/v1") throw new Error("Unsupported Rule Pack schema.");
  if (raw.module !== "anti-ai-flavor") throw new Error("Rule Pack module must be anti-ai-flavor.");
  const version = stringValue(raw.version, "Rule Pack version");
  if (!semverPattern.test(version)) throw new Error("Rule Pack version must be SemVer.");
  const sourceState = stringValue(raw.sourceState, "Rule Pack sourceState");
  if (sourceState !== "clean" && sourceState !== "dirty") throw new Error("Rule Pack sourceState is invalid.");
  if (sourceState !== "clean") throw new Error("Rule Pack sourceState must be clean.");
  const projectionCountsRaw = strictObject(raw.projectionCounts, "Rule Pack projectionCounts", ["guidance", "detector", "judge", "replacement"]);
  const preprocessingRaw = strictObject(raw.preprocessing, "Rule Pack preprocessing", [
    "line_endings", "unicode_normalization", "offset_basis", "protected_regions",
  ]);
  if (preprocessingRaw.line_endings !== "LF" || preprocessingRaw.unicode_normalization !== "NFC"
    || preprocessingRaw.offset_basis !== "normalized-candidate") {
    throw new Error("Rule Pack preprocessing contract is unsupported.");
  }
  const protectedRegions = stringList(preprocessingRaw.protected_regions, "Rule Pack protected_regions");
  if (protectedRegions.length !== requiredProtectedRegions.length
    || requiredProtectedRegions.some((region) => !protectedRegions.includes(region))) {
    throw new Error("Rule Pack protected_regions contract is unsupported.");
  }
  const requiredCapabilities = stringList(raw.requiredCapabilities, "Rule Pack requiredCapabilities");
  if (!requiredCapabilities.includes("quality-guard/anti-ai-flavor@1")) {
    throw new Error("Rule Pack does not require quality-guard/anti-ai-flavor@1.");
  }
  const artifactsRaw = objectValue(raw.artifacts, "Rule Pack artifacts");
  const artifacts: Record<string, string> = {};
  for (const [path, hash] of Object.entries(artifactsRaw)) {
    if (!safeArtifactPattern.test(path)) throw new Error(`Unsafe Rule Pack artifact path: ${path}.`);
    const parsedHash = stringValue(hash, `Rule Pack artifact hash ${path}`);
    if (!sha256Pattern.test(parsedHash)) throw new Error(`Invalid Rule Pack artifact hash: ${path}.`);
    artifacts[path] = parsedHash;
  }
  if (!Array.isArray(raw.sources)) throw new Error("Rule Pack sources must be a list.");
  const sourceIds = raw.sources.map((value, index) => {
    const source = objectValue(value, `Rule Pack source ${index + 1}`);
    return {
      id: stringValue(source.id, `Rule Pack source ${index + 1} id`),
      status: stringValue(source.status, `Rule Pack source ${index + 1} status`),
    };
  });
  if (new Set(sourceIds.map((source) => source.id)).size !== sourceIds.length) {
    throw new Error("Rule Pack source ids must be unique.");
  }
  const corpora = objectValue(raw.corpora, "Rule Pack corpora");
  for (const [name, value] of Object.entries(corpora)) {
    const corpus = strictObject(value, `Rule Pack corpus ${name}`, ["cases", "hash"]);
    positiveInteger(corpus.cases, `Rule Pack corpus ${name} cases`);
    const hash = hashValue(corpus.hash, `Rule Pack corpus ${name} hash`);
    const artifact = `calibration/${name}.jsonl`;
    if (artifacts[artifact] !== hash) throw new Error(`Rule Pack corpus ${name} hash does not match ${artifact}.`);
  }
  const manifest: QualityRulePackManifest = {
    schema: "rule-pack/v1",
    module: "anti-ai-flavor",
    version,
    primaryLanguage: stringValue(raw.primaryLanguage, "Rule Pack primaryLanguage"),
    sourceRepository: stringValue(raw.sourceRepository, "Rule Pack sourceRepository"),
    sourceCommit: stringValue(raw.sourceCommit, "Rule Pack sourceCommit"),
    sourceState,
    sourceHash: hashValue(raw.sourceHash, "Rule Pack sourceHash"),
    moduleInputHash: hashValue(raw.moduleInputHash, "Rule Pack moduleInputHash"),
    compilerHash: hashValue(raw.compilerHash, "Rule Pack compilerHash"),
    ruleCount: positiveInteger(raw.ruleCount, "Rule Pack ruleCount"),
    projectionCounts: {
      guidance: nonNegativeInteger(projectionCountsRaw.guidance, "Rule Pack guidance count"),
      detector: nonNegativeInteger(projectionCountsRaw.detector, "Rule Pack detector count"),
      judge: nonNegativeInteger(projectionCountsRaw.judge, "Rule Pack judge count"),
      replacement: nonNegativeInteger(projectionCountsRaw.replacement, "Rule Pack replacement count"),
    },
    requiredCapabilities,
    preprocessing: {
      line_endings: "LF",
      unicode_normalization: "NFC",
      offset_basis: "normalized-candidate",
      protected_regions: protectedRegions,
    },
    artifacts,
  };
  return manifest;
}

export function parseDetectorRules(value: unknown, expectedModule = "anti-ai-flavor"): QualityDetectorRule[] {
  const raw = strictObject(value, "Detector rules", ["schema", "module", "language", "rules"]);
  if (raw.schema !== "detector-rules/v1") throw new Error("Unsupported Detector rules schema.");
  if (raw.module !== expectedModule) throw new Error("Detector rules module does not match the Rule Pack.");
  const language = stringValue(raw.language, "Detector rules language");
  if (!Array.isArray(raw.rules) || raw.rules.length === 0) throw new Error("Detector rules must be a non-empty list.");
  return raw.rules.map((value, index) => parseDetectorRule(value, language, index));
}

function parseDetectorRule(value: unknown, language: string, index: number): QualityDetectorRule {
  const raw = strictObject(value, `Detector rule ${index + 1}`, [
    "id", "tier", "lang", "title", "severity", "maturity", "targets", "matcher", "source",
  ]);
  const lang = stringValue(raw.lang, `Detector rule ${index + 1} lang`);
  if (lang !== language) throw new Error(`Detector rule ${index + 1} language does not match its file.`);
  const maturity = stringValue(raw.maturity, `Detector rule ${index + 1} maturity`);
  if (maturity !== "stable" && maturity !== "experimental") throw new Error(`Detector rule ${index + 1} maturity is invalid.`);
  return {
    id: stringValue(raw.id, `Detector rule ${index + 1} id`),
    tier: stringValue(raw.tier, `Detector rule ${index + 1} tier`),
    lang,
    title: stringValue(raw.title, `Detector rule ${index + 1} title`),
    severity: stringValue(raw.severity, `Detector rule ${index + 1} severity`),
    maturity,
    targets: stringList(raw.targets, `Detector rule ${index + 1} targets`),
    matcher: parseMatcher(raw.matcher, index),
    source: stringValue(raw.source, `Detector rule ${index + 1} source`),
  };
}

function parseMatcher(value: unknown, index: number): QualityMatcher {
  const raw = objectValue(value, `Detector rule ${index + 1} matcher`);
  const kind = stringValue(raw.kind, `Detector rule ${index + 1} matcher kind`);
  const unit = stringValue(raw.unit, `Detector rule ${index + 1} matcher unit`);
  if (unit !== "candidate" && unit !== "paragraph" && unit !== "sentence") {
    throw new Error(`Detector rule ${index + 1} matcher unit is invalid.`);
  }
  if (kind === "literal" || kind === "regex") {
    strictKeys(raw, `Detector rule ${index + 1} matcher`, kind === "regex" ? ["kind", "value", "unit", "flags"] : ["kind", "value", "unit"]);
    const matcher: QualityMatcher = {
      kind,
      value: stringValue(raw.value, `Detector rule ${index + 1} matcher value`),
      unit,
      ...(kind === "regex" && raw.flags !== undefined ? { flags: stringValue(raw.flags, `Detector rule ${index + 1} matcher flags`) } : {}),
    };
    if (matcher.kind === "regex") {
      if (!/^[dimsuv]*$/.test(matcher.flags ?? "") || /[gy]/.test(matcher.flags ?? "")) {
        throw new Error(`Detector rule ${index + 1} regex flags are unsupported.`);
      }
      try {
        new RegExp(matcher.value, matcher.flags);
      } catch (error) {
        throw new Error(`Detector rule ${index + 1} regex is invalid: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    return matcher;
  }
  if (kind !== "metric") throw new Error(`Detector rule ${index + 1} matcher kind is unsupported.`);
  strictKeys(raw, `Detector rule ${index + 1} matcher`, ["kind", "unit", "metric"]);
  const metric = strictObject(raw.metric, `Detector rule ${index + 1} metric`, ["signal", "operator", "threshold"]);
  if (metric.signal !== "em_dash_per_100_chars") throw new Error(`Detector rule ${index + 1} metric signal is unsupported.`);
  if (metric.operator !== "gte" && metric.operator !== "gt" && metric.operator !== "lte" && metric.operator !== "lt") {
    throw new Error(`Detector rule ${index + 1} metric operator is unsupported.`);
  }
  if (typeof metric.threshold !== "number" || !Number.isFinite(metric.threshold)) {
    throw new Error(`Detector rule ${index + 1} metric threshold is invalid.`);
  }
  return {
    kind: "metric",
    unit,
    metric: { signal: "em_dash_per_100_chars", operator: metric.operator, threshold: metric.threshold },
  };
}

async function validatePublishedSchemas(moduleDirectory: string, manifest: QualityRulePackManifest): Promise<void> {
  const expected = [
    ["schemas/rule-pack.schema.json", "Rule Pack Manifest v1"],
    ["schemas/detector-rules.schema.json", "Detector Rules v1"],
    ["schemas/host-conformance-case.schema.json", "Rule Host Conformance Case v1"],
  ] as const;
  for (const [path, title] of expected) {
    if (!manifest.artifacts[path]) throw new Error(`Rule Pack is missing published schema ${path}.`);
    const schema = objectValue(await readJson(resolveModulePath(moduleDirectory, path), `Published schema ${path}`), `Published schema ${path}`);
    if (schema.$schema !== "https://json-schema.org/draft/2020-12/schema" || schema.title !== title
      || schema.type !== "object" || schema.additionalProperties !== false || !Array.isArray(schema.required)) {
      throw new Error(`Published schema ${path} has an unsupported contract.`);
    }
  }
}

async function readJson(path: string, label: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as unknown;
  } catch (error) {
    throw new Error(`Cannot load ${label}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function resolvePackPath(root: string, path: string): string {
  return resolveContained(root, path, "Harness Pack");
}

function resolveModulePath(root: string, path: string): string {
  return resolveContained(root, path, "Rule Pack");
}

function resolveContained(root: string, path: string, label: string): string {
  if (!safeArtifactPattern.test(path)) throw new Error(`Unsafe ${label} path: ${path}.`);
  const absolute = resolve(root, ...path.split("/"));
  const rel = relative(resolve(root), absolute);
  if (rel === ".." || rel.startsWith(`..${sep}`)) throw new Error(`${label} path escapes its root: ${path}.`);
  return absolute;
}

function strictObject(value: unknown, label: string, keys: string[]): Record<string, unknown> {
  const raw = objectValue(value, label);
  strictKeys(raw, label, keys);
  for (const key of keys) if (!Object.hasOwn(raw, key)) throw new Error(`${label} is missing ${key}.`);
  return raw;
}

function strictKeys(raw: Record<string, unknown>, label: string, keys: string[]): void {
  const allowed = new Set(keys);
  const extra = Object.keys(raw).find((key) => !allowed.has(key));
  if (extra) throw new Error(`${label} contains unknown field ${extra}.`);
}

function objectValue(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object.`);
  return value as Record<string, unknown>;
}

function stringValue(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) throw new Error(`${label} must be a non-empty string.`);
  return value;
}

function stringList(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string" || entry.length === 0)) {
    throw new Error(`${label} must be a list of non-empty strings.`);
  }
  const result = value as string[];
  if (new Set(result).size !== result.length) throw new Error(`${label} must contain unique values.`);
  return result;
}

function positiveInteger(value: unknown, label: string): number {
  if (!Number.isInteger(value) || Number(value) < 1) throw new Error(`${label} must be a positive integer.`);
  return Number(value);
}

function nonNegativeInteger(value: unknown, label: string): number {
  if (!Number.isInteger(value) || Number(value) < 0) throw new Error(`${label} must be a non-negative integer.`);
  return Number(value);
}

function hashValue(value: unknown, label: string): string {
  const hash = stringValue(value, label);
  if (!sha256Pattern.test(hash)) throw new Error(`${label} must be a SHA-256 hash.`);
  return hash;
}
