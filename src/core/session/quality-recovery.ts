import { engineIds, type EngineId } from "../engine/profile";
import { type ProviderThinkingBlock, type ResponseUsage } from "../../providers/shared/types";
import {
  qualityCandidateParts,
  qualityMutationParts,
  upsertDurableQualityTarget,
  type DurableQualityArtifactTarget,
  type QualityCandidateType,
  type QualityDecisionCandidate,
  type QualityDecisionPoint,
  type QualityEvent,
  type QualityEventTarget,
  type QualityResolution,
  type QualityWarning,
} from "../quality";
import type { PendingQualityRewrite } from "./store";
import type { ResumedToolCall, SessionRecord } from "./record-model";
import type { FileToolEvent } from "../tools";

export function findPendingQualityRewrite(records: SessionRecord[]): PendingQualityRewrite | undefined {
  let pending: PendingQualityRewrite | undefined;
  let proseParts: string[] = [];
  let mutationParts: string[] = [];
  const mutationPartsByCallId = new Map<string, string[]>();
  for (const record of records) {
    if (record.role === "assistant") {
      const toolCalls = record.metadata?.toolCalls as ResumedToolCall[] | undefined;
      if ((toolCalls?.length ?? 0) === 0) {
        proseParts.push(...qualityCandidateParts({ id: record.uuid, content: record.content }));
      }
      for (const call of toolCalls ?? []) {
        const parts = qualityMutationParts({ id: record.uuid, content: "", toolCalls: [call] });
        if (parts.length === 0) continue;
        mutationPartsByCallId.set(call.id, parts);
        mutationParts.push(...parts);
      }
    }
    if (record.role === "tool" && record.metadata?.ok === true && pending) {
      const callId = typeof record.metadata.toolCallId === "string" ? record.metadata.toolCallId : undefined;
      const fileEvent = record.metadata.fileEvent as FileToolEvent | undefined;
      if (callId && fileEvent) {
        upsertDurableQualityTarget(pending.targets, pending.producer, { callId, ok: true, fileEvent });
      }
    }
    if (record.role === "tool" && record.metadata?.ok === false && record.metadata?.kind !== "quality-rewrite-feedback") {
      const callId = typeof record.metadata.toolCallId === "string" ? record.metadata.toolCallId : undefined;
      const parts = callId ? mutationPartsByCallId.get(callId) : undefined;
      if (parts) {
        removeCandidateParts(mutationParts, parts);
        if (pending) removeCandidateParts(pending.candidateParts, parts);
      }
      if (pending?.attempts === 0 && pending.candidateParts.length === 0 && pending.targets.length === 0) pending = undefined;
      continue;
    }
    if (record.metadata?.kind === "quality-event") {
      const [event] = findQualityEvents([record]);
      if (!event) continue;
      const rawEvent = record.metadata.qualityEvent;
      const legacyExhausted = event.decision === "exhausted"
        && rawEvent && typeof rawEvent === "object" && !Array.isArray(rawEvent)
        && !("outcome" in rawEvent);
      if (event.decision === "pass" || legacyExhausted) {
        pending = undefined;
        proseParts = [];
        mutationParts = [];
        mutationPartsByCallId.clear();
      }
      continue;
    }
    if (record.metadata?.kind === "quality-check-pending") {
      const parsed = parsePendingQualityRewrite(record.metadata.qualityRewrite, 0);
      if (parsed) pending = {
        ...parsed,
        candidateParts: readPersistedCandidateParts(record.metadata.qualityRewrite)
          ?? [...qualityDeliveryParts(proseParts, mutationParts)],
        targets: readPersistedQualityTargets(record.metadata.qualityRewrite),
      };
      continue;
    }
    if (record.metadata?.kind === "quality-check-cleared") {
      pending = undefined;
      proseParts = [];
      mutationParts = [];
      mutationPartsByCallId.clear();
      continue;
    }
    if (record.metadata?.kind === "quality-warning") {
      pending = undefined;
      proseParts = [];
      mutationParts = [];
      mutationPartsByCallId.clear();
      continue;
    }
    if (record.metadata?.kind !== "quality-rewrite-feedback") continue;
    const parsed = parsePendingQualityRewrite(record.metadata.qualityRewrite, 1);
    proseParts = [];
    mutationParts = [];
    mutationPartsByCallId.clear();
    if (parsed) pending = {
      ...parsed,
      candidateParts: readPersistedCandidateParts(record.metadata.qualityRewrite) ?? [],
      targets: readPersistedQualityTargets(record.metadata.qualityRewrite),
      ...readPersistedQualityContinuation(record.metadata.qualityRewrite),
    };
  }
  return pending && (pending.attempts > 0 || pending.candidateParts.length > 0 || pending.targets.length > 0)
    ? pending
    : undefined;
}

function readPersistedCandidateParts(value: unknown): string[] | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const parts = (value as { candidateParts?: unknown }).candidateParts;
  if (!Array.isArray(parts) || parts.some((part) => typeof part !== "string")) return undefined;
  return [...parts];
}

function readPersistedQualityTargets(value: unknown): DurableQualityArtifactTarget[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  const targets = (value as { targets?: unknown }).targets;
  if (!Array.isArray(targets)) return [];
  return targets.flatMap((target) => {
    if (!target || typeof target !== "object" || Array.isArray(target)) return [];
    const item = target as Record<string, unknown>;
    const path = typeof item.path === "string" ? item.path : undefined;
    const operation = item.operation;
    const candidateType = item.candidateType;
    if (!path
      || item.id !== `artifact:${path}`
      || item.kind !== "artifact-post-image"
      || !isQualityCandidateType(candidateType)
      || !["create", "write", "replace", "append"].includes(String(operation))
      || !Array.isArray(item.mutationCallIds)
      || item.mutationCallIds.some((id) => typeof id !== "string")
      || typeof item.postImageHash !== "string"
      || !/^[a-f0-9]{64}$/.test(item.postImageHash)
      || typeof item.bytes !== "number"
      || item.bytes < 0
      || !Array.isArray(item.rejectedHashes)
      || item.rejectedHashes.some((hash) => typeof hash !== "string" || !/^[a-f0-9]{64}$/.test(hash))) return [];
    return [{
      id: `artifact:${path}` as const,
      kind: "artifact-post-image" as const,
      candidateType,
      path,
      operation: operation as DurableQualityArtifactTarget["operation"],
      mutationCallIds: [...item.mutationCallIds] as string[],
      postImageHash: item.postImageHash,
      bytes: item.bytes,
      rejectedHashes: [...item.rejectedHashes] as string[],
    }];
  });
}

function isQualityCandidateType(value: unknown): value is QualityCandidateType {
  return [
    "runtime.prose",
    "stage.prose",
    "dyad.character-response",
    "scene.prose",
    "orchestrator-authored-prose",
    "audit.target-prose",
  ].includes(String(value));
}

function qualityDeliveryParts(proseParts: string[], mutationParts: string[]): string[] {
  return mutationParts.length > 0 ? mutationParts : proseParts;
}

function removeCandidateParts(candidateParts: string[], rejectedParts: string[]): void {
  for (const part of rejectedParts) {
    const index = candidateParts.lastIndexOf(part);
    if (index >= 0) candidateParts.splice(index, 1);
  }
}

function parsePendingQualityRewrite(
  value: unknown,
  minimumAttempts: number,
): Omit<PendingQualityRewrite, "candidateParts" | "targets"> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const raw = value as Partial<PendingQualityRewrite>;
  const producer = readEngineId(raw.producer);
  if (!producer
    || typeof raw.packId !== "string"
    || typeof raw.packVersion !== "string"
    || typeof raw.manifestSha256 !== "string"
    || !/^[a-f0-9]{64}$/.test(raw.manifestSha256)
    || typeof raw.ruleVersion !== "string"
    || typeof raw.ruleSourceHash !== "string"
    || !/^[a-f0-9]{64}$/.test(raw.ruleSourceHash)
    || !Number.isInteger(raw.attempts)
    || Number(raw.attempts) < minimumAttempts
    || !Array.isArray(raw.rejectedHashes)
    || raw.rejectedHashes.some((hash) => typeof hash !== "string" || !/^[a-f0-9]{64}$/.test(hash))) return undefined;
  return {
    producer,
    packId: raw.packId,
    packVersion: raw.packVersion,
    manifestSha256: raw.manifestSha256,
    ruleVersion: raw.ruleVersion,
    ruleSourceHash: raw.ruleSourceHash,
    attempts: Number(raw.attempts),
    rejectedHashes: [...raw.rejectedHashes],
    ...readPersistedQualityContinuation(value),
  };
}

function readPersistedQualityContinuation(value: unknown): Partial<Pick<PendingQualityRewrite, "warningId" | "warningTargetIds" | "candidate" | "experimentalJudge">> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const source = value as Record<string, unknown>;
  const warningId = typeof source.warningId === "string" ? source.warningId : undefined;
  const warningTargetIds = Array.isArray(source.warningTargetIds)
    && source.warningTargetIds.every((id) => typeof id === "string")
    ? [...source.warningTargetIds] as string[]
    : undefined;
  const candidate = parseQualityDecisionCandidate(source.candidate);
  const experimentalJudge = parseExperimentalJudgeSnapshot(source.experimentalJudge);
  return {
    ...(warningId ? { warningId } : {}),
    ...(warningTargetIds ? { warningTargetIds } : {}),
    ...(candidate ? { candidate } : {}),
    ...(experimentalJudge ? { experimentalJudge } : {}),
  };
}

export function findQualityEvents(records: SessionRecord[]): QualityEvent[] {
  const events: QualityEvent[] = [];
  for (const record of records) {
    if (record.metadata?.kind !== "quality-event") continue;
    const event = parseQualityEvent(record.metadata.qualityEvent);
    if (event) events.push(event);
  }
  return events;
}

function parseQualityEvent(value: unknown): QualityEvent | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const event = value as Partial<QualityEvent>;
  const decision = isQualityDecision(event.decision) ? event.decision : undefined;
  const judgeUsage = event.judgeUsage === undefined ? undefined : readResponseUsage(event.judgeUsage);
  const experimentalJudge = event.experimentalJudge === undefined ? undefined : parseExperimentalJudgeSnapshot(event.experimentalJudge);
  if (!decision
    || event.guard !== "anti-ai-flavor"
    || typeof event.packId !== "string"
    || typeof event.packVersion !== "string"
    || typeof event.manifestSha256 !== "string"
    || typeof event.ruleVersion !== "string"
    || typeof event.ruleSourceHash !== "string"
    || typeof event.producer !== "string"
    || !isQualityCandidateType(event.candidateType)
    || typeof event.candidateHash !== "string"
    || !/^[a-f0-9]{64}$/.test(event.candidateHash)
    || typeof event.mode !== "string"
    || !Number.isInteger(event.attempt)
    || !Array.isArray(event.findingIds)
    || event.findingIds.some((id) => typeof id !== "string")
    || typeof event.detectorMs !== "number"
    || (event.judgeStatus !== undefined && !isQualityJudgeStatus(event.judgeStatus))
    || (event.judgeMs !== undefined && (typeof event.judgeMs !== "number" || !Number.isFinite(event.judgeMs) || event.judgeMs < 0))
    || (event.judgeProvider !== undefined && (typeof event.judgeProvider !== "string" || event.judgeProvider.length === 0))
    || (event.judgeModel !== undefined && (typeof event.judgeModel !== "string" || event.judgeModel.length === 0))
    || (event.judgeRequestCount !== undefined && (!Number.isInteger(event.judgeRequestCount) || Number(event.judgeRequestCount) < 0))
    || (event.judgeUsage !== undefined && !judgeUsage)
    || (event.experimentalJudge !== undefined && !experimentalJudge)) return undefined;
  const outcome = isQualityOutcome(event.outcome)
    ? event.outcome
    : legacyQualityOutcome(decision, event.findingIds.length);
  const action = isQualityAction(event.action) ? event.action : legacyQualityAction(decision);
  const targets = Array.isArray(event.targets)
    ? event.targets.flatMap((target) => {
        const parsed = parseQualityEventTarget(target);
        return parsed ? [parsed] : [];
      })
    : [];
  return {
    ...(event as QualityEvent),
    candidateType: event.candidateType,
    decision,
    outcome,
    action,
    policyVersion: "quality-policy/v1",
    ...(judgeUsage ? { judgeUsage } : {}),
    ...(experimentalJudge ? { experimentalJudge } : {}),
    targets: targets.length > 0 ? targets : [{
      id: `assistant:${event.candidateHash}`,
      kind: "assistant-response",
      candidateHash: event.candidateHash,
      status: outcome === "exhausted" ? "warning"
        : outcome === "rewrite-required" ? "rewrite-required"
          : event.findingIds.length > 0 ? "findings" : "clean",
      findingIds: [...event.findingIds],
      findings: [],
    }],
  };
}

function parseExperimentalJudgeSnapshot(value: unknown): QualityEvent["experimentalJudge"] | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const profile = value as Record<string, unknown>;
  if ((profile.mode !== "observe" && profile.mode !== "rewrite")
    || typeof profile.providerId !== "string" || profile.providerId.length === 0
    || typeof profile.modelId !== "string" || profile.modelId.length === 0
    || !["openai-chat-compatible", "anthropic-messages", "gemini-generate-content"].includes(String(profile.protocol))
    || !Number.isInteger(profile.judgeTimeoutMs) || Number(profile.judgeTimeoutMs) < 1_000 || Number(profile.judgeTimeoutMs) > 180_000
    || typeof profile.configIdentity !== "string" || !/^[a-f0-9]{64}$/.test(profile.configIdentity)) return undefined;
  return {
    mode: profile.mode,
    providerId: profile.providerId,
    modelId: profile.modelId,
    protocol: profile.protocol as NonNullable<QualityEvent["experimentalJudge"]>["protocol"],
    judgeTimeoutMs: Number(profile.judgeTimeoutMs),
    configIdentity: profile.configIdentity,
  };
}

function parseQualityEventTarget(value: unknown): QualityEventTarget | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const source = value as Record<string, unknown>;
  if (typeof source.id !== "string"
    || (source.kind !== "assistant-response" && source.kind !== "artifact-post-image")
    || typeof source.candidateHash !== "string"
    || !/^[a-f0-9]{64}$/.test(source.candidateHash)
    || !["clean", "findings", "rewrite-required", "warning"].includes(String(source.status))
    || !Array.isArray(source.findingIds)
    || source.findingIds.some((id) => typeof id !== "string")
    || !Array.isArray(source.findings)) return undefined;
  const findings = source.findings.flatMap((finding) => {
    if (!finding || typeof finding !== "object" || Array.isArray(finding)) return [];
    const item = finding as Record<string, unknown>;
    if (typeof item.ruleId !== "string"
      || typeof item.title !== "string"
      || typeof item.severity !== "string"
      || (item.maturity !== "experimental" && item.maturity !== "stable")
      || typeof item.evidence !== "string"
      || (item.source !== "detector" && item.source !== "judge")) return [];
    return [{
      ruleId: item.ruleId,
      title: item.title,
      severity: item.severity,
      maturity: item.maturity as "experimental" | "stable",
      evidence: item.evidence,
      source: item.source as "detector" | "judge",
      ...(typeof item.confidence === "number" && Number.isFinite(item.confidence)
        && item.confidence >= 0 && item.confidence <= 1 ? { confidence: item.confidence } : {}),
    }];
  });
  return {
    id: source.id,
    kind: source.kind,
    ...(typeof source.path === "string" ? { path: source.path } : {}),
    candidateHash: source.candidateHash,
    ...(typeof source.bytes === "number" && source.bytes >= 0 ? { bytes: source.bytes } : {}),
    status: source.status as QualityEventTarget["status"],
    findingIds: [...source.findingIds] as string[],
    findings,
    ...(["target-unreadable", "target-oversize", "detector-budget-exhausted", "judge-invalid", "judge-timeout", "judge-unavailable"].includes(String(source.warningReason))
      ? { warningReason: source.warningReason as QualityEventTarget["warningReason"] }
      : {}),
  };
}

function isQualityDecision(value: unknown): value is QualityEvent["decision"] {
  return value === "pass" || value === "observe" || value === "rewrite" || value === "exhausted";
}

function isQualityOutcome(value: unknown): value is QualityEvent["outcome"] {
  return value === "clean" || value === "findings" || value === "rewrite-required" || value === "exhausted" || value === "inconclusive";
}

function isQualityAction(value: unknown): value is QualityEvent["action"] {
  return value === "deliver" || value === "observe" || value === "rewrite" || value === "ask-user";
}

function isQualityJudgeStatus(value: unknown): value is NonNullable<QualityEvent["judgeStatus"]> {
  return value === "not-run" || value === "valid" || value === "invalid" || value === "timed-out" || value === "unavailable";
}

function legacyQualityOutcome(decision: QualityEvent["decision"], findingCount: number): QualityEvent["outcome"] {
  if (decision === "rewrite") return "rewrite-required";
  if (decision === "exhausted") return "exhausted";
  return findingCount > 0 ? "findings" : "clean";
}

function legacyQualityAction(decision: QualityEvent["decision"]): QualityEvent["action"] {
  if (decision === "rewrite") return "rewrite";
  if (decision === "exhausted") return "ask-user";
  return decision === "observe" ? "observe" : "deliver";
}

export function findPendingQualityDecision(records: SessionRecord[]): QualityDecisionPoint | undefined {
  const points = new Map<string, QualityDecisionPoint>();
  const resolutions = qualityResolutions(records);
  const cleared = new Set(records.flatMap((record) =>
    record.metadata?.kind === "quality-check-cleared" && typeof record.metadata.warningId === "string"
      ? [record.metadata.warningId]
      : []
  ));
  for (const record of records) {
    if (record.metadata?.kind !== "quality-warning") continue;
    const point = parseQualityDecisionPoint(record.metadata.qualityDecision);
    if (point) points.set(point.request.id, point);
  }
  return [...points.values()].reverse().find((point) => {
    if (cleared.has(point.warning.id)) return false;
    const resolved = resolutions.filter((resolution) => resolution.warningId === point.warning.id);
    if (resolved.some((resolution) => resolution.resolution !== "revised-clean")) return false;
    const cleanTargets = new Set(resolved.flatMap((resolution) => resolution.targetIds));
    return point.warning.targets.some((target) => !cleanTargets.has(target.id));
  });
}

export function findQualityWarnings(records: SessionRecord[]): QualityWarning[] {
  const warnings = new Map<string, QualityWarning>();
  const latestWarningByTarget = new Map<string, string>();
  for (const record of records) {
    if (record.metadata?.kind === "quality-warning") {
      const warning = parseQualityWarning(record.metadata.qualityWarning);
      if (!warning) continue;
      warnings.set(warning.id, warning);
      for (const target of warning.targets) latestWarningByTarget.set(target.id, warning.id);
      continue;
    }
    if (record.metadata?.kind !== "quality-resolution") continue;
    const resolution = parseQualityResolution(record.metadata.qualityResolution);
    if (!resolution) continue;
    const warning = warnings.get(resolution.warningId);
    if (!warning) continue;
    if (resolution.resolution === "revised-clean") {
      const resolved = new Set(resolution.targetIds);
      warning.targets = warning.targets.filter((target) => !resolved.has(target.id));
      continue;
    }
    const terminalResolution = resolution.resolution as "accepted-by-user" | "stopped-by-user";
    const resolved = new Set(resolution.targetIds);
    warning.targets = warning.targets.map((target) => resolved.has(target.id)
      ? { ...target, resolution: terminalResolution }
      : target);
  }
  for (const warning of warnings.values()) {
    warning.targets = warning.targets.filter((target) => latestWarningByTarget.get(target.id) === warning.id);
  }
  return [...warnings.values()].filter((warning) => warning.targets.length > 0);
}

function qualityResolutions(records: SessionRecord[]): QualityResolution[] {
  return records.flatMap((record) => {
    if (record.metadata?.kind !== "quality-resolution") return [];
    const resolution = parseQualityResolution(record.metadata.qualityResolution);
    return resolution ? [resolution] : [];
  });
}

function parseQualityResolution(value: unknown): QualityResolution | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const source = value as Record<string, unknown>;
  if (typeof source.warningId !== "string"
    || !["revised-clean", "accepted-by-user", "stopped-by-user"].includes(String(source.resolution))
    || !Array.isArray(source.targetIds)
    || source.targetIds.some((id) => typeof id !== "string")) return undefined;
  return {
    warningId: source.warningId,
    resolution: source.resolution as QualityResolution["resolution"],
    targetIds: [...source.targetIds] as string[],
  };
}

function parseQualityWarning(value: unknown): QualityWarning | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const source = value as Record<string, unknown>;
  const producer = readEngineId(source.producer);
  if (typeof source.id !== "string"
    || source.guard !== "anti-ai-flavor"
    || !producer
    || !["exhausted", "judge-invalid", "judge-timeout", "judge-unavailable", "detector-budget-exhausted", "target-unreadable", "target-oversize", "user-abandoned"].includes(String(source.reason))
    || !Number.isInteger(source.attempt)
    || !Array.isArray(source.targets)) return undefined;
  const targets = source.targets.flatMap((target) => {
    const parsed = parseQualityEventTarget(target);
    return parsed ? [parsed] : [];
  });
  if (targets.length === 0) return undefined;
  return {
    id: source.id,
    guard: "anti-ai-flavor",
    reason: source.reason as QualityWarning["reason"],
    producer,
    attempt: Number(source.attempt),
    targets,
  };
}

function parseQualityDecisionPoint(value: unknown): QualityDecisionPoint | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const source = value as Record<string, unknown>;
  const request = source.request as Record<string, unknown> | undefined;
  const warning = parseQualityWarning(source.warning);
  const candidate = parseQualityDecisionCandidate(source.candidate);
  const stateBase = parsePendingQualityRewrite(source.qualityState, 0);
  if (!request || !warning || !candidate || !stateBase
    || typeof request.id !== "string"
    || request.id !== warning.id
    || (request.reason !== "exhausted" && request.reason !== "interrupted")
    || readEngineId(request.producer) !== warning.producer
    || !Number.isInteger(request.findingCount)
    || !Array.isArray(request.targets)
    || typeof request.canRetry !== "boolean"
    || (source.phase !== "before-mutations" && source.phase !== "after-mutations")
    || typeof source.candidateRecorded !== "boolean") return undefined;
  const targets = request.targets.flatMap((target) => {
    if (!target || typeof target !== "object" || Array.isArray(target)) return [];
    const item = target as Record<string, unknown>;
    if (typeof item.id !== "string"
      || !Array.isArray(item.findingIds)
      || item.findingIds.some((id) => typeof id !== "string")) return [];
    return [{
      id: item.id,
      ...(typeof item.path === "string" ? { path: item.path } : {}),
      findingIds: [...item.findingIds] as string[],
    }];
  });
  return {
    request: {
      id: request.id,
      reason: request.reason,
      producer: warning.producer,
      findingCount: Number(request.findingCount),
      targets,
      canRetry: request.canRetry,
      ...(typeof request.blockedReason === "string" ? { blockedReason: request.blockedReason } : {}),
    },
    warning,
    qualityState: {
      ...stateBase,
      candidateParts: readPersistedCandidateParts(source.qualityState) ?? [],
      targets: readPersistedQualityTargets(source.qualityState),
      ...readPersistedQualityContinuation(source.qualityState),
    },
    candidate,
    phase: source.phase,
    candidateRecorded: source.candidateRecorded,
  };
}

function parseQualityDecisionCandidate(value: unknown): QualityDecisionCandidate | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const source = value as Record<string, unknown>;
  if (typeof source.responseId !== "string"
    || typeof source.content !== "string"
    || !Array.isArray(source.toolCalls)) return undefined;
  const toolCalls = source.toolCalls.flatMap((call) => {
    if (!call || typeof call !== "object" || Array.isArray(call)) return [];
    const item = call as Record<string, unknown>;
    return typeof item.id === "string" && typeof item.name === "string" && typeof item.arguments === "string"
      ? [{ id: item.id, name: item.name, arguments: item.arguments }]
      : [];
  });
  if (toolCalls.length !== source.toolCalls.length) return undefined;
  const thinkingBlocks = readThinkingBlocks(source.thinkingBlocks);
  const usage = readResponseUsage(source.usage);
  return {
    responseId: source.responseId,
    content: source.content,
    toolCalls,
    ...(typeof source.reasoningContent === "string" ? { reasoningContent: source.reasoningContent } : {}),
    ...(thinkingBlocks ? { thinkingBlocks } : {}),
    ...(typeof source.finishReason === "string" ? { finishReason: source.finishReason } : {}),
    ...(usage ? { usage } : {}),
  };
}

function readEngineId(value: unknown): EngineId | undefined {
  return typeof value === "string" && (engineIds as readonly string[]).includes(value) ? value as EngineId : undefined;
}

function readThinkingBlocks(value: unknown): ProviderThinkingBlock[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const blocks = value.filter((block): block is ProviderThinkingBlock => {
    if (!block || typeof block !== "object") return false;
    const value = block as ProviderThinkingBlock;
    if (value.type === "reasoning") return typeof value.reasoningContent === "string";
    if (value.type === "thinking") return typeof value.thinking === "string";
    if (value.type === "redacted_thinking") return typeof value.data === "string";
    return value.type === "thought_summary" && (typeof value.text === "string" || typeof value.summary === "string");
  });
  return blocks.length > 0 ? blocks : undefined;
}

function readResponseUsage(value: unknown): ResponseUsage | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const source = value as Record<string, unknown>;
  const usage: ResponseUsage = {};
  for (const key of ["contextInputTokens", "inputTokens", "outputTokens", "totalTokens", "cacheReadInputTokens", "cacheWriteInputTokens", "cacheHitInputTokens", "cacheMissInputTokens", "reasoningTokens", "effectiveTokens"] as const) {
    if (typeof source[key] === "number" && Number.isFinite(source[key])) (usage as Record<string, unknown>)[key] = source[key];
  }
  if (source.providerDetails && typeof source.providerDetails === "object" && !Array.isArray(source.providerDetails)) usage.providerDetails = { ...(source.providerDetails as Record<string, unknown>) };
  return Object.keys(usage).length > 0 ? usage : undefined;
}
