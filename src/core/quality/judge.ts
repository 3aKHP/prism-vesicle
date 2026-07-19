import type { ProviderAdapter, ResponseUsage, VesicleRequest, VesicleResponse } from "../../providers/shared/types";
import type {
  ExperimentalQualityProfileSnapshot,
  QualityCandidateType,
  QualityFinding,
  QualityJudgeContract,
  QualityJudgeRule,
  QualityJudgeStatus,
  QualityRuntimeContext,
  QualityTargetWarningReason,
} from "./types";
import { maxQualityRewriteAttempts, type BoundQualityEvaluation } from "./guard";
import type { ExperimentalQualityProfile } from "../../config/quality";

export const maxQualityJudgeCodeUnits = 30_000;
export const maxQualityJudgeOutputTokens = 2_048;
export const defaultQualityJudgeTimeoutMs = 15_000;

export type QualityJudgeParsedResult = {
  verdict: "pass" | "rewrite";
  confidence: number;
  findings: QualityFinding[];
};

export type QualityJudgeRunResult = {
  status: Exclude<QualityJudgeStatus, "not-run">;
  findings: QualityFinding[];
  durationMs: number;
  requestCount: number;
  usage?: ResponseUsage;
};

export async function observeBoundQualityWithJudge(options: {
  result: BoundQualityEvaluation;
  runtime: QualityRuntimeContext;
  experimentalProfile?: ExperimentalQualityProfile;
  state: { attempts: number; rejectedHashes: Set<string> };
  signal?: AbortSignal;
}): Promise<BoundQualityEvaluation> {
  const contract = options.runtime.judge;
  const profile = options.experimentalProfile;
  if (!contract || !profile
    || options.result.candidate.producer !== "runtime"
    || options.result.decision !== "pass") return options.result;

  const candidates = (options.result.targetEvaluations
    ? options.result.targetEvaluations.map((target) => ({
        targetId: target.target.id,
        targetKind: "artifact-post-image" as const,
        candidateType: target.candidate.type,
        content: target.evaluation.normalizedContent,
      }))
    : [{
        targetId: options.result.assessments[0]!.targetId,
        targetKind: "assistant-response" as const,
        candidateType: options.result.candidate.type,
        content: options.result.evaluation.normalizedContent,
      }]).filter((candidate) =>
    !options.result.event.targets.find((target) => target.id === candidate.targetId)?.warningReason
  );
  if (candidates.length === 0) return options.result;
  let judgeMs = 0;
  let judgeRequestCount = 0;
  let judgeUsage: ResponseUsage | undefined;
  const statuses: QualityJudgeStatus[] = [];
  for (const candidate of candidates) {
    const oversize = candidate.content.length > maxQualityJudgeCodeUnits;
    const judged = await runQualityJudge({
      provider: profile.provider,
      providerId: profile.providerId,
      model: profile.modelId,
      contract,
      candidateType: candidate.candidateType,
      targetKind: candidate.targetKind,
      content: candidate.content,
      signal: options.signal,
      timeoutMs: profile.judgeTimeoutMs,
      temperatureSupported: profile.temperatureSupported,
      reasoningTierSupported: profile.reasoningTierSupported,
    });
    statuses.push(judged.status);
    judgeMs += judged.durationMs;
    judgeRequestCount += judged.requestCount;
    judgeUsage = addUsage(judgeUsage, judged.usage);
    const assessment = options.result.assessments.find((item) => item.targetId === candidate.targetId);
    if (assessment) {
      assessment.judgeStatus = judged.status;
      assessment.judgeFindings = judged.findings;
    }
    const target = options.result.event.targets.find((item) => item.id === candidate.targetId);
    if (!target) continue;
    if (judged.status === "valid") {
      const summaries = judged.findings.map((finding) => ({
        ruleId: finding.ruleId,
        title: finding.title,
        severity: finding.severity,
        maturity: finding.maturity,
        evidence: finding.evidence.slice(0, 240),
        source: "judge" as const,
        ...(finding.confidence === undefined ? {} : { confidence: finding.confidence }),
      }));
      target.findings = [...target.findings, ...summaries].slice(0, 16);
      target.findingIds = [...new Set([...target.findingIds, ...judged.findings.map((finding) => finding.ruleId)])].slice(0, 32);
      if (judged.findings.length > 0 && target.status === "clean") target.status = "findings";
    } else {
      target.status = "warning";
      target.warningReason = judgeWarningReason(judged.status, oversize);
    }
  }

  const judgeStatus = aggregateJudgeStatus(statuses);
  options.result.event.judgeMs = Math.round(judgeMs * 1_000) / 1_000;
  options.result.event.judgeStatus = judgeStatus;
  options.result.event.judgeProvider = profile.providerId;
  options.result.event.judgeModel = profile.modelId;
  options.result.event.judgeRequestCount = judgeRequestCount;
  options.result.event.experimentalJudge = snapshotProfile(profile);
  if (judgeUsage) options.result.event.judgeUsage = boundedUsage(judgeUsage);
  options.result.event.findingIds = [...new Set(options.result.event.targets.flatMap((target) => target.findingIds))].slice(0, 32);
  if (judgeStatus !== "valid") {
    options.result.outcome = "inconclusive";
    options.result.action = "deliver";
  } else if (profile.mode === "rewrite" && options.result.assessments.some((assessment) => assessment.judgeFindings.length > 0)) {
    promoteExperimentalRewrite(options.result, options.state);
  } else if (options.result.outcome !== "inconclusive"
    && options.result.assessments.some((assessment) => assessment.judgeFindings.length > 0)) {
    options.result.outcome = "findings";
    options.result.action = "observe";
  }
  options.result.event.outcome = options.result.outcome;
  options.result.event.action = options.result.action;
  return options.result;
}

function promoteExperimentalRewrite(
  result: BoundQualityEvaluation,
  state: { attempts: number; rejectedHashes: Set<string> },
): void {
  const targetById = new Map(result.event.targets.map((target) => [target.id, target]));
  for (const assessment of result.assessments) {
    if (assessment.judgeFindings.length === 0) continue;
    const targetEvaluation = result.targetEvaluations?.find((item) => item.target.id === assessment.targetId);
    const evaluation = targetEvaluation?.evaluation ?? result.evaluation;
    evaluation.findings = [...evaluation.findings, ...assessment.judgeFindings];
    evaluation.blockingFindings = [...evaluation.blockingFindings, ...assessment.judgeFindings];
    const target = targetById.get(assessment.targetId);
    if (!target || target.warningReason) continue;
    const summaries = assessment.judgeFindings.map(summaryForEvent);
    target.findings = [...target.findings, ...summaries].slice(0, 16);
    target.findingIds = [...new Set([...target.findingIds, ...assessment.judgeFindings.map((finding) => finding.ruleId)])].slice(0, 32);
  }
  result.evaluation.findings = [...new Set(result.assessments.flatMap((assessment) => assessment.detectorFindings.concat(assessment.judgeFindings)))];
  result.evaluation.blockingFindings = result.assessments.flatMap((assessment) => assessment.judgeFindings);
  const blocked = result.assessments.filter((assessment) => assessment.judgeFindings.length > 0);
  const repeated = result.targetEvaluations
    ? result.targetEvaluations.some((item) => blocked.some((assessment) => assessment.targetId === item.target.id)
      && item.target.rejectedHashes.has(item.target.postImageHash))
    : state.rejectedHashes.has(result.evaluation.candidateHash);
  if (repeated || state.attempts >= maxQualityRewriteAttempts) {
    result.decision = "exhausted";
    result.outcome = "exhausted";
    result.action = "ask-user";
  } else {
    if (result.targetEvaluations) {
      for (const item of result.targetEvaluations) {
        if (blocked.some((assessment) => assessment.targetId === item.target.id)) item.target.rejectedHashes.add(item.target.postImageHash);
      }
    } else {
      state.rejectedHashes.add(result.evaluation.candidateHash);
    }
    state.attempts += 1;
    result.decision = "rewrite";
    result.outcome = "rewrite-required";
    result.action = "rewrite";
  }
  for (const assessment of blocked) {
    const target = targetById.get(assessment.targetId);
    if (target && !target.warningReason) target.status = result.decision === "exhausted" ? "warning" : "rewrite-required";
  }
  result.event.decision = result.decision;
  result.event.outcome = result.outcome;
  result.event.action = result.action;
  result.event.findingIds = [...new Set(result.event.targets.flatMap((target) => target.findingIds))].slice(0, 32);
}

function summaryForEvent(finding: QualityFinding) {
  return {
    ruleId: finding.ruleId,
    title: finding.title,
    severity: finding.severity,
    maturity: finding.maturity,
    evidence: finding.evidence.slice(0, 240),
    source: "judge" as const,
    ...(finding.confidence === undefined ? {} : { confidence: finding.confidence }),
  };
}

function snapshotProfile(profile: ExperimentalQualityProfile): ExperimentalQualityProfileSnapshot {
  return {
    mode: profile.mode,
    providerId: profile.providerId,
    modelId: profile.modelId,
    protocol: profile.protocol,
    judgeTimeoutMs: profile.judgeTimeoutMs,
    configIdentity: profile.configIdentity,
  };
}

export async function runQualityJudge(options: {
  provider: ProviderAdapter;
  providerId: string;
  model: string;
  contract: QualityJudgeContract;
  candidateType: QualityCandidateType;
  targetKind: "assistant-response" | "artifact-post-image";
  content: string;
  signal?: AbortSignal;
  timeoutMs?: number;
  temperatureSupported?: boolean;
  reasoningTierSupported?: boolean;
}): Promise<QualityJudgeRunResult> {
  const started = performance.now();
  if (options.content.length > maxQualityJudgeCodeUnits) {
    return { status: "unavailable", findings: [], durationMs: elapsed(started), requestCount: 0 };
  }

  const linked = linkedTimeoutSignal(options.signal, options.timeoutMs ?? defaultQualityJudgeTimeoutMs);
  let requestCount = 0;
  let usage: ResponseUsage | undefined;
  try {
    const request = judgeRequest(options, linked.signal, firstJudgePrompt(options));
    requestCount += 1;
    const first = await completeJudgeRequest(options.provider, request);
    usage = addUsage(usage, first.usage);
    try {
      const parsed = parseQualityJudgeResponse(assertToolFreeResponse(first), options.content, options.contract.rules);
      return { status: "valid", findings: parsed.findings, durationMs: elapsed(started), requestCount, ...(usage ? { usage } : {}) };
    } catch {
      const repair = judgeRequest(options, linked.signal, repairJudgePrompt(options, first.content));
      requestCount += 1;
      const repaired = await completeJudgeRequest(options.provider, repair);
      usage = addUsage(usage, repaired.usage);
      try {
        const parsed = parseQualityJudgeResponse(assertToolFreeResponse(repaired), options.content, options.contract.rules);
        return { status: "valid", findings: parsed.findings, durationMs: elapsed(started), requestCount, ...(usage ? { usage } : {}) };
      } catch {
        return { status: "invalid", findings: [], durationMs: elapsed(started), requestCount, ...(usage ? { usage } : {}) };
      }
    }
  } catch (error) {
    if (options.signal?.aborted) throw options.signal.reason ?? error;
    return {
      status: linked.timedOut() ? "timed-out" : "unavailable",
      findings: [],
      durationMs: elapsed(started),
      requestCount,
      ...(usage ? { usage } : {}),
    };
  } finally {
    linked.dispose();
  }
}

export function parseQualityJudgeResponse(
  content: string,
  candidate: string,
  rules: QualityJudgeRule[],
): QualityJudgeParsedResult {
  let value: unknown;
  try {
    value = JSON.parse(content.trim()) as unknown;
  } catch (error) {
    throw new Error(`Semantic Judge response is not strict JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  const root = strictObject(value, "Semantic Judge result", ["schema", "verdict", "confidence", "findings"]);
  if (root.schema !== "quality-judge-result/v1") throw new Error("Semantic Judge result schema is unsupported.");
  if (root.verdict !== "pass" && root.verdict !== "rewrite") throw new Error("Semantic Judge verdict is invalid.");
  const confidence = boundedNumber(root.confidence, "Semantic Judge confidence");
  if (!Array.isArray(root.findings)) throw new Error("Semantic Judge findings must be a list.");
  if ((root.verdict === "pass" && root.findings.length !== 0)
    || (root.verdict === "rewrite" && root.findings.length === 0)) {
    throw new Error("Semantic Judge verdict does not match its findings.");
  }
  const byId = new Map(rules.map((rule) => [rule.id, rule]));
  const seenRuleIds = new Set<string>();
  const findings = root.findings.map((value, index) => {
    const label = `Semantic Judge finding ${index + 1}`;
    const finding = strictObject(value, label, [
      "ruleId", "evidence", "confidence", "explanation", "rewriteInstruction",
    ]);
    const ruleId = nonEmptyString(finding.ruleId, `${label} ruleId`);
    const rule = byId.get(ruleId);
    if (!rule) throw new Error(`${label} references unknown rule ${ruleId}.`);
    if (seenRuleIds.has(ruleId)) throw new Error(`${label} duplicates rule ${ruleId}.`);
    seenRuleIds.add(ruleId);
    const evidence = nonEmptyString(finding.evidence, `${label} evidence`);
    const evidenceCodePoints = [...evidence].length;
    if (evidenceCodePoints < rule.evidence.minCodePoints
      || evidenceCodePoints > Math.min(rule.evidence.maxCodePoints, 240)) {
      throw new Error(`${label} evidence is outside the rule bounds.`);
    }
    const start = candidate.indexOf(evidence);
    if (start < 0) throw new Error(`${label} evidence is not an exact candidate substring.`);
    return {
      ruleId,
      title: rule.title,
      severity: rule.severity,
      maturity: rule.maturity,
      start,
      end: start + evidence.length,
      evidence,
      source: "judge" as const,
      confidence: boundedNumber(finding.confidence, `${label} confidence`),
      explanation: boundedString(finding.explanation, `${label} explanation`, 500),
      rewriteInstruction: boundedString(finding.rewriteInstruction, `${label} rewriteInstruction`, 500),
    };
  });
  return { verdict: root.verdict, confidence, findings };
}

async function completeJudgeRequest(provider: ProviderAdapter, request: VesicleRequest): Promise<VesicleResponse> {
  if (!provider.stream) return provider.complete(request);
  let response: VesicleResponse | undefined;
  for await (const event of provider.stream(request)) {
    if (event.type === "complete") response = event.response;
  }
  if (!response) throw new Error("Semantic Judge provider stream ended without a final response.");
  return response;
}

function judgeRequest(
  options: Parameters<typeof runQualityJudge>[0],
  signal: AbortSignal,
  prompt: string,
): VesicleRequest {
  return {
    id: `quality-judge_${crypto.randomUUID()}`,
    model: { provider: options.providerId, model: options.model },
    system: [judgeSystemPrompt(options.contract)],
    messages: [{ role: "user", content: prompt }],
    tools: [],
    signal,
    generation: {
      ...(options.temperatureSupported === false ? {} : { temperature: 0 }),
      maxTokens: maxQualityJudgeOutputTokens,
      ...(options.reasoningTierSupported === true ? { reasoningTier: "off" as const } : {}),
    },
    metadata: { kind: "quality-judge", candidateType: options.candidateType, targetKind: options.targetKind },
  };
}

function judgeSystemPrompt(contract: QualityJudgeContract): string {
  return [
    contract.rubric.trim(),
    "",
    "The following output contract is authoritative and overrides any older JSON example in the rubric.",
    "Return exactly one JSON object with no Markdown fence and these exact keys:",
    '{"schema":"quality-judge-result/v1","verdict":"pass|rewrite","confidence":0.0,"findings":[{"ruleId":"known-rule-id","evidence":"exact candidate substring","confidence":0.0,"explanation":"short reason","rewriteInstruction":"short direction"}]}',
    "Use verdict pass with an empty findings list. Use verdict rewrite with one or more findings.",
    "Never call tools and never claim whether the text was written by AI or a human.",
  ].join("\n");
}

function firstJudgePrompt(options: Parameters<typeof runQualityJudge>[0]): string {
  return JSON.stringify({
    task: "Assess only the candidate prose against the verified rubric and return the exact JSON contract.",
    target: { candidateType: options.candidateType, kind: options.targetKind },
    candidate: options.content,
  });
}

function repairJudgePrompt(options: Parameters<typeof runQualityJudge>[0], invalidResponse: string): string {
  return JSON.stringify({
    task: "Repair the prior response into the exact JSON contract. Reassess if needed. Return JSON only.",
    target: { candidateType: options.candidateType, kind: options.targetKind },
    candidate: options.content,
    priorInvalidResponse: invalidResponse.slice(0, 16_384),
  });
}

function assertToolFreeResponse(response: VesicleResponse): string {
  if ((response.toolCalls?.length ?? 0) > 0) throw new Error("Semantic Judge attempted to call a tool.");
  return response.content;
}

function linkedTimeoutSignal(parent: AbortSignal | undefined, timeoutMs: number): {
  signal: AbortSignal;
  timedOut: () => boolean;
  dispose: () => void;
} {
  const controller = new AbortController();
  let timeout = false;
  const onAbort = () => controller.abort(parent?.reason);
  if (parent?.aborted) onAbort();
  else parent?.addEventListener("abort", onAbort, { once: true });
  const timer = setTimeout(() => {
    timeout = true;
    controller.abort(new DOMException("Semantic Judge timed out.", "TimeoutError"));
  }, timeoutMs);
  return {
    signal: controller.signal,
    timedOut: () => timeout,
    dispose: () => {
      clearTimeout(timer);
      parent?.removeEventListener("abort", onAbort);
    },
  };
}

function addUsage(current: ResponseUsage | undefined, next: ResponseUsage | undefined): ResponseUsage | undefined {
  if (!next) return current;
  const result: ResponseUsage = { ...(current ?? {}) };
  for (const key of [
    "contextInputTokens", "inputTokens", "outputTokens", "totalTokens", "cacheReadInputTokens",
    "cacheWriteInputTokens", "cacheHitInputTokens", "cacheMissInputTokens", "reasoningTokens", "effectiveTokens",
  ] as const) {
    const value = next[key];
    if (typeof value === "number" && Number.isFinite(value)) result[key] = (result[key] ?? 0) + value;
  }
  return result;
}

function boundedUsage(usage: ResponseUsage): ResponseUsage {
  const result: ResponseUsage = {};
  for (const key of [
    "contextInputTokens", "inputTokens", "outputTokens", "totalTokens", "cacheReadInputTokens",
    "cacheWriteInputTokens", "cacheHitInputTokens", "cacheMissInputTokens", "reasoningTokens", "effectiveTokens",
  ] as const) {
    if (usage[key] !== undefined && Number.isFinite(usage[key])) result[key] = usage[key];
  }
  return result;
}

function aggregateJudgeStatus(statuses: QualityJudgeStatus[]): QualityJudgeStatus {
  for (const status of ["timed-out", "invalid", "unavailable"] as const) {
    if (statuses.includes(status)) return status;
  }
  return statuses.length > 0 ? "valid" : "not-run";
}

function judgeWarningReason(status: QualityJudgeStatus, oversize: boolean): QualityTargetWarningReason {
  if (oversize) return "target-oversize";
  if (status === "timed-out") return "judge-timeout";
  if (status === "invalid") return "judge-invalid";
  return "judge-unavailable";
}

function strictObject(value: unknown, label: string, keys: string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object.`);
  const raw = value as Record<string, unknown>;
  const expected = new Set(keys);
  const unknown = Object.keys(raw).find((key) => !expected.has(key));
  if (unknown) throw new Error(`${label} contains unknown field ${unknown}.`);
  const missing = keys.find((key) => !Object.hasOwn(raw, key));
  if (missing) throw new Error(`${label} is missing ${missing}.`);
  return raw;
}

function nonEmptyString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) throw new Error(`${label} must be a non-empty string.`);
  return value;
}

function boundedString(value: unknown, label: string, maxLength: number): string {
  const result = nonEmptyString(value, label);
  if (result.length > maxLength) throw new Error(`${label} is too long.`);
  return result;
}

function boundedNumber(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error(`${label} must be between 0 and 1.`);
  }
  return value;
}

function elapsed(started: number): number {
  return Math.round((performance.now() - started) * 1_000) / 1_000;
}
