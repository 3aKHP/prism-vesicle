import type { ModelLimits } from "../config/env";
import type { BackgroundProcessState } from "../core/process/manager";
import { ENGINE_HANDOFF_KIND } from "../core/engine/transition";
import type { ResumedMessage } from "../core/session/store";
import type { ResponseUsage } from "../providers/shared/types";
import { truncateLine } from "./format";
import { engineDisplayName } from "./theme";
import type { EngineId } from "../core/engine/profile";
import { createSignal } from "solid-js";

export type TokenUsageSummary = {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  contextInputTokens: number;
};

export function createUsageController() {
  const [lastTurnUsage, setLastTurnUsage] = createSignal<TokenUsageSummary | undefined>();
  const [sessionUsage, setSessionUsage] = createSignal<TokenUsageSummary>(emptyUsageSummary());
  let activeTurnUsage = emptyUsageSummary();
  let activeTurnAgentUsage = emptyUsageSummary();
  let activeTurnUsagePublished = false;

  function beginTurn(): void {
    activeTurnUsage = emptyUsageSummary();
    activeTurnAgentUsage = emptyUsageSummary();
    activeTurnUsagePublished = false;
    setLastTurnUsage(undefined);
  }

  function recordResponse(usage: ResponseUsage): void {
    activeTurnUsage = addResponseUsageToTurn(activeTurnUsage, usage);
    activeTurnUsagePublished = false;
  }

  function recordIndependent(usage: ResponseUsage): void {
    activeTurnAgentUsage = addIndependentUsageToTurn(activeTurnAgentUsage, usage);
    activeTurnUsagePublished = false;
  }

  function publishTurn(): void {
    const combined = mergeLogicalTurnUsage(activeTurnUsage, activeTurnAgentUsage);
    const usage = hasUsageSummary(combined) ? combined : undefined;
    setLastTurnUsage(usage);
    if (usage && !activeTurnUsagePublished) {
      setSessionUsage((current) => addTurnUsageToSession(current, usage));
      activeTurnUsagePublished = true;
    }
  }

  return {
    beginTurn,
    lastTurnUsage,
    publishTurn,
    recordIndependent,
    recordResponse,
    sessionUsage,
    setLastTurnUsage,
    setSessionUsage,
  };
}

export function headerLine(engine: EngineId, width: number, agents?: string, processes?: string): string {
  const left = `Prism Vesicle · ${engineDisplayName(engine)}`;
  const content = [left, ...(agents ? [`Agents ${agents}`] : []), ...(processes ? [`Shell ${processes}`] : [])].join(" · ");
  return truncateLine(content, Math.max(20, width - 4));
}

export function backgroundProcessActivitySummary(processes: BackgroundProcessState[]): string | undefined {
  const running = processes.filter((process) => process.status === "running").length;
  return running > 0 ? `${running} running` : undefined;
}

/**
 * Bottom telemetry line: connection identity plus current-turn and session
 * token counters. A turn is one logical user/gate/question input through the
 * provider tool loop that follows. Repeated provider requests inside the same
 * turn reuse most of the same context, so upstream/cache counters use the
 * latest request's context occupancy while downstream output still sums newly
 * generated tokens. Pricing intentionally stays out of this layer; adapters
 * only normalize runtime usage facts.
 */
export function footerLine(
  provider: string,
  model: string,
  hasKey: boolean,
  width: number,
  turnUsage?: TokenUsageSummary,
  sessionUsage?: TokenUsageSummary,
  modelLimits?: ModelLimits,
): string {
  const turnTelemetry = turnUsageTelemetryLine(turnUsage);
  const sessionTelemetry = sessionUsageTelemetryLine(sessionUsage);
  const contextTelemetry = contextUsageTelemetryLine(turnUsage, modelLimits);
  const left = `${provider}/${model} · key ${hasKey ? "ok" : "missing"}${turnTelemetry ? ` · ${turnTelemetry}` : ""}${sessionTelemetry ? ` · ${sessionTelemetry}` : ""}`;
  return footerWithRightTelemetry(left, contextTelemetry, Math.max(20, width - 2));
}

export function turnUsageTelemetryLine(usage: TokenUsageSummary | undefined): string | undefined {
  if (!usage || !hasUsageSummary(usage)) return undefined;
  const parts: string[] = [];
  parts.push("turn", tokenArrowPair(usage));
  const cached = formatTokenCount(usage.cachedInputTokens);
  if (cached && usage.cachedInputTokens > 0) parts.push(`↻ ${cached}`);
  return parts.join(" ");
}

export function sessionUsageTelemetryLine(usage: TokenUsageSummary | undefined): string | undefined {
  if (!usage || !hasUsageSummary(usage)) return undefined;
  return `session ${tokenArrowPair(usage)} ↻ ${formatTokenCount(usage.cachedInputTokens) ?? "0"}`;
}

export function contextUsageTelemetryLine(usage: TokenUsageSummary | undefined, modelLimits: ModelLimits | undefined): string | undefined {
  const contextWindow = modelLimits?.contextWindow;
  if (!usage || !contextWindow || contextWindow <= 0 || usage.contextInputTokens <= 0) return undefined;
  return `ctx ${formatTokenCount(usage.contextInputTokens)}/${formatTokenCount(contextWindow)} ${formatContextPercent(usage.contextInputTokens, contextWindow)}`;
}

export function emptyUsageSummary(): TokenUsageSummary {
  return { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, contextInputTokens: 0 };
}

export function addResponseUsageToTurn(current: TokenUsageSummary, usage: ResponseUsage): TokenUsageSummary {
  const contextInputTokens = contextInputTokensForDisplay(usage);
  return {
    inputTokens: latestNonZero(current.inputTokens, contextInputTokens),
    outputTokens: current.outputTokens + finiteOrZero(usage.outputTokens),
    cachedInputTokens: latestNonZero(current.cachedInputTokens, cachedInputTokens(usage)),
    contextInputTokens: latestNonZero(current.contextInputTokens, contextInputTokens),
  };
}

export function addIndependentUsageToTurn(current: TokenUsageSummary, usage: ResponseUsage): TokenUsageSummary {
  const input = contextInputTokensForDisplay(usage);
  return {
    inputTokens: current.inputTokens + input,
    outputTokens: current.outputTokens + finiteOrZero(usage.outputTokens),
    cachedInputTokens: current.cachedInputTokens + cachedInputTokens(usage),
    contextInputTokens: latestNonZero(current.contextInputTokens, input),
  };
}

export function combineIndependentUsage(usages: Array<ResponseUsage | undefined>): ResponseUsage | undefined {
  const present = usages.filter((usage): usage is ResponseUsage => Boolean(usage));
  if (present.length === 0) return undefined;
  const sum = (read: (usage: ResponseUsage) => number | undefined) => present.reduce((total, usage) => total + finiteOrZero(read(usage)), 0);
  const inputTokens = sum((usage) => usage.inputTokens ?? usage.contextInputTokens);
  const outputTokens = sum((usage) => usage.outputTokens);
  return {
    inputTokens,
    outputTokens,
    totalTokens: inputTokens + outputTokens,
    cacheReadInputTokens: sum((usage) => usage.cacheReadInputTokens),
    cacheWriteInputTokens: sum((usage) => usage.cacheWriteInputTokens),
    cacheHitInputTokens: sum((usage) => usage.cacheHitInputTokens),
    cacheMissInputTokens: sum((usage) => usage.cacheMissInputTokens),
    reasoningTokens: sum((usage) => usage.reasoningTokens),
    effectiveTokens: sum((usage) => usage.effectiveTokens),
  };
}

export function mergeLogicalTurnUsage(parent: TokenUsageSummary, agents: TokenUsageSummary): TokenUsageSummary {
  return {
    inputTokens: parent.inputTokens + agents.inputTokens,
    outputTokens: parent.outputTokens + agents.outputTokens,
    cachedInputTokens: parent.cachedInputTokens + agents.cachedInputTokens,
    contextInputTokens: parent.contextInputTokens || agents.contextInputTokens,
  };
}

export function addTurnUsageToSession(current: TokenUsageSummary, turn: TokenUsageSummary): TokenUsageSummary {
  return {
    inputTokens: current.inputTokens + turn.inputTokens,
    outputTokens: current.outputTokens + turn.outputTokens,
    cachedInputTokens: current.cachedInputTokens + turn.cachedInputTokens,
    contextInputTokens: latestNonZero(current.contextInputTokens, turn.contextInputTokens),
  };
}

export function sumSessionUsage(messages: ResumedMessage[]): TokenUsageSummary {
  let session = emptyUsageSummary();
  let turn = emptyUsageSummary();
  let agents = emptyUsageSummary();
  for (const message of messages) {
    if (message.role === "user" && isAuthoredUserMessage(message)) {
      const combined = mergeLogicalTurnUsage(turn, agents);
      if (hasUsageSummary(combined)) session = addTurnUsageToSession(session, combined);
      turn = emptyUsageSummary();
      agents = emptyUsageSummary();
      continue;
    }
    if (!message.usage) continue;
    if (message.kind === "subagent-result" || message.kind === "subagent-results") {
      agents = addIndependentUsageToTurn(agents, message.usage);
    } else {
      turn = addResponseUsageToTurn(turn, message.usage);
    }
  }
  const combined = mergeLogicalTurnUsage(turn, agents);
  if (hasUsageSummary(combined)) session = addTurnUsageToSession(session, combined);
  return session;
}

export function latestTurnUsage(messages: ResumedMessage[]): TokenUsageSummary | undefined {
  let lastUserIndex = -1;
  for (let index = messages.length - 1; index >= 0; index--) {
    if (messages[index].role === "user" && isAuthoredUserMessage(messages[index])) {
      lastUserIndex = index;
      break;
    }
  }
  if (lastUserIndex < 0) return undefined;
  let summary = emptyUsageSummary();
  let agents = emptyUsageSummary();
  for (const message of messages.slice(lastUserIndex + 1)) {
    if (!message.usage) continue;
    if (message.kind === "subagent-result" || message.kind === "subagent-results") {
      agents = addIndependentUsageToTurn(agents, message.usage);
    } else {
      summary = addResponseUsageToTurn(summary, message.usage);
    }
  }
  const combined = mergeLogicalTurnUsage(summary, agents);
  return hasUsageSummary(combined) ? combined : undefined;
}

export function hasUsageSummary(usage: TokenUsageSummary): boolean {
  return usage.inputTokens > 0 || usage.outputTokens > 0 || usage.cachedInputTokens > 0 || usage.contextInputTokens > 0;
}

function footerWithRightTelemetry(left: string, right: string | undefined, width: number): string {
  if (!right) return truncateLine(left, width);
  const gap = 4;
  if (right.length + gap >= width) return truncateLine(right, width);
  const leftWidth = width - right.length - gap;
  const leftText = truncateLine(left, leftWidth);
  const padding = Math.max(gap, width - leftText.length - right.length);
  return `${leftText}${" ".repeat(padding)}${right}`;
}

function tokenArrowPair(usage: TokenUsageSummary): string {
  return `↑${formatTokenCount(usage.inputTokens) ?? "0"} ↓${formatTokenCount(usage.outputTokens) ?? "0"}`;
}

function formatTokenCount(value: number | undefined): string | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  if (Math.abs(value) >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (Math.abs(value) >= 1000) return `${(value / 1000).toFixed(1)}k`;
  return String(value);
}

function formatContextPercent(used: number, total: number): string {
  const percent = (used / total) * 100;
  return percent < 1 && percent > 0 ? "<1%" : `${Math.round(percent)}%`;
}

function isAuthoredUserMessage(message: ResumedMessage): boolean {
  return message.kind !== "gate-resolution"
    && message.kind !== "user-question-answer"
    && message.kind !== "compact-summary"
    && message.kind !== "subagent-results"
    && message.kind !== "background-process-results"
    && message.kind !== ENGINE_HANDOFF_KIND;
}

function cachedInputTokens(usage: ResponseUsage): number {
  return finiteOrZero(usage.cacheReadInputTokens ?? usage.cacheHitInputTokens);
}

function contextInputTokensForDisplay(usage: ResponseUsage): number {
  return finiteOrZero(usage.contextInputTokens ?? usage.inputTokens);
}

function latestNonZero(current: number, next: number): number {
  return next > 0 ? next : current;
}

function finiteOrZero(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}
