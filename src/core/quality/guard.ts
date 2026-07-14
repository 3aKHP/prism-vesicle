import type { VesicleResponse } from "../../providers/shared/types";
import type { ResponseUsage } from "../../providers/shared/types";
import type { EngineId } from "../engine/profile";
import type { HarnessQualityMode } from "../harness/types";
import type { SessionStore } from "../session/store";
import type { ToolCall } from "../tools";
import { evaluateQualityCandidate } from "./detector";
import type {
  QualityCandidate,
  QualityCandidateType,
  QualityDecision,
  QualityEvaluation,
  QualityEvent,
  QualityRewriteState,
  QualityRuntimeContext,
} from "./types";

export const maxQualityRewriteAttempts = 2;

export type BoundQualityEvaluation = {
  mode: HarnessQualityMode;
  candidate: QualityCandidate;
  evaluation: QualityEvaluation;
  decision: QualityDecision;
  event: QualityEvent;
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

export function qualityCandidateTypeForProducer(producer: string): QualityCandidateType | undefined {
  switch (producer) {
    case "runtime": return "runtime.prose";
    case "dyad": return "dyad.character-response";
    case "weaver":
    case "scene-writer": return "scene.prose";
    case "weaver-orch": return "orchestrator-authored-prose";
    default: return undefined;
  }
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
  return {
    mode: options.mode,
    candidate,
    evaluation,
    decision,
    event: {
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
      decision,
      findingIds: [...new Set(evaluation.findings.map((finding) => finding.ruleId))].slice(0, 32),
      detectorMs: Math.round(evaluation.detectorMs * 1000) / 1000,
      ...(options.usage ? { usage: boundedUsage(options.usage) } : {}),
    },
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
    findings: result.evaluation.blockingFindings.slice(0, 16).map((finding) => ({
      ruleId: finding.ruleId,
      evidence: finding.evidence,
      start: finding.start,
      end: finding.end,
      instruction: "Rewrite the affected prose while preserving facts, point of view, character logic, beats, required format, and target paths.",
    })),
  });
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
