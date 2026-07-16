import { createHash } from "node:crypto";
import type { VesicleResponse } from "../../providers/shared/types";
import type { ResponseUsage } from "../../providers/shared/types";
import type { EngineId } from "../engine/profile";
import type { HarnessQualityMode } from "../harness/types";
import type { SessionStore } from "../session/store";
import type { ToolCall } from "../tools";
import { evaluateQualityCandidate } from "./detector";
import type {
  QualityCandidate,
  QualityArtifactTarget,
  QualityCandidateType,
  QualityAction,
  QualityArtifactReadResult,
  QualityAssessment,
  QualityDecision,
  QualityEvaluation,
  QualityEvent,
  QualityEventTarget,
  QualityOutcome,
  QualityRewriteState,
  QualityRuntimeContext,
} from "./types";
import { qualityCandidateTypeForProducer } from "./targets";

export const maxQualityRewriteAttempts = 2;

export type BoundQualityEvaluation = {
  mode: HarnessQualityMode;
  candidate: QualityCandidate;
  evaluation: QualityEvaluation;
  assessments: QualityAssessment[];
  outcome: QualityOutcome;
  action: QualityAction;
  decision: QualityDecision;
  event: QualityEvent;
  targetEvaluations?: Array<{
    target: QualityArtifactTarget;
    candidate: QualityCandidate;
    evaluation: QualityEvaluation;
    warningReason?: "target-unreadable" | "target-oversize";
  }>;
};

export function qualityModeForEngine(runtime: QualityRuntimeContext | undefined, engine: EngineId): HarnessQualityMode {
  return runtime?.engineModes[engine] ?? "off";
}

export function qualityModeForAgent(runtime: QualityRuntimeContext | undefined, agent: string): HarnessQualityMode {
  return runtime?.agentModes[agent] ?? "off";
}

export function shouldBufferQualityOutput(mode: HarnessQualityMode): boolean {
  return mode === "rewrite" || mode === "strict";
}

export function qualityCandidateParts(response: VesicleResponse): string[] {
  const parts: string[] = [];
  if (response.content.trim()) parts.push(response.content);
  parts.push(...qualityMutationParts(response));
  return parts;
}

export function qualityMutationParts(response: VesicleResponse): string[] {
  const parts: string[] = [];
  for (const call of response.toolCalls ?? []) {
    const mutation = mutationContent(call);
    if (mutation) parts.push(mutation);
  }
  return parts;
}

export function qualityMutationPartsForProducer(response: VesicleResponse, producer: string): string[] {
  if (producer === "weaver-orch") return [];
  return (response.toolCalls ?? []).flatMap((call) => {
    if ((producer === "weaver" || producer === "scene-writer") && !isSceneMutation(call)) return [];
    const content = mutationContent(call);
    return content ? [content] : [];
  });
}

export function isQualityBoundary(response: VesicleResponse): boolean {
  const calls = response.toolCalls ?? [];
  return calls.length === 0 || calls.some((call) => call.name === "request_confirmation" || call.name === "ask_user_question");
}

export function evaluateBoundQuality(options: {
  runtime: QualityRuntimeContext;
  producer: EngineId | string;
  mode: HarnessQualityMode;
  content: string;
  attempt: number;
  state: QualityRewriteState;
  usage?: ResponseUsage;
}): BoundQualityEvaluation | undefined {
  const type = qualityCandidateTypeForProducer(options.producer);
  if (!type || options.mode === "off" || options.mode === "analyze") return undefined;
  const candidate: QualityCandidate = {
    producer: options.producer,
    type,
    content: extractProseCandidate(type, options.content),
  };
  const evaluation = evaluateQualityCandidate(candidate, options.runtime.rules);
  const decision = qualityDecision(options.mode, evaluation, options.state);
  const policy = qualityPolicy(options.mode, evaluation, decision);
  const assessment = qualityAssessment(`assistant:${evaluation.candidateHash}`, evaluation);
  return {
    mode: options.mode,
    candidate,
    evaluation,
    assessments: [assessment],
    ...policy,
    decision,
    event: qualityEvent(options, type, evaluation, decision, policy),
  };
}

export function evaluateBoundQualityTargets(options: {
  runtime: QualityRuntimeContext;
  producer: EngineId | string;
  mode: HarnessQualityMode;
  targets: QualityArtifactReadResult[];
  attempt: number;
  state: QualityRewriteState;
  usage?: ResponseUsage;
}): BoundQualityEvaluation | undefined {
  const type = qualityCandidateTypeForProducer(options.producer);
  if (!type || options.mode === "off" || options.mode === "analyze" || options.targets.length === 0) return undefined;
  const targetEvaluations = options.targets.map(({ target, content, warningReason }) => {
    const candidate: QualityCandidate = {
      producer: options.producer,
      type,
      content: extractProseCandidate(type, content ?? ""),
    };
    return {
      target,
      candidate,
      evaluation: evaluateQualityCandidate(candidate, options.runtime.rules),
      ...(warningReason ? { warningReason } : {}),
    };
  });
  const evaluation = aggregateTargetEvaluations(targetEvaluations);
  const decision = qualityTargetDecision(options.mode, targetEvaluations, options.state);
  const policy = qualityPolicy(options.mode, evaluation, decision, targetEvaluations.some((target) => target.warningReason));
  const candidate: QualityCandidate = {
    producer: options.producer,
    type,
    content: targetEvaluations.map((item) => item.candidate.content).join("\n\n"),
  };
  return {
    mode: options.mode,
    candidate,
    evaluation,
    assessments: targetEvaluations.map(({ target, evaluation: targetEvaluation }) =>
      qualityAssessment(target.id, targetEvaluation)
    ),
    ...policy,
    decision,
    targetEvaluations,
    event: qualityEvent(options, type, evaluation, decision, policy, targetEvaluations),
  };
}

export async function recordQualityEvent(session: SessionStore, result: BoundQualityEvaluation): Promise<void> {
  await session.append({
    role: "system",
    content: "",
    metadata: { kind: "quality-event", qualityEvent: result.event },
  });
}

export function qualityRewriteFeedback(result: BoundQualityEvaluation, includeCandidate = false): string {
  return JSON.stringify({
    category: "quality_rewrite_required",
    guard: "anti-ai-flavor",
    attempt: result.event.attempt + 1,
    maxRewriteAttempts: maxQualityRewriteAttempts,
    candidateHash: result.evaluation.candidateHash,
    ...(includeCandidate ? { rejectedCandidate: result.candidate.content } : {}),
    ...(result.targetEvaluations ? {
      targets: result.targetEvaluations
        .filter((item) => item.evaluation.blockingFindings.length > 0)
        .map((item) => ({
          targetId: item.target.id,
          path: item.target.path,
          postImageHash: item.target.postImageHash,
          requirement: "Mutate this same path, then let the host recheck its complete post-image.",
          findings: qualityFeedbackFindings(item.evaluation.blockingFindings),
        })),
    } : {}),
    findings: qualityFeedbackFindings(result.evaluation.blockingFindings),
  });
}

function qualityFeedbackFindings(findings: QualityEvaluation["blockingFindings"]) {
  return findings.slice(0, 16).map((finding) => ({
    ruleId: finding.ruleId,
    evidence: finding.evidence,
    start: finding.start,
    end: finding.end,
    instruction: "Rewrite the affected prose while preserving facts, point of view, character logic, beats, required format, and target paths.",
  }));
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

function qualityDecision(
  mode: HarnessQualityMode,
  evaluation: QualityEvaluation,
  state: QualityRewriteState,
): QualityDecision {
  if (mode === "observe") return evaluation.findings.length > 0 ? "observe" : "pass";
  if (evaluation.blockingFindings.length === 0) return "pass";
  if (state.rejectedHashes.has(evaluation.candidateHash) || state.attempts >= maxQualityRewriteAttempts) return "exhausted";
  state.rejectedHashes.add(evaluation.candidateHash);
  state.attempts += 1;
  return "rewrite";
}

function qualityTargetDecision(
  mode: HarnessQualityMode,
  targets: NonNullable<BoundQualityEvaluation["targetEvaluations"]>,
  state: QualityRewriteState,
): QualityDecision {
  const findings = targets.flatMap((target) => target.evaluation.findings);
  if (mode === "observe") return findings.length > 0 ? "observe" : "pass";
  const blockingTargets = targets.filter((target) => target.evaluation.blockingFindings.length > 0);
  if (blockingTargets.length === 0) return "pass";
  if (state.attempts >= maxQualityRewriteAttempts
    || blockingTargets.some(({ target }) => target.rejectedHashes.has(target.postImageHash))) return "exhausted";
  for (const { target } of blockingTargets) target.rejectedHashes.add(target.postImageHash);
  state.attempts += 1;
  return "rewrite";
}

function aggregateTargetEvaluations(
  targets: NonNullable<BoundQualityEvaluation["targetEvaluations"]>,
): QualityEvaluation {
  const identity = targets
    .map(({ target }) => `${target.id}\0${target.postImageHash}`)
    .sort()
    .join("\0");
  return {
    normalizedContent: targets.map((target) => target.evaluation.normalizedContent).join("\n\n"),
    candidateHash: createHash("sha256").update(identity).digest("hex"),
    findings: targets.flatMap((target) => target.evaluation.findings),
    blockingFindings: targets.flatMap((target) => target.evaluation.blockingFindings),
    detectorMs: targets.reduce((total, target) => total + target.evaluation.detectorMs, 0),
  };
}

function qualityEvent(
  options: {
    runtime: QualityRuntimeContext;
    producer: EngineId | string;
    mode: HarnessQualityMode;
    attempt: number;
    usage?: ResponseUsage;
  },
  type: QualityCandidateType,
  evaluation: QualityEvaluation,
  decision: QualityDecision,
  policy: { outcome: QualityOutcome; action: QualityAction },
  targetEvaluations?: NonNullable<BoundQualityEvaluation["targetEvaluations"]>,
): QualityEvent {
  return {
    guard: "anti-ai-flavor",
    packId: options.runtime.packId,
    packVersion: options.runtime.packVersion,
    manifestSha256: options.runtime.manifestSha256,
    ruleVersion: options.runtime.ruleManifest.version,
    ruleSourceHash: options.runtime.ruleManifest.sourceHash,
    producer: options.producer,
    candidateType: type,
    candidateHash: evaluation.candidateHash,
    mode: options.mode,
    attempt: options.attempt,
    ...policy,
    policyVersion: "quality-policy/v1",
    targets: qualityEventTargets(evaluation, decision, targetEvaluations),
    decision,
    findingIds: [...new Set(evaluation.findings.map((finding) => finding.ruleId))].slice(0, 32),
    detectorMs: Math.round(evaluation.detectorMs * 1000) / 1000,
    ...(options.usage ? { usage: boundedUsage(options.usage) } : {}),
  };
}

function qualityPolicy(
  mode: HarnessQualityMode,
  evaluation: QualityEvaluation,
  decision: QualityDecision,
  inconclusive = false,
): { outcome: QualityOutcome; action: QualityAction } {
  if (decision === "rewrite") return { outcome: "rewrite-required", action: "rewrite" };
  if (decision === "exhausted") return { outcome: "exhausted", action: "ask-user" };
  if (inconclusive) return { outcome: "inconclusive", action: "deliver" };
  if (mode === "observe") {
    return evaluation.findings.length > 0
      ? { outcome: "findings", action: "observe" }
      : { outcome: "clean", action: "deliver" };
  }
  return evaluation.findings.length > 0
    ? { outcome: "findings", action: "deliver" }
    : { outcome: "clean", action: "deliver" };
}

function qualityAssessment(targetId: string, evaluation: QualityEvaluation): QualityAssessment {
  return {
    targetId,
    candidateHash: evaluation.candidateHash,
    detectorFindings: evaluation.findings,
    judgeFindings: [],
    judgeStatus: "not-run",
  };
}

function qualityEventTargets(
  evaluation: QualityEvaluation,
  decision: QualityDecision,
  targets?: NonNullable<BoundQualityEvaluation["targetEvaluations"]>,
): QualityEventTarget[] {
  if (!targets) {
    return [qualityEventTarget({
      id: `assistant:${evaluation.candidateHash}`,
      kind: "assistant-response",
      candidateHash: evaluation.candidateHash,
      evaluation,
      decision,
    })];
  }
  return targets.map(({ target, evaluation: targetEvaluation, warningReason }) => qualityEventTarget({
    id: target.id,
    kind: "artifact-post-image",
    path: target.path,
    candidateHash: target.postImageHash,
    bytes: target.bytes,
    evaluation: targetEvaluation,
    decision,
    warningReason,
  }));
}

function qualityEventTarget(options: {
  id: string;
  kind: QualityEventTarget["kind"];
  path?: string;
  candidateHash: string;
  bytes?: number;
  evaluation: QualityEvaluation;
  decision: QualityDecision;
  warningReason?: "target-unreadable" | "target-oversize";
}): QualityEventTarget {
  const blocking = options.evaluation.blockingFindings.length > 0;
  const status: QualityEventTarget["status"] = options.warningReason ? "warning" : blocking
    ? options.decision === "exhausted" ? "warning" : "rewrite-required"
    : options.evaluation.findings.length > 0 ? "findings" : "clean";
  return {
    id: options.id,
    kind: options.kind,
    ...(options.path ? { path: options.path } : {}),
    candidateHash: options.candidateHash,
    ...(options.bytes !== undefined ? { bytes: options.bytes } : {}),
    status,
    findingIds: [...new Set(options.evaluation.findings.map((finding) => finding.ruleId))].slice(0, 32),
    findings: options.evaluation.findings.slice(0, 16).map((finding) => ({
      ruleId: finding.ruleId,
      title: finding.title,
      severity: finding.severity,
      maturity: finding.maturity,
      evidence: finding.evidence.slice(0, 240),
      source: "detector",
    })),
    ...(options.warningReason ? { warningReason: options.warningReason } : {}),
  };
}

function extractProseCandidate(type: QualityCandidateType, content: string): string {
  if (type !== "runtime.prose" && type !== "dyad.character-response") return content;
  const sections = extractPartThreeSections(content);
  if (sections.length === 0) return looksLikeStructuredPacket(content) ? "" : content;
  return type === "runtime.prose" ? sections.at(-1)! : sections.join("\n\n");
}

function looksLikeStructuredPacket(content: string): boolean {
  return /^#{1,6}\s*Part\s*[12]\b/im.test(content)
    || /\[!Neural Chain\]/i.test(content)
    || /^\s*\[(?:Beat|Tension|Char|Scene|Turn)(?:\]|:)/im.test(content);
}

function extractPartThreeSections(content: string): string[] {
  const markers = [...content.matchAll(/^#{1,6}\s*Part\s*3\b[^\n]*\n/gim)];
  return markers.map((marker) => {
    const start = (marker.index ?? 0) + marker[0].length;
    const tail = content.slice(start);
    const nextHeading = tail.search(/^#{1,6}\s+/m);
    return (nextHeading >= 0 ? tail.slice(0, nextHeading) : tail).trim();
  }).filter(Boolean);
}

function mutationContent(call: ToolCall): string | undefined {
  if (!new Set(["write_file", "create_file", "append_file", "replace_in_file"]).has(call.name)) return undefined;
  try {
    const args = JSON.parse(call.arguments) as Record<string, unknown>;
    const content = ["content", "replacement", "newContent", "newText"]
      .map((key) => args[key])
      .find((value): value is string => typeof value === "string" && value.trim().length > 0);
    return content;
  } catch {
    return undefined;
  }
}

function isSceneMutation(call: ToolCall): boolean {
  try {
    const args = JSON.parse(call.arguments) as Record<string, unknown>;
    const path = typeof args.path === "string" ? args.path : undefined;
    return path !== undefined && /(?:^|\/)Scene_[0-9]+\.md$/i.test(path);
  } catch {
    return false;
  }
}
