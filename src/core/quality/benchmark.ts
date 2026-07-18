import { createHash } from "node:crypto";
import { appendFile, readFile } from "node:fs/promises";
import type { ProviderAdapter, ResponseUsage } from "../../providers/shared/types";
import { maxQualityJudgeOutputTokens, runQualityJudge } from "./judge";
import type { QualityCandidateType, QualityJudgeContract, QualityJudgeStatus, QualityRuntimeContext } from "./types";

export type QualityBenchmarkCase = {
  caseId: string;
  text: string;
  candidateSha256: string;
  targetType: string;
  genre: string;
  modelFamily: string;
  lengthBucket: string;
  pov: string;
  expectedVerdict?: "pass" | "rewrite";
  expectedRuleIds?: string[];
};

export type QualityBenchmarkPricing = {
  inputUsdPerMillionTokens: number;
  outputUsdPerMillionTokens: number;
};

export type QualityBenchmarkModel = {
  providerAlias: string;
  protocol: "openai-chat-completions" | "anthropic-messages" | "gemini-generate-content";
  modelId: string;
  provider: ProviderAdapter;
  pricing: QualityBenchmarkPricing;
  temperatureSupported?: boolean;
  reasoningTierSupported?: boolean;
};

export type QualityBenchmarkPolicy = {
  repeatsPerCase: number;
  confidenceInterval: "wilson-95";
  majorSlices: Array<"rule" | "genre" | "modelFamily" | "lengthBucket" | "pov" | "targetType">;
  minimumSliceN: number;
  requestCap: number;
  tokenCap: number;
  costCapUsd: number;
  maxInputTokensPerRequest: number;
  judgeTimeoutMs: number;
  minimumIntervalMs: number;
  goNoGo: {
    minimumRecall: number;
    maximumFalseRewriteRate: number;
    minimumAgreement: number;
    maximumInvalidRate: number;
    maximumP95LatencyMs: number;
  };
  earlyStop: {
    invalidRate: number;
    timeoutRate: number;
    falseRewriteRate: number;
  };
};

export type QualityBenchmarkIdentity = {
  vesicleCommit: string;
  corpusSha256: string;
  runtime: QualityRuntimeContext;
};

export type QualityBenchmarkEvaluation = {
  schema: "quality-judge-benchmark-evaluation/v1";
  runId: string;
  planSha256: string;
  model: Pick<QualityBenchmarkModel, "providerAlias" | "protocol" | "modelId">;
  caseId: string;
  repeat: number;
  candidateSha256: string;
  slice: Pick<QualityBenchmarkCase, "targetType" | "genre" | "modelFamily" | "lengthBucket" | "pov">;
  expectedVerdict?: "pass" | "rewrite";
  expectedRuleIds?: string[];
  result: {
    status: Exclude<QualityJudgeStatus, "not-run">;
    verdict?: "pass" | "rewrite";
    ruleIds: string[];
    durationMs: number;
    requestCount: number;
    usage?: ResponseUsage;
  };
  charge: {
    reservedTokens: number;
    chargedTokens: number;
    chargedUsd: number;
  };
};

export type QualityBenchmarkReport = {
  schema: "quality-judge-benchmark-report/v1";
  benchmarkVersion: string;
  runId: string;
  createdAt: string;
  identity: {
    vesicleCommit: string;
    harness: { id: string; version: string; sourceCommit: string; manifestSha256: string };
    rulePack: { version: string; sourceHash: string };
    artifacts: { rubricSha256: string; judgeRulesSha256: string; resultSchemaSha256: string };
    corpusSha256: string;
  };
  policy: {
    repeatsPerCase: number;
    confidenceInterval: "wilson-95";
    majorSlices: QualityBenchmarkPolicy["majorSlices"];
    minimumSliceN: number;
    requestCap: number;
    tokenCap: number;
    costCap: number;
    judgeTimeoutMs: number;
    goNoGo: QualityBenchmarkPolicy["goNoGo"];
    earlyStop: QualityBenchmarkPolicy["earlyStop"];
  };
  models: QualityBenchmarkModelReport[];
  privacy: {
    containsRawResponses: false;
    containsCandidateText: false;
    modelIdentityIsUserDeclared: true;
  };
};

export type QualityBenchmarkModelReport = {
  providerAlias: string;
  protocol: QualityBenchmarkModel["protocol"];
  modelId: string;
  requestPolicy: { temperature: number; reasoning?: string; maxTokens: number };
  sampleCounts: { cases: number; evaluations: number; requests: number; repairs: number; pass: number; rewrite: number };
  metrics: Record<QualityBenchmarkMetricName, QualityBenchmarkMetric>;
  usage: { inputTokens: number; outputTokens: number; totalTokens: number };
  latencyMs: { average: number; p50: number; p95: number };
  slices: Array<{ dimension: QualityBenchmarkPolicy["majorSlices"][number]; value: string; sampleCount: number; metrics: Record<QualityBenchmarkMetricName, QualityBenchmarkMetric> }>;
  failureCaseIds: string[];
  decision: "pass" | "fail" | "inconclusive";
  decisionReasons: string[];
};

export type QualityBenchmarkMetricName =
  | "expectedRewriteRecall"
  | "passFalseRewriteRate"
  | "verdictAgreement"
  | "invalidRate"
  | "repairExhaustedRate"
  | "timeoutRate"
  | "unavailableRate"
  | "ruleContractRate"
  | "evidenceContractRate";

export type QualityBenchmarkMetric = {
  value: number;
  numerator: number;
  denominator: number;
  wilson95Low: number;
  wilson95High: number;
};

export type RunQualityBenchmarkOptions = {
  runId: string;
  outputPath: string;
  cases: QualityBenchmarkCase[];
  models: QualityBenchmarkModel[];
  identity: QualityBenchmarkIdentity;
  policy: QualityBenchmarkPolicy;
  signal?: AbortSignal;
  now?: () => Date;
  sleep?: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
};

export type QualityBenchmarkRunResult = {
  report: QualityBenchmarkReport;
  evaluations: QualityBenchmarkEvaluation[];
  stoppedEarly: Array<{ model: string; reason: string }>;
};

const benchmarkVersion = "1";

export async function runQualityBenchmark(options: RunQualityBenchmarkOptions): Promise<QualityBenchmarkRunResult> {
  validateOptions(options);
  const planSha256 = benchmarkPlanHash(options);
  const existing = await readBenchmarkEvaluations(options.outputPath, options.runId, planSha256);
  const evaluations = [...existing];
  const completed = new Set(existing.map(evaluationKey));
  const stoppedEarly: Array<{ model: string; reason: string }> = [];
  const now = options.now ?? (() => new Date());
  const sleep = options.sleep ?? sleepWithSignal;
  let lastRequestAt = 0;

  for (const model of options.models) {
    let modelStopped = false;
    for (const item of options.cases) {
      for (let repeat = 1; repeat <= options.policy.repeatsPerCase; repeat++) {
        if (modelStopped || completed.has(evaluationKeyFor(model, item, repeat))) continue;
        assertNotAborted(options.signal);
        const budgetReason = budgetReservationReason(evaluations, model, options.policy);
        if (budgetReason) {
          stoppedEarly.push({ model: modelKey(model), reason: budgetReason });
          modelStopped = true;
          continue;
        }
        const delay = options.policy.minimumIntervalMs - (Date.now() - lastRequestAt);
        if (delay > 0) await sleep(delay, options.signal);
        assertNotAborted(options.signal);
        lastRequestAt = Date.now();
        const result = await runQualityJudge({
          provider: model.provider,
          providerId: model.providerAlias,
          model: model.modelId,
          contract: requiredJudgeContract(options.identity.runtime),
          candidateType: candidateTypeForTarget(item.targetType),
          targetKind: "assistant-response",
          content: item.text,
          signal: options.signal,
          timeoutMs: options.policy.judgeTimeoutMs,
          temperatureSupported: model.temperatureSupported,
          reasoningTierSupported: model.reasoningTierSupported,
        });
        const charge = chargeForResult(result.usage, result.requestCount, model.pricing, options.policy);
        const evaluation: QualityBenchmarkEvaluation = {
          schema: "quality-judge-benchmark-evaluation/v1",
          runId: options.runId,
          planSha256,
          model: { providerAlias: model.providerAlias, protocol: model.protocol, modelId: model.modelId },
          caseId: item.caseId,
          repeat,
          candidateSha256: item.candidateSha256,
          slice: {
            targetType: item.targetType,
            genre: item.genre,
            modelFamily: item.modelFamily,
            lengthBucket: item.lengthBucket,
            pov: item.pov,
          },
          ...(item.expectedVerdict ? { expectedVerdict: item.expectedVerdict } : {}),
          ...(item.expectedRuleIds ? { expectedRuleIds: [...item.expectedRuleIds].sort() } : {}),
          result: {
            status: result.status,
            ...(result.status === "valid" ? { verdict: result.findings.length === 0 ? "pass" as const : "rewrite" as const } : {}),
            ruleIds: result.findings.map((finding) => finding.ruleId).sort(),
            durationMs: Math.round(result.durationMs * 1_000) / 1_000,
            requestCount: result.requestCount,
            ...(result.usage ? { usage: boundedUsage(result.usage) } : {}),
          },
          charge,
        };
        await appendFile(options.outputPath, `${JSON.stringify(evaluation)}\n`, "utf8");
        evaluations.push(evaluation);
        completed.add(evaluationKey(evaluation));
        const stopReason = earlyStopReason(evaluations.filter((entry) => sameModel(entry, model)), options.policy);
        if (stopReason) {
          stoppedEarly.push({ model: modelKey(model), reason: stopReason });
          modelStopped = true;
        }
      }
    }
  }
  return {
    evaluations,
    stoppedEarly,
    report: qualityBenchmarkReport({ ...options, now }, evaluations, stoppedEarly),
  };
}

export function qualityBenchmarkReport(
  options: Pick<RunQualityBenchmarkOptions, "runId" | "identity" | "policy" | "models"> & { now?: () => Date },
  evaluations: QualityBenchmarkEvaluation[],
  stoppedEarly: Array<{ model: string; reason: string }> = [],
): QualityBenchmarkReport {
  return {
    schema: "quality-judge-benchmark-report/v1",
    benchmarkVersion,
    runId: options.runId,
    createdAt: (options.now ?? (() => new Date()))().toISOString(),
    identity: reportIdentity(options.identity),
    policy: {
      repeatsPerCase: options.policy.repeatsPerCase,
      confidenceInterval: options.policy.confidenceInterval,
      majorSlices: options.policy.majorSlices,
      minimumSliceN: options.policy.minimumSliceN,
      requestCap: options.policy.requestCap,
      tokenCap: options.policy.tokenCap,
      costCap: options.policy.costCapUsd,
      judgeTimeoutMs: options.policy.judgeTimeoutMs,
      goNoGo: options.policy.goNoGo,
      earlyStop: options.policy.earlyStop,
    },
    models: options.models.map((model) => modelReport(model, evaluations.filter((item) => modelKey(item.model) === modelKey(model)), options.policy, stoppedEarly)),
    privacy: { containsRawResponses: false, containsCandidateText: false, modelIdentityIsUserDeclared: true },
  };
}

export async function readBenchmarkEvaluations(path: string, runId: string, planSha256: string): Promise<QualityBenchmarkEvaluation[]> {
  const source = await readFile(path, "utf8").catch((error: unknown) => {
    if (isNotFound(error)) return "";
    throw error;
  });
  if (!source.trim()) return [];
  const records: QualityBenchmarkEvaluation[] = [];
  for (const [index, line] of source.split("\n").entries()) {
    if (!line.trim()) continue;
    let raw: unknown;
    try {
      raw = JSON.parse(line);
    } catch {
      throw new Error(`Benchmark output line ${index + 1} is not JSON.`);
    }
    const record = parseEvaluation(raw, index + 1);
    if (record.runId !== runId || record.planSha256 !== planSha256) {
      throw new Error("Benchmark output belongs to a different run plan; choose a new output path.");
    }
    records.push(record);
  }
  const duplicate = firstDuplicate(records.map(evaluationKey));
  if (duplicate) throw new Error(`Benchmark output contains duplicate evaluation ${duplicate}.`);
  return records;
}

function modelReport(
  model: Pick<QualityBenchmarkModel, "providerAlias" | "protocol" | "modelId">,
  evaluations: QualityBenchmarkEvaluation[],
  policy: QualityBenchmarkPolicy,
  stoppedEarly: Array<{ model: string; reason: string }>,
): QualityBenchmarkModelReport {
  const metrics = metricsFor(evaluations);
  const known = evaluations.filter((item) => item.expectedVerdict !== undefined);
  const failureCaseIds = [...new Set(evaluations.filter((item) => item.result.status !== "valid"
    || (item.expectedVerdict !== undefined && predictedVerdict(item) !== item.expectedVerdict)
  ).map((item) => item.caseId))].sort();
  const latency = latencySummary(evaluations.map((item) => item.result.durationMs));
  const slices = sliceReports(evaluations, policy);
  const reasons = decisionReasons(
    metrics,
    known.length,
    latency.p95,
    policy,
    stoppedEarly.filter((entry) => entry.model === modelKey(model)).map((entry) => entry.reason),
  );
  for (const slice of slices) {
    const label = `slice ${slice.dimension}=${slice.value}`;
    if (slice.sampleCount < policy.minimumSliceN) {
      reasons.push(`${label} is below minimum sample count`);
      continue;
    }
    for (const reason of thresholdReasons(slice.metrics, policy)) reasons.push(`${label}: ${reason}`);
  }
  return {
    providerAlias: model.providerAlias,
    protocol: model.protocol,
    modelId: model.modelId,
    requestPolicy: { temperature: 0, maxTokens: maxQualityJudgeOutputTokens },
    sampleCounts: {
      cases: new Set(evaluations.map((item) => item.caseId)).size,
      evaluations: evaluations.length,
      requests: evaluations.reduce((total, item) => total + item.result.requestCount, 0),
      repairs: evaluations.filter((item) => item.result.requestCount === 2).length,
      pass: evaluations.filter((item) => predictedVerdict(item) === "pass").length,
      rewrite: evaluations.filter((item) => predictedVerdict(item) === "rewrite").length,
    },
    metrics,
    usage: usageTotals(evaluations),
    latencyMs: latency,
    slices,
    failureCaseIds,
    decision: reasons.length === 0 ? "pass" : known.length === 0 ? "inconclusive" : "fail",
    decisionReasons: reasons,
  };
}

function metricsFor(evaluations: QualityBenchmarkEvaluation[]): Record<QualityBenchmarkMetricName, QualityBenchmarkMetric> {
  const known = evaluations.filter((item) => item.expectedVerdict !== undefined);
  const expectedRewrite = known.filter((item) => item.expectedVerdict === "rewrite");
  const expectedPass = known.filter((item) => item.expectedVerdict === "pass");
  const valid = evaluations.filter((item) => item.result.status === "valid");
  return {
    expectedRewriteRecall: metric(expectedRewrite.filter((item) => predictedVerdict(item) === "rewrite").length, expectedRewrite.length),
    passFalseRewriteRate: metric(expectedPass.filter((item) => predictedVerdict(item) === "rewrite").length, expectedPass.length),
    verdictAgreement: metric(known.filter((item) => predictedVerdict(item) === item.expectedVerdict).length, known.length),
    invalidRate: metric(evaluations.filter((item) => item.result.status === "invalid").length, evaluations.length),
    repairExhaustedRate: metric(evaluations.filter((item) => item.result.status === "invalid" && item.result.requestCount === 2).length, evaluations.length),
    timeoutRate: metric(evaluations.filter((item) => item.result.status === "timed-out").length, evaluations.length),
    unavailableRate: metric(evaluations.filter((item) => item.result.status === "unavailable").length, evaluations.length),
    ruleContractRate: metric(
      valid.filter((item) => item.expectedRuleIds !== undefined && sameStringSet(item.result.ruleIds, item.expectedRuleIds)).length,
      valid.filter((item) => item.expectedRuleIds !== undefined).length,
    ),
    evidenceContractRate: metric(valid.length, evaluations.length),
  };
}

function sliceReports(evaluations: QualityBenchmarkEvaluation[], policy: QualityBenchmarkPolicy): QualityBenchmarkModelReport["slices"] {
  const reports: QualityBenchmarkModelReport["slices"] = [];
  for (const dimension of policy.majorSlices) {
    const values = new Map<string, QualityBenchmarkEvaluation[]>();
    for (const evaluation of evaluations) {
      const value = sliceValue(evaluation, dimension);
      for (const item of Array.isArray(value) ? value : [value]) {
        if (!item) continue;
        values.set(item, [...(values.get(item) ?? []), evaluation]);
      }
    }
    for (const [value, entries] of [...values.entries()].sort(([a], [b]) => a.localeCompare(b))) {
      reports.push({ dimension, value, sampleCount: entries.length, metrics: metricsFor(entries) });
    }
  }
  return reports;
}

function sliceValue(
  evaluation: QualityBenchmarkEvaluation,
  dimension: QualityBenchmarkPolicy["majorSlices"][number],
): string | string[] | undefined {
  if (dimension === "rule") return evaluation.expectedRuleIds ?? [];
  return evaluation.slice[dimension];
}

function decisionReasons(
  metrics: Record<QualityBenchmarkMetricName, QualityBenchmarkMetric>,
  knownCount: number,
  p95LatencyMs: number,
  policy: QualityBenchmarkPolicy,
  stopped: string[],
): string[] {
  const reasons = [...new Set(stopped)];
  if (knownCount === 0) reasons.push("no expected labels are available; classification metrics are inconclusive");
  reasons.push(...thresholdReasons(metrics, policy));
  if (p95LatencyMs > policy.goNoGo.maximumP95LatencyMs) reasons.push("p95 latency above threshold");
  return [...new Set(reasons)];
}

function thresholdReasons(
  metrics: Record<QualityBenchmarkMetricName, QualityBenchmarkMetric>,
  policy: QualityBenchmarkPolicy,
): string[] {
  const reasons: string[] = [];
  if (metrics.expectedRewriteRecall.denominator > 0 && metrics.expectedRewriteRecall.wilson95Low < policy.goNoGo.minimumRecall) reasons.push("rewrite recall below threshold");
  if (metrics.passFalseRewriteRate.denominator > 0 && metrics.passFalseRewriteRate.wilson95High > policy.goNoGo.maximumFalseRewriteRate) reasons.push("pass false rewrite rate above threshold");
  if (metrics.verdictAgreement.denominator > 0 && metrics.verdictAgreement.wilson95Low < policy.goNoGo.minimumAgreement) reasons.push("verdict agreement below threshold");
  if (metrics.invalidRate.wilson95High > policy.goNoGo.maximumInvalidRate) reasons.push("invalid response rate above threshold");
  return reasons;
}

function earlyStopReason(evaluations: QualityBenchmarkEvaluation[], policy: QualityBenchmarkPolicy): string | undefined {
  const metrics = metricsFor(evaluations);
  if (metrics.invalidRate.denominator > 0 && metrics.invalidRate.value > policy.earlyStop.invalidRate) return "early stop: invalid response rate";
  if (metrics.timeoutRate.denominator > 0 && metrics.timeoutRate.value > policy.earlyStop.timeoutRate) return "early stop: timeout rate";
  if (metrics.passFalseRewriteRate.denominator > 0 && metrics.passFalseRewriteRate.value > policy.earlyStop.falseRewriteRate) return "early stop: pass false rewrite rate";
  return undefined;
}

function budgetReservationReason(evaluations: QualityBenchmarkEvaluation[], model: QualityBenchmarkModel, policy: QualityBenchmarkPolicy): string | undefined {
  const usedRequests = evaluations.reduce((total, item) => total + item.result.requestCount, 0);
  const usedTokens = evaluations.reduce((total, item) => total + item.charge.chargedTokens, 0);
  const usedUsd = evaluations.reduce((total, item) => total + item.charge.chargedUsd, 0);
  const reservedTokens = 2 * (policy.maxInputTokensPerRequest + maxQualityJudgeOutputTokens);
  const reservedUsd = 2 * (
    (policy.maxInputTokensPerRequest * model.pricing.inputUsdPerMillionTokens
      + maxQualityJudgeOutputTokens * model.pricing.outputUsdPerMillionTokens) / 1_000_000
  );
  if (usedRequests + 2 > policy.requestCap) return "budget reserved: request cap";
  if (usedTokens + reservedTokens > policy.tokenCap) return "budget reserved: token cap";
  if (usedUsd + reservedUsd > policy.costCapUsd) return "budget reserved: cost cap";
  return undefined;
}

function chargeForResult(usage: ResponseUsage | undefined, requestCount: number, pricing: QualityBenchmarkPricing, policy: QualityBenchmarkPolicy): QualityBenchmarkEvaluation["charge"] {
  const reservedTokens = requestCount * (policy.maxInputTokensPerRequest + maxQualityJudgeOutputTokens);
  const input = usage?.inputTokens;
  const output = usage?.outputTokens;
  const reportedTotal = usage?.totalTokens ?? usage?.effectiveTokens;
  const chargedTokens = Number.isFinite(reportedTotal) ? Math.max(0, Math.round(reportedTotal!)) : reservedTokens;
  const chargedUsd = (Number.isFinite(input) && Number.isFinite(output))
    ? ((Math.max(0, input!) * pricing.inputUsdPerMillionTokens) + (Math.max(0, output!) * pricing.outputUsdPerMillionTokens)) / 1_000_000
    : reservedTokens * Math.max(pricing.inputUsdPerMillionTokens, pricing.outputUsdPerMillionTokens) / 1_000_000;
  return { reservedTokens, chargedTokens, chargedUsd: round(chargedUsd) };
}

function reportIdentity(identity: QualityBenchmarkIdentity): QualityBenchmarkReport["identity"] {
  const artifacts = identity.runtime.ruleManifest.artifacts;
  const primaryLanguage = identity.runtime.ruleManifest.primaryLanguage;
  const rubric = artifacts[`judge-rubric.${primaryLanguage}.md`];
  const rules = artifacts[`judge-rules.${primaryLanguage}.json`];
  const resultSchema = artifacts["schemas/judge-result.schema.json"];
  if (!rubric || !rules || !resultSchema) throw new Error("Verified Rule Pack is missing benchmark identity artifacts.");
  return {
    vesicleCommit: identity.vesicleCommit,
    harness: {
      id: identity.runtime.packId,
      version: identity.runtime.packVersion,
      sourceCommit: identity.runtime.sourceCommit,
      manifestSha256: identity.runtime.manifestSha256,
    },
    rulePack: { version: identity.runtime.ruleManifest.version, sourceHash: identity.runtime.ruleManifest.sourceHash },
    artifacts: { rubricSha256: rubric, judgeRulesSha256: rules, resultSchemaSha256: resultSchema },
    corpusSha256: identity.corpusSha256,
  };
}

function candidateTypeForTarget(targetType: string): QualityCandidateType {
  if (targetType === "narrative-prose") return "runtime.prose";
  throw new Error(`Benchmark targetType ${targetType} is not supported by the Runtime Semantic Judge.`);
}

function requiredJudgeContract(runtime: QualityRuntimeContext): QualityJudgeContract {
  if (!runtime.judge) throw new Error("The active verified Harness does not provide a Semantic Judge contract.");
  return runtime.judge;
}

function validateOptions(options: RunQualityBenchmarkOptions): void {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(options.runId)) throw new Error("Benchmark runId must be kebab-case.");
  if (options.cases.length === 0 || options.models.length === 0) throw new Error("Benchmark requires at least one case and model.");
  for (const value of [options.policy.repeatsPerCase, options.policy.minimumSliceN, options.policy.requestCap, options.policy.tokenCap, options.policy.maxInputTokensPerRequest]) {
    if (!Number.isInteger(value) || value < 1) throw new Error("Benchmark integer caps must be positive.");
  }
  if (!Number.isInteger(options.policy.judgeTimeoutMs) || options.policy.judgeTimeoutMs < 1_000 || options.policy.judgeTimeoutMs > 180_000) {
    throw new Error("Benchmark Judge timeout must be an integer from 1000 to 180000 milliseconds.");
  }
  if (!Number.isFinite(options.policy.costCapUsd) || options.policy.costCapUsd <= 0) {
    throw new Error("Benchmark cost cap must be positive.");
  }
  if (!Number.isFinite(options.policy.minimumIntervalMs) || options.policy.minimumIntervalMs < 0) {
    throw new Error("Benchmark minimum interval must be non-negative.");
  }
  for (const value of [
    options.policy.goNoGo.minimumRecall,
    options.policy.goNoGo.maximumFalseRewriteRate,
    options.policy.goNoGo.minimumAgreement,
    options.policy.goNoGo.maximumInvalidRate,
  ]) {
    if (!Number.isFinite(value) || value < 0 || value > 1) throw new Error("Benchmark go/no-go rates must be between zero and one.");
  }
  if (!Number.isFinite(options.policy.goNoGo.maximumP95LatencyMs) || options.policy.goNoGo.maximumP95LatencyMs < 0) {
    throw new Error("Benchmark p95 latency threshold must be non-negative.");
  }
  for (const value of Object.values(options.policy.earlyStop)) {
    if (!Number.isFinite(value) || value < 0 || value > 1) throw new Error("Benchmark early-stop rates must be between zero and one.");
  }
  if (new Set(options.cases.map((item) => item.caseId)).size !== options.cases.length) throw new Error("Benchmark case ids must be unique.");
  if (new Set(options.models.map(modelKey)).size !== options.models.length) throw new Error("Benchmark models must be unique.");
  for (const item of options.cases) {
    if (!item.caseId || !item.text || !item.targetType || !item.genre || !item.modelFamily || !item.lengthBucket || !item.pov
      || !/^[a-f0-9]{64}$/.test(item.candidateSha256) || sha256(item.text) !== item.candidateSha256) {
      throw new Error(`Benchmark case ${item.caseId || "<unknown>"} is invalid.`);
    }
    if ((item.expectedVerdict === "pass" && (item.expectedRuleIds?.length ?? 0) > 0)
      || (item.expectedVerdict === "rewrite" && (item.expectedRuleIds?.length ?? 0) === 0)
      || (item.expectedVerdict === undefined && item.expectedRuleIds !== undefined)) {
      throw new Error(`Benchmark case ${item.caseId} has inconsistent expected labels.`);
    }
  }
  for (const model of options.models) {
    if (!model.providerAlias || !model.modelId || !Number.isFinite(model.pricing.inputUsdPerMillionTokens)
      || !Number.isFinite(model.pricing.outputUsdPerMillionTokens) || model.pricing.inputUsdPerMillionTokens < 0
      || model.pricing.outputUsdPerMillionTokens < 0) {
      throw new Error(`Benchmark model ${model.modelId || "<unknown>"} is invalid.`);
    }
  }
}

function benchmarkPlanHash(options: Pick<RunQualityBenchmarkOptions, "runId" | "cases" | "models" | "identity" | "policy">): string {
  return sha256(JSON.stringify({
    version: benchmarkVersion,
    runId: options.runId,
    corpusSha256: options.identity.corpusSha256,
    harness: options.identity.runtime.manifestSha256,
    policy: options.policy,
    cases: options.cases.map(({ caseId, candidateSha256, expectedVerdict, expectedRuleIds }) => ({ caseId, candidateSha256, expectedVerdict, expectedRuleIds })).sort(byJson),
    models: options.models.map(({ providerAlias, protocol, modelId, pricing }) => ({ providerAlias, protocol, modelId, pricing })).sort(byJson),
  }));
}

function parseEvaluation(value: unknown, line: number): QualityBenchmarkEvaluation {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`Benchmark output line ${line} must be an object.`);
  const item = value as Partial<QualityBenchmarkEvaluation>;
  if (item.schema !== "quality-judge-benchmark-evaluation/v1" || !item.runId || !item.planSha256 || !item.model || !item.caseId || !item.repeat || !item.candidateSha256 || !item.slice || !item.result || !item.charge) {
    throw new Error(`Benchmark output line ${line} is invalid.`);
  }
  if (typeof item.result !== "object" || !["valid", "invalid", "timed-out", "unavailable"].includes(item.result.status ?? "")) throw new Error(`Benchmark output line ${line} has an invalid result.`);
  return item as QualityBenchmarkEvaluation;
}

function metric(numerator: number, denominator: number): QualityBenchmarkMetric {
  if (denominator === 0) return { value: 0, numerator, denominator, wilson95Low: 0, wilson95High: 0 };
  const value = numerator / denominator;
  const z = 1.959963984540054;
  const factor = 1 + z ** 2 / denominator;
  const center = (value + z ** 2 / (2 * denominator)) / factor;
  const margin = z * Math.sqrt((value * (1 - value) + z ** 2 / (4 * denominator)) / denominator) / factor;
  return { value: round(value), numerator, denominator, wilson95Low: round(Math.max(0, center - margin)), wilson95High: round(Math.min(1, center + margin)) };
}

function usageTotals(evaluations: QualityBenchmarkEvaluation[]): { inputTokens: number; outputTokens: number; totalTokens: number } {
  return evaluations.reduce((total, item) => ({
    inputTokens: total.inputTokens + safeUsage(item.result.usage?.inputTokens),
    outputTokens: total.outputTokens + safeUsage(item.result.usage?.outputTokens),
    totalTokens: total.totalTokens + safeUsage(item.result.usage?.totalTokens ?? item.result.usage?.effectiveTokens),
  }), { inputTokens: 0, outputTokens: 0, totalTokens: 0 });
}

function latencySummary(values: number[]): { average: number; p50: number; p95: number } {
  if (values.length === 0) return { average: 0, p50: 0, p95: 0 };
  const sorted = [...values].sort((a, b) => a - b);
  return {
    average: round(sorted.reduce((total, value) => total + value, 0) / sorted.length),
    p50: percentile(sorted, 0.5),
    p95: percentile(sorted, 0.95),
  };
}

function percentile(values: number[], percentile: number): number {
  return round(values[Math.min(values.length - 1, Math.max(0, Math.ceil(values.length * percentile) - 1))]!);
}

function boundedUsage(usage: ResponseUsage): ResponseUsage {
  const bounded: ResponseUsage = {};
  for (const [key, value] of Object.entries(usage)) {
    if (typeof value === "number" && Number.isFinite(value) && value >= 0) Object.assign(bounded, { [key]: Math.round(value) });
  }
  return bounded;
}

function predictedVerdict(item: QualityBenchmarkEvaluation): "pass" | "rewrite" | undefined {
  return item.result.status === "valid" ? item.result.verdict : undefined;
}

function sameStringSet(left: string[], right: string[]): boolean {
  const sortedLeft = [...left].sort();
  const sortedRight = [...right].sort();
  return sortedLeft.length === sortedRight.length && sortedLeft.every((item, index) => item === sortedRight[index]);
}

function evaluationKey(item: Pick<QualityBenchmarkEvaluation, "model" | "caseId" | "repeat">): string {
  return `${modelKey(item.model)}\0${item.caseId}\0${item.repeat}`;
}

function evaluationKeyFor(model: QualityBenchmarkModel, item: QualityBenchmarkCase, repeat: number): string {
  return evaluationKey({ model, caseId: item.caseId, repeat });
}

function modelKey(model: Pick<QualityBenchmarkModel, "providerAlias" | "protocol" | "modelId">): string {
  return `${model.providerAlias}\0${model.protocol}\0${model.modelId}`;
}

function sameModel(evaluation: QualityBenchmarkEvaluation, model: QualityBenchmarkModel): boolean {
  return modelKey(evaluation.model) === modelKey(model);
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function byJson(left: unknown, right: unknown): number {
  return JSON.stringify(left).localeCompare(JSON.stringify(right));
}

function firstDuplicate(values: string[]): string | undefined {
  const seen = new Set<string>();
  return values.find((value) => seen.has(value) || !seen.add(value));
}

function safeUsage(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.round(value)) : 0;
}

function round(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

function isNotFound(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "ENOENT");
}

function assertNotAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw signal.reason ?? new DOMException("Benchmark cancelled.", "AbortError");
}

async function sleepWithSignal(milliseconds: number, signal?: AbortSignal): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const finish = () => {
      signal?.removeEventListener("abort", abort);
      resolve();
    };
    const timer = setTimeout(finish, milliseconds);
    const abort = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      reject(signal?.reason ?? new DOMException("Benchmark cancelled.", "AbortError"));
    };
    signal?.addEventListener("abort", abort, { once: true });
  });
}
