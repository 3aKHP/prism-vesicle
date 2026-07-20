import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";
import { RegExpParser, visitRegExpAST, type AST } from "@eslint-community/regexpp";
import type {
  QualityDetectorRule,
  QualityJudgeRule,
  QualityMetric,
  QualityMetricPattern,
  QualityMatcher,
  QualityRulePackManifest,
  QualityRuntimeContext,
  QualityRuntimeSource,
  QualitySemanticRewritePolicy,
  QualitySemanticRewriteModelScope,
} from "./types";
import { isDocumentMetricSignal, isQualityMetricSignal } from "./metrics";

const sha256Pattern = /^[a-f0-9]{64}$/;
const semverPattern = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;
const safeArtifactPattern = /^(?:[A-Za-z0-9._-]+\/)*[A-Za-z0-9._-]+$/;
const documentMetricsCapability = "quality-detector/document-metrics@1";
const semanticJudgeCapability = "quality-judge/anti-ai-flavor@1";
const semanticRewritePolicyCapability = "quality-policy/semantic-rewrite@1";
const maxMetricPatterns = 64;
const maxMetricPatternLength = 2_048;
const maxMetricPatternQuantifiers = 25;
const maxMetricPatternRepetition = 64;
const maxMetricPatternBacktrackingCombinations = 4_096;
const maxMetricPatternBranches = 64;
const maxMetricPatternBranchingGroups = 3;
const metricPatternParser = new RegExpParser({ ecmaVersion: 2025 });
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
  const documentMetricPatternCount = rules.reduce((total, rule) =>
    total + (rule.matcher.kind === "metric" && isDocumentMetricSignal(rule.matcher.metric.signal)
      ? rule.matcher.metric.patterns?.length ?? 0
      : 0), 0);
  if (documentMetricPatternCount > maxMetricPatterns) {
    throw new Error(`Rule Pack document metrics must not contain more than ${maxMetricPatterns} patterns in total.`);
  }
  if (rules.some((rule) => rule.matcher.kind === "metric" && isDocumentMetricSignal(rule.matcher.metric.signal))
    && !manifest.requiredCapabilities.includes(documentMetricsCapability)) {
    throw new Error(`Rule Pack document metrics require ${documentMetricsCapability}.`);
  }
  const judge = manifest.requiredCapabilities.includes(semanticJudgeCapability)
    ? await loadJudgeContract(moduleDirectory, manifest)
    : undefined;
  const semanticRewritePolicy = manifest.requiredCapabilities.includes(semanticRewritePolicyCapability)
    ? await loadSemanticRewritePolicy(moduleDirectory, manifest, judge)
    : undefined;
  return {
    packDirectory: source.directory,
    packId: source.manifest.id,
    packVersion: source.manifest.version,
    sourceCommit: source.manifest.sourceCommit,
    manifestSha256: source.manifestSha256,
    ruleManifest: manifest,
    rules,
    ...(judge ? { judge } : {}),
    ...(semanticRewritePolicy ? { semanticRewritePolicy } : {}),
    engineModes: Object.fromEntries(Object.entries(source.manifest.qualityBindings)
      .map(([owner, bindings]) => [owner, bindings["anti-ai-flavor"] ?? "off"])),
    agentModes: Object.fromEntries(Object.entries(source.manifest.agentQualityBindings)
      .map(([owner, bindings]) => [owner, bindings["anti-ai-flavor"] ?? "off"])),
  };
}

async function loadSemanticRewritePolicy(
  moduleDirectory: string,
  manifest: QualityRulePackManifest,
  judge: { rubric: string; rules: QualityJudgeRule[] } | undefined,
): Promise<QualitySemanticRewritePolicy> {
  if (!manifest.requiredCapabilities.includes(semanticJudgeCapability) || !judge) {
    throw new Error(`Semantic Rewrite Policy requires ${semanticJudgeCapability}.`);
  }
  const path = "data/semantic-rewrite-policy.json";
  if (!manifest.artifacts[path]) throw new Error(`Rule Pack is missing Semantic Rewrite Policy ${path}.`);
  const policy = parseSemanticRewritePolicy(
    await readJson(resolveModulePath(moduleDirectory, path), `Semantic Rewrite Policy ${path}`),
    judge.rules,
  );
  if (policy.activation !== "active") throw new Error("Semantic Rewrite Policy must be active when its capability is required.");
  if (isZeroHash(policy.calibration.corpusSha256) || isZeroHash(policy.calibration.reportSha256)) {
    throw new Error("Semantic Rewrite Policy calibration digests must not be zero hashes.");
  }
  return policy;
}

async function loadJudgeContract(
  moduleDirectory: string,
  manifest: QualityRulePackManifest,
): Promise<{ rubric: string; rules: QualityJudgeRule[] }> {
  const rubricPath = `judge-rubric.${manifest.primaryLanguage}.md`;
  if (!manifest.artifacts[rubricPath]) throw new Error(`Rule Pack is missing Semantic Judge rubric ${rubricPath}.`);
  const rubric = await readText(resolveModulePath(moduleDirectory, rubricPath), `Semantic Judge rubric ${rubricPath}`);
  if (!rubric.trim()) throw new Error(`Semantic Judge rubric ${rubricPath} must not be empty.`);
  const rulePaths = Object.keys(manifest.artifacts)
    .filter((path) => /^judge-rules\.[A-Za-z0-9-]+\.json$/.test(path))
    .sort();
  if (rulePaths.length === 0) throw new Error("Rule Pack does not publish Semantic Judge rules.");
  const rules = (await Promise.all(rulePaths.map(async (path) =>
    parseJudgeRules(await readJson(resolveModulePath(moduleDirectory, path), `Semantic Judge rules ${path}`), manifest.module)
  ))).flat();
  if (rules.length !== manifest.projectionCounts.judge) {
    throw new Error(`Rule Pack Judge count mismatch: manifest=${manifest.projectionCounts.judge}, loaded=${rules.length}.`);
  }
  if (new Set(rules.map((rule) => rule.id)).size !== rules.length) {
    throw new Error("Rule Pack Semantic Judge rule ids must be unique across languages.");
  }
  return { rubric, rules };
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

export function parseJudgeRules(value: unknown, expectedModule = "anti-ai-flavor"): QualityJudgeRule[] {
  const raw = strictObject(value, "Semantic Judge rules", ["schema", "module", "language", "rules"]);
  if (raw.schema !== "judge-rules/v1") throw new Error("Unsupported Semantic Judge rules schema.");
  if (raw.module !== expectedModule) throw new Error("Semantic Judge rules module does not match the Rule Pack.");
  stringValue(raw.language, "Semantic Judge rules language");
  if (!Array.isArray(raw.rules) || raw.rules.length === 0) {
    throw new Error("Semantic Judge rules must be a non-empty list.");
  }
  const rules = raw.rules.map((value, index) => {
    const label = `Semantic Judge rule ${index + 1}`;
    const rule = strictObject(value, label, [
      "id", "title", "severity", "maturity", "targets", "source", "evidence",
    ]);
    const id = stringValue(rule.id, `${label} id`);
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id)) throw new Error(`${label} id must be kebab-case.`);
    const maturity = stringValue(rule.maturity, `${label} maturity`);
    if (maturity !== "experimental" && maturity !== "stable") throw new Error(`${label} maturity is invalid.`);
    const evidence = strictObject(rule.evidence, `${label} evidence`, ["mode", "minCodePoints", "maxCodePoints"]);
    if (evidence.mode !== "exact-substring") throw new Error(`${label} evidence mode is unsupported.`);
    const minCodePoints = positiveInteger(evidence.minCodePoints, `${label} evidence minCodePoints`);
    const maxCodePoints = positiveInteger(evidence.maxCodePoints, `${label} evidence maxCodePoints`);
    if (maxCodePoints > 512 || minCodePoints > maxCodePoints) throw new Error(`${label} evidence bounds are invalid.`);
    return {
      id,
      title: stringValue(rule.title, `${label} title`),
      severity: stringValue(rule.severity, `${label} severity`),
      maturity: maturity as QualityJudgeRule["maturity"],
      targets: stringList(rule.targets, `${label} targets`),
      source: stringValue(rule.source, `${label} source`),
      evidence: { mode: "exact-substring" as const, minCodePoints, maxCodePoints },
    };
  });
  if (new Set(rules.map((rule) => rule.id)).size !== rules.length) {
    throw new Error("Semantic Judge rule ids must be unique.");
  }
  return rules;
}

export function parseSemanticRewritePolicy(
  value: unknown,
  judgeRules: QualityJudgeRule[],
): QualitySemanticRewritePolicy {
  const raw = strictObject(value, "Semantic Rewrite Policy", [
    "schema", "module", "policyVersion", "activation", "targetTypes", "blockingRuleIds",
    "minimumConfidenceByRule", "modelScopes", "onUnknownModel", "onInconclusive", "multiTargetAction", "calibration",
  ]);
  if (raw.schema !== "quality-semantic-rewrite-policy/v1") throw new Error("Unsupported Semantic Rewrite Policy schema.");
  if (raw.module !== "anti-ai-flavor") throw new Error("Semantic Rewrite Policy module must be anti-ai-flavor.");
  if (raw.policyVersion !== "quality-policy/v2") throw new Error("Semantic Rewrite Policy version is unsupported.");
  const activation = stringValue(raw.activation, "Semantic Rewrite Policy activation");
  if (activation !== "inactive" && activation !== "active") throw new Error("Semantic Rewrite Policy activation is invalid.");
  const targetTypes = stringList(raw.targetTypes, "Semantic Rewrite Policy targetTypes");
  if (targetTypes.length === 0 || targetTypes.some((type) => type !== "runtime.prose")) {
    throw new Error("Semantic Rewrite Policy targetTypes are unsupported.");
  }
  const blockingRuleIds = stringList(raw.blockingRuleIds, "Semantic Rewrite Policy blockingRuleIds");
  if (blockingRuleIds.length === 0) throw new Error("Semantic Rewrite Policy must include blocking rules.");
  const knownRules = new Map(judgeRules.map((rule) => [rule.id, rule]));
  for (const ruleId of blockingRuleIds) {
    const rule = knownRules.get(ruleId);
    if (!rule || rule.maturity !== "stable" || !rule.targets.includes("narrative-prose")) {
      throw new Error(`Semantic Rewrite Policy blocking rule is unsupported: ${ruleId}.`);
    }
  }
  const minimumConfidenceRaw = objectValue(raw.minimumConfidenceByRule, "Semantic Rewrite Policy minimumConfidenceByRule");
  if (!sameStringSet(Object.keys(minimumConfidenceRaw), blockingRuleIds)) {
    throw new Error("Semantic Rewrite Policy confidence rules must exactly match blocking rules.");
  }
  const minimumConfidenceByRule: Record<string, number> = {};
  for (const ruleId of blockingRuleIds) {
    const confidence = minimumConfidenceRaw[ruleId];
    if (typeof confidence !== "number" || !Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
      throw new Error(`Semantic Rewrite Policy confidence is invalid for ${ruleId}.`);
    }
    minimumConfidenceByRule[ruleId] = confidence;
  }
  if (!Array.isArray(raw.modelScopes) || raw.modelScopes.length === 0) {
    throw new Error("Semantic Rewrite Policy modelScopes must be a non-empty list.");
  }
  const modelScopes = raw.modelScopes.map((value, index) => parseSemanticRewriteModelScope(value, index));
  const scopedModels = modelScopes.flatMap((scope) => scope.modelIds.map((modelId) => `${scope.protocol}\0${modelId}`));
  if (new Set(scopedModels).size !== scopedModels.length) {
    throw new Error("Semantic Rewrite Policy model scopes must not overlap.");
  }
  if (raw.onUnknownModel !== "observe") throw new Error("Semantic Rewrite Policy onUnknownModel must be observe.");
  if (raw.onInconclusive !== "observe") throw new Error("Semantic Rewrite Policy onInconclusive must be observe.");
  const multiTargetAction = stringValue(raw.multiTargetAction, "Semantic Rewrite Policy multiTargetAction");
  if (multiTargetAction !== "inconclusive" && multiTargetAction !== "rewrite-with-warning") {
    throw new Error("Semantic Rewrite Policy multiTargetAction is invalid.");
  }
  const calibration = strictObject(raw.calibration, "Semantic Rewrite Policy calibration", [
    "corpusSha256", "reportSha256", "thresholdVersion",
  ]);
  return {
    schema: "quality-semantic-rewrite-policy/v1",
    module: "anti-ai-flavor",
    policyVersion: "quality-policy/v2",
    activation,
    targetTypes: ["runtime.prose"],
    blockingRuleIds,
    minimumConfidenceByRule,
    modelScopes,
    onUnknownModel: "observe",
    onInconclusive: "observe",
    multiTargetAction,
    calibration: {
      corpusSha256: hashValue(calibration.corpusSha256, "Semantic Rewrite Policy corpusSha256"),
      reportSha256: hashValue(calibration.reportSha256, "Semantic Rewrite Policy reportSha256"),
      thresholdVersion: stringValue(calibration.thresholdVersion, "Semantic Rewrite Policy thresholdVersion"),
    },
  };
}

function parseSemanticRewriteModelScope(value: unknown, index: number): QualitySemanticRewriteModelScope {
  const label = `Semantic Rewrite Policy model scope ${index + 1}`;
  const raw = strictObject(value, label, ["protocol", "modelFamily", "modelIds"]);
  const protocol = stringValue(raw.protocol, `${label} protocol`);
  if (protocol !== "openai-chat-compatible" && protocol !== "anthropic-messages" && protocol !== "gemini-generate-content") {
    throw new Error(`${label} protocol is unsupported.`);
  }
  const modelIds = stringList(raw.modelIds, `${label} modelIds`);
  if (modelIds.length === 0) throw new Error(`${label} must include modelIds.`);
  return {
    protocol,
    modelFamily: stringValue(raw.modelFamily, `${label} modelFamily`),
    modelIds,
  };
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
      ...(kind === "regex" && raw.flags !== undefined
        ? { flags: stringValueAllowEmpty(raw.flags, `Detector rule ${index + 1} matcher flags`) }
        : {}),
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
  const metricLabel = `Detector rule ${index + 1} metric`;
  const metric = objectValue(raw.metric, metricLabel);
  const signal = stringValue(metric.signal, `${metricLabel} signal`);
  if (!isQualityMetricSignal(signal)) throw new Error(`Detector rule ${index + 1} metric signal is unsupported.`);
  const operator = stringValue(metric.operator, `${metricLabel} operator`);
  if (operator !== "gte" && operator !== "gt" && operator !== "lte" && operator !== "lt") {
    throw new Error(`Detector rule ${index + 1} metric operator is unsupported.`);
  }
  if (typeof metric.threshold !== "number" || !Number.isFinite(metric.threshold)) {
    throw new Error(`Detector rule ${index + 1} metric threshold is invalid.`);
  }
  if (signal === "em_dash_per_100_chars") {
    strictKeys(metric, metricLabel, ["signal", "operator", "threshold"]);
    return {
      kind: "metric",
      unit,
      metric: { signal, operator, threshold: metric.threshold },
    };
  }

  strictKeys(metric, metricLabel, [
    "signal", "operator", "threshold", "minimumMatches", "minimumCoreMatches", "minimumBuckets",
    "minimumSeparators", "excludeDialogue", "patterns",
  ]);
  const minimumMatches = positiveInteger(metric.minimumMatches, `${metricLabel} minimumMatches`);
  if (metric.excludeDialogue !== true) throw new Error(`${metricLabel} must exclude dialogue.`);
  if (!Array.isArray(metric.patterns) || metric.patterns.length === 0 || metric.patterns.length > maxMetricPatterns) {
    throw new Error(`${metricLabel} patterns must contain 1-${maxMetricPatterns} entries.`);
  }
  const patterns = metric.patterns.map((pattern, patternIndex) =>
    parseMetricPattern(pattern, `${metricLabel} pattern ${patternIndex + 1}`)
  );
  if (new Set(patterns.map((pattern) => pattern.id)).size !== patterns.length) {
    throw new Error(`${metricLabel} pattern ids must be unique.`);
  }
  const minimumCoreMatches = optionalPositiveInteger(metric.minimumCoreMatches, `${metricLabel} minimumCoreMatches`);
  const minimumBuckets = optionalPositiveInteger(metric.minimumBuckets, `${metricLabel} minimumBuckets`);
  const minimumSeparators = optionalPositiveInteger(metric.minimumSeparators, `${metricLabel} minimumSeparators`);
  if (signal === "reasoning_chain_per_1000_chars") {
    if (!minimumCoreMatches || !minimumBuckets) {
      throw new Error(`${metricLabel} requires minimumCoreMatches and minimumBuckets.`);
    }
    if (!patterns.some((pattern) => pattern.core)) throw new Error(`${metricLabel} requires a core pattern.`);
  }
  if (signal === "action_list_verbs_per_paragraph" && !minimumSeparators) {
    throw new Error(`${metricLabel} requires minimumSeparators.`);
  }
  const parsedMetric: QualityMetric = {
    signal,
    operator,
    threshold: metric.threshold,
    minimumMatches,
    excludeDialogue: true,
    patterns,
    ...(minimumCoreMatches ? { minimumCoreMatches } : {}),
    ...(minimumBuckets ? { minimumBuckets } : {}),
    ...(minimumSeparators ? { minimumSeparators } : {}),
  };
  return {
    kind: "metric",
    unit,
    metric: parsedMetric,
  };
}

function parseMetricPattern(value: unknown, label: string): QualityMetricPattern {
  const raw = objectValue(value, label);
  strictKeys(raw, label, ["id", "value", "flags", "core"]);
  const id = stringValue(raw.id, `${label} id`);
  if (!/^[a-z][a-z0-9-]*$/.test(id)) throw new Error(`${label} id must be kebab-case.`);
  const pattern = stringValue(raw.value, `${label} value`);
  if (pattern.length > maxMetricPatternLength) throw new Error(`${label} exceeds the pattern length limit.`);
  const flags = raw.flags === undefined ? undefined : stringValueAllowEmpty(raw.flags, `${label} flags`);
  if (flags !== undefined && (!/^[dimsuv]*$/.test(flags) || /[gy]/.test(flags))) {
    throw new Error(`${label} flags are unsupported.`);
  }
  if (raw.core !== undefined && typeof raw.core !== "boolean") throw new Error(`${label} core must be a boolean.`);
  try {
    const expression = new RegExp(pattern, flags);
    if (expression.test("")) throw new Error("pattern must not match empty text");
    assertSafeMetricPattern(pattern, flags, label);
  } catch (error) {
    throw new Error(`${label} is invalid: ${error instanceof Error ? error.message : String(error)}`);
  }
  return {
    id,
    value: pattern,
    ...(flags !== undefined ? { flags } : {}),
    ...(raw.core !== undefined ? { core: raw.core as boolean } : {}),
  };
}

function assertSafeMetricPattern(pattern: string, flags: string | undefined, label: string): void {
  const parsed = metricPatternParser.parsePattern(pattern, 0, pattern.length, {
    unicode: flags?.includes("u") ?? false,
    unicodeSets: flags?.includes("v") ?? false,
  });
  if (patternMinimumConsumption(parsed) === 0) {
    throw new Error(`${label} must consume at least one character`);
  }
  if (parsed.alternatives.length > maxMetricPatternBranches) {
    throw new Error(`${label} must not contain more than ${maxMetricPatternBranches} top-level alternatives`);
  }
  const quantifierStack: AST.Quantifier[] = [];
  let quantifierCount = 0;
  let branchingGroupCount = 0;
  let unsafeReason: string | undefined;
  visitRegExpAST(parsed, {
    onAlternativeEnter(node) {
      if (alternativeBacktrackingCombinations(node) > maxMetricPatternBacktrackingCombinations) {
        unsafeReason ??= `backtracking combinations must not exceed ${maxMetricPatternBacktrackingCombinations}`;
      }
    },
    onBackreferenceEnter() {
      unsafeReason ??= "backreferences are not allowed";
    },
    onCapturingGroupEnter(node) {
      if (node.alternatives.length > 1) branchingGroupCount += 1;
      if (node.alternatives.length > maxMetricPatternBranches) {
        unsafeReason ??= `groups must not contain more than ${maxMetricPatternBranches} alternatives`;
      }
    },
    onGroupEnter(node) {
      if (node.alternatives.length > 1) branchingGroupCount += 1;
      if (node.alternatives.length > maxMetricPatternBranches) {
        unsafeReason ??= `groups must not contain more than ${maxMetricPatternBranches} alternatives`;
      }
    },
    onAssertionEnter(node) {
      if ((node.kind === "lookahead" || node.kind === "lookbehind") && node.alternatives.length > 1) {
        branchingGroupCount += 1;
        if (node.alternatives.length > maxMetricPatternBranches) {
          unsafeReason ??= `lookarounds must not contain more than ${maxMetricPatternBranches} alternatives`;
        }
      }
    },
    onQuantifierEnter(node) {
      quantifierCount += 1;
      const parent = quantifierStack.at(-1);
      if (node.max > maxMetricPatternRepetition) {
        unsafeReason ??= `repetition upper bounds must not exceed ${maxMetricPatternRepetition}`;
      } else if (parent && parent.max > 1 && node.max > 0) {
        unsafeReason ??= "nested repeating quantifiers are not allowed";
      } else if (node.max > 1
        && (node.element.type === "Group" || node.element.type === "CapturingGroup")
        && node.element.alternatives.length > 1) {
        unsafeReason ??= "repeated groups with alternatives are not allowed";
      }
      quantifierStack.push(node);
    },
    onQuantifierLeave() {
      quantifierStack.pop();
    },
  });
  if (quantifierCount > maxMetricPatternQuantifiers) {
    unsafeReason ??= `patterns must not contain more than ${maxMetricPatternQuantifiers} quantifiers`;
  }
  if (branchingGroupCount > maxMetricPatternBranchingGroups) {
    unsafeReason ??= `patterns must not contain more than ${maxMetricPatternBranchingGroups} branching groups`;
  }
  if (unsafeReason) throw new Error(`${label} contains a potentially unsafe regular expression: ${unsafeReason}`);
}

function patternMinimumConsumption(pattern: AST.Pattern): number {
  return Math.min(...pattern.alternatives.map(alternativeMinimumConsumption));
}

function alternativeMinimumConsumption(alternative: AST.Alternative): number {
  return alternative.elements.reduce((total, element) => total + elementMinimumConsumption(element), 0);
}

function elementMinimumConsumption(element: AST.Element): number {
  if (element.type === "Quantifier") {
    return element.min * elementMinimumConsumption(element.element);
  }
  if (element.type === "Group" || element.type === "CapturingGroup") {
    return Math.min(...element.alternatives.map(alternativeMinimumConsumption));
  }
  if (element.type === "Character" || element.type === "CharacterClass"
    || element.type === "CharacterSet" || element.type === "ExpressionCharacterClass") {
    return 1;
  }
  return 0;
}

function alternativeBacktrackingCombinations(alternative: AST.Alternative): number {
  return alternative.elements.reduce(
    (total, element) => cappedCombinationProduct(total, elementBacktrackingCombinations(element)),
    1,
  );
}

function elementBacktrackingCombinations(element: AST.Element): number {
  if (element.type === "Quantifier") {
    const choices = Math.min(
      maxMetricPatternBacktrackingCombinations + 1,
      element.max - element.min + 1,
    );
    return cappedCombinationProduct(choices, elementBacktrackingCombinations(element.element));
  }
  if (element.type === "Group" || element.type === "CapturingGroup"
    || (element.type === "Assertion" && (element.kind === "lookahead" || element.kind === "lookbehind"))) {
    return element.alternatives.reduce(
      (total, alternative) => cappedCombinationSum(total, alternativeBacktrackingCombinations(alternative)),
      0,
    );
  }
  return 1;
}

function cappedCombinationProduct(left: number, right: number): number {
  if (left > maxMetricPatternBacktrackingCombinations || right > maxMetricPatternBacktrackingCombinations) {
    return maxMetricPatternBacktrackingCombinations + 1;
  }
  const product = left * right;
  return product > maxMetricPatternBacktrackingCombinations
    ? maxMetricPatternBacktrackingCombinations + 1
    : product;
}

function cappedCombinationSum(left: number, right: number): number {
  const sum = left + right;
  return sum > maxMetricPatternBacktrackingCombinations
    ? maxMetricPatternBacktrackingCombinations + 1
    : sum;
}

async function validatePublishedSchemas(moduleDirectory: string, manifest: QualityRulePackManifest): Promise<void> {
  const expected: Array<readonly [string, string]> = [
    ["schemas/rule-pack.schema.json", "Rule Pack Manifest v1"],
    ["schemas/detector-rules.schema.json", "Detector Rules v1"],
    ["schemas/host-conformance-case.schema.json", "Rule Host Conformance Case v1"],
    ...(manifest.requiredCapabilities.includes(semanticJudgeCapability) ? [
      ["schemas/judge-rules.schema.json", "Judge Rules v1"] as const,
      ["schemas/judge-result.schema.json", "Judge Result v1"] as const,
    ] : []),
    ...(manifest.requiredCapabilities.includes(semanticRewritePolicyCapability) ? [
      ["schemas/semantic-rewrite-policy.schema.json", "Semantic Rewrite Policy v1"] as const,
    ] : []),
  ];
  for (const [path, title] of expected) {
    if (!manifest.artifacts[path]) throw new Error(`Rule Pack is missing published schema ${path}.`);
    const schema = objectValue(await readJson(resolveModulePath(moduleDirectory, path), `Published schema ${path}`), `Published schema ${path}`);
    if (schema.$schema !== "https://json-schema.org/draft/2020-12/schema" || schema.title !== title
      || schema.type !== "object" || schema.additionalProperties !== false || !Array.isArray(schema.required)) {
      throw new Error(`Published schema ${path} has an unsupported contract.`);
    }
    if (path === "schemas/judge-rules.schema.json") validateJudgeRulesSchema(schema, path);
    if (path === "schemas/judge-result.schema.json") validateJudgeResultSchema(schema, path);
    if (path === "schemas/semantic-rewrite-policy.schema.json") validateSemanticRewritePolicySchema(schema, path);
  }
}

function validateSemanticRewritePolicySchema(schema: Record<string, unknown>, path: string): void {
  assertExactStringSet(schema.required, [
    "schema", "module", "policyVersion", "activation", "targetTypes", "blockingRuleIds",
    "minimumConfidenceByRule", "modelScopes", "onUnknownModel", "onInconclusive", "multiTargetAction", "calibration",
  ], path);
  const properties = objectValue(schema.properties, `Published schema ${path} properties`);
  const schemaProperty = objectValue(properties.schema, `Published schema ${path} schema property`);
  const module = objectValue(properties.module, `Published schema ${path} module property`);
  const policyVersion = objectValue(properties.policyVersion, `Published schema ${path} policyVersion property`);
  const activation = objectValue(properties.activation, `Published schema ${path} activation property`);
  const targetTypes = objectValue(properties.targetTypes, `Published schema ${path} targetTypes property`);
  const targetType = objectValue(targetTypes.items, `Published schema ${path} targetType property`);
  const blockingRuleIds = objectValue(properties.blockingRuleIds, `Published schema ${path} blockingRuleIds property`);
  const blockingRuleId = objectValue(blockingRuleIds.items, `Published schema ${path} blockingRuleId property`);
  const minimumConfidence = objectValue(properties.minimumConfidenceByRule, `Published schema ${path} minimumConfidenceByRule property`);
  const confidence = objectValue(minimumConfidence.additionalProperties, `Published schema ${path} confidence property`);
  const confidenceRuleId = objectValue(minimumConfidence.propertyNames, `Published schema ${path} confidence rule id property`);
  const unknown = objectValue(properties.onUnknownModel, `Published schema ${path} onUnknownModel property`);
  const inconclusive = objectValue(properties.onInconclusive, `Published schema ${path} onInconclusive property`);
  const multiTargetAction = objectValue(properties.multiTargetAction, `Published schema ${path} multiTargetAction property`);
  const modelScopes = objectValue(properties.modelScopes, `Published schema ${path} modelScopes property`);
  const scope = objectValue(modelScopes.items, `Published schema ${path} model scope`);
  const scopeProperties = objectValue(scope.properties, `Published schema ${path} model scope properties`);
  const scopeProtocol = objectValue(scopeProperties.protocol, `Published schema ${path} model scope protocol`);
  const scopeFamily = objectValue(scopeProperties.modelFamily, `Published schema ${path} model scope modelFamily`);
  const scopeModelIds = objectValue(scopeProperties.modelIds, `Published schema ${path} model scope modelIds`);
  const calibration = objectValue(properties.calibration, `Published schema ${path} calibration property`);
  const calibrationProperties = objectValue(calibration.properties, `Published schema ${path} calibration properties`);
  const corpusSha256 = objectValue(calibrationProperties.corpusSha256, `Published schema ${path} corpusSha256`);
  const reportSha256 = objectValue(calibrationProperties.reportSha256, `Published schema ${path} reportSha256`);
  const thresholdVersion = objectValue(calibrationProperties.thresholdVersion, `Published schema ${path} thresholdVersion`);
  if (schemaProperty.const !== "quality-semantic-rewrite-policy/v1" || module.const !== "anti-ai-flavor"
    || policyVersion.const !== "quality-policy/v2" || !sameStringSet(activation.enum, ["inactive", "active"])
    || targetTypes.type !== "array" || targetTypes.minItems !== 1 || targetTypes.uniqueItems !== true
    || !sameStringSet(targetType.enum, ["runtime.prose"])
    || blockingRuleIds.type !== "array" || blockingRuleIds.minItems !== 1 || blockingRuleIds.uniqueItems !== true
    || blockingRuleId.type !== "string" || blockingRuleId.pattern !== "^[a-z0-9]+(?:-[a-z0-9]+)*$"
    || minimumConfidence.type !== "object" || minimumConfidence.minProperties !== 1
    || confidence.type !== "number" || confidence.minimum !== 0 || confidence.maximum !== 1
    || confidenceRuleId.pattern !== "^[a-z0-9]+(?:-[a-z0-9]+)*$"
    || unknown.const !== "observe" || inconclusive.const !== "observe"
    || !sameStringSet(multiTargetAction.enum, ["inconclusive", "rewrite-with-warning"])
    || modelScopes.type !== "array" || modelScopes.minItems !== 1 || scope.type !== "object" || scope.additionalProperties !== false
    || !sameStringSet(scopeProtocol.enum, ["openai-chat-compatible", "anthropic-messages", "gemini-generate-content"])
    || scopeFamily.type !== "string" || scopeFamily.minLength !== 1
    || scopeModelIds.type !== "array" || scopeModelIds.minItems !== 1 || scopeModelIds.uniqueItems !== true
    || calibration.type !== "object" || calibration.additionalProperties !== false
    || corpusSha256.type !== "string" || corpusSha256.pattern !== "^[a-f0-9]{64}$"
    || reportSha256.type !== "string" || reportSha256.pattern !== "^[a-f0-9]{64}$"
    || thresholdVersion.type !== "string" || thresholdVersion.minLength !== 1) {
    throw new Error(`Published schema ${path} has an unsupported Semantic Rewrite Policy contract.`);
  }
  assertExactStringSet(scope.required, ["protocol", "modelFamily", "modelIds"], `${path} model scope`);
  assertExactStringSet(calibration.required, ["corpusSha256", "reportSha256", "thresholdVersion"], `${path} calibration`);
}

function validateJudgeRulesSchema(schema: Record<string, unknown>, path: string): void {
  assertExactStringSet(schema.required, ["schema", "module", "language", "rules"], path);
  const properties = objectValue(schema.properties, `Published schema ${path} properties`);
  const schemaProperty = objectValue(properties.schema, `Published schema ${path} schema property`);
  const rules = objectValue(properties.rules, `Published schema ${path} rules property`);
  const item = objectValue(rules.items, `Published schema ${path} rule item`);
  if (schemaProperty.const !== "judge-rules/v1" || rules.type !== "array" || rules.minItems !== 1
    || item.type !== "object" || item.additionalProperties !== false) {
    throw new Error(`Published schema ${path} has an unsupported Judge rules contract.`);
  }
  assertExactStringSet(item.required, [
    "id", "title", "severity", "maturity", "targets", "source", "evidence",
  ], `${path} rule item`);
  const itemProperties = objectValue(item.properties, `Published schema ${path} rule properties`);
  const evidence = objectValue(itemProperties.evidence, `Published schema ${path} evidence property`);
  assertExactStringSet(evidence.required, ["mode", "minCodePoints", "maxCodePoints"], `${path} evidence`);
  const evidenceProperties = objectValue(evidence.properties, `Published schema ${path} evidence properties`);
  const mode = objectValue(evidenceProperties.mode, `Published schema ${path} evidence mode`);
  const maxCodePoints = objectValue(evidenceProperties.maxCodePoints, `Published schema ${path} maxCodePoints`);
  if (evidence.type !== "object" || evidence.additionalProperties !== false
    || mode.const !== "exact-substring" || maxCodePoints.maximum !== 512) {
    throw new Error(`Published schema ${path} has an unsupported evidence contract.`);
  }
}

function validateJudgeResultSchema(schema: Record<string, unknown>, path: string): void {
  assertExactStringSet(schema.required, ["schema", "verdict", "confidence", "findings"], path);
  const properties = objectValue(schema.properties, `Published schema ${path} properties`);
  const schemaProperty = objectValue(properties.schema, `Published schema ${path} schema property`);
  const verdict = objectValue(properties.verdict, `Published schema ${path} verdict property`);
  const findings = objectValue(properties.findings, `Published schema ${path} findings property`);
  const item = objectValue(findings.items, `Published schema ${path} finding item`);
  if (schemaProperty.const !== "quality-judge-result/v1"
    || !sameStringSet(verdict.enum, ["pass", "rewrite"])
    || findings.type !== "array" || item.type !== "object" || item.additionalProperties !== false) {
    throw new Error(`Published schema ${path} has an unsupported Judge result contract.`);
  }
  assertExactStringSet(item.required, [
    "ruleId", "evidence", "confidence", "explanation", "rewriteInstruction",
  ], `${path} finding item`);
  const itemProperties = objectValue(item.properties, `Published schema ${path} finding properties`);
  const evidence = objectValue(itemProperties.evidence, `Published schema ${path} evidence property`);
  const explanation = objectValue(itemProperties.explanation, `Published schema ${path} explanation property`);
  const rewriteInstruction = objectValue(itemProperties.rewriteInstruction, `Published schema ${path} rewriteInstruction property`);
  if (evidence.maxLength !== 240 || explanation.maxLength !== 500 || rewriteInstruction.maxLength !== 500) {
    throw new Error(`Published schema ${path} has unsupported finding bounds.`);
  }
}

function assertExactStringSet(value: unknown, expected: string[], label: string): void {
  if (!sameStringSet(value, expected)) throw new Error(`Published schema ${label} required keys are unsupported.`);
}

function sameStringSet(value: unknown, expected: string[]): boolean {
  return Array.isArray(value)
    && value.length === expected.length
    && new Set(value).size === expected.length
    && value.every((entry) => typeof entry === "string" && expected.includes(entry));
}

async function readText(path: string, label: string): Promise<string> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    throw new Error(`Cannot load ${label}: ${error instanceof Error ? error.message : String(error)}`);
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

function stringValueAllowEmpty(value: unknown, label: string): string {
  if (typeof value !== "string") throw new Error(`${label} must be a string.`);
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

function optionalPositiveInteger(value: unknown, label: string): number | undefined {
  return value === undefined ? undefined : positiveInteger(value, label);
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

function isZeroHash(value: string): boolean {
  return /^0{64}$/.test(value);
}
