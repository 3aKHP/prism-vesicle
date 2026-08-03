// Mid-turn automatic compaction owner: provider observation state, soft/hard
// budget checks, compacted snapshot reload + message rebuild, and hard-failed
// durable notice + AutoCompactBlockedError translation.
//
// This module receives narrow parameters — never the full RunLoopArgs. The
// caller (turn-loop) owns the seven-step boundary order and decides when to
// invoke the soft and hard checks.

import type { AutoCompactLimits, GenerationDefaults, ModelLimits } from "../../config/env";
import type { EngineId } from "../engine/profile";
import { AutoCompactBlockedError, runAutomaticCompaction } from "../compact/auto-compact";
import { estimateRequestTokens } from "../compact/context-budget";
import { toVesicleMessage } from "../compact/summary-generator";
import { loadSessionSnapshot } from "../session/store";
import type { SessionStore } from "../session/store";
import type { VesicleMessage, VesicleRequest } from "../../providers/shared/types";
import type { ToolDefinition } from "../tools";
import type { AgentLoopEvent } from "./types";

// ---------------------------------------------------------------------------
// Provider observation state
// ---------------------------------------------------------------------------

export type CompactionObservation = {
  /** Most recent provider-observed context occupancy, for mid-turn budget checks. Cleared after a compact (stale). */
  lastContextInputTokens: number | undefined;
  lastRequestObservation: { contextInputTokens: number; estimatedRequestTokens: number } | undefined;
};

export function createCompactionObservation(): CompactionObservation {
  return { lastContextInputTokens: undefined, lastRequestObservation: undefined };
}

/**
 * Update the observation state from the most recent provider response. The host
 * estimate paired with the provider observation lets the next projection add
 * only growth that occurred after the observation.
 */
export function updateProviderObservation(
  observation: CompactionObservation,
  contextInputTokens: number | undefined,
  estimatedRequestTokens: number | undefined,
): void {
  if (typeof contextInputTokens === "number" && contextInputTokens > 0) {
    observation.lastContextInputTokens = contextInputTokens;
    if (estimatedRequestTokens !== undefined) {
      observation.lastRequestObservation = { contextInputTokens, estimatedRequestTokens };
    }
  }
}

// ---------------------------------------------------------------------------
// Mid-turn compaction check
// ---------------------------------------------------------------------------

export type MidTurnCompactionParams = {
  rootDir: string;
  session: SessionStore;
  engine: EngineId;
  providerId: string;
  model: string;
  generation?: VesicleRequest["generation"];
  signal?: AbortSignal;
  onEvent?: (event: AgentLoopEvent) => void;
  systemPrompt: string;
  tools: ToolDefinition[];
  messages: VesicleMessage[];
  autoCompactConfig: AutoCompactLimits | undefined;
  limits: ModelLimits | undefined;
  configGeneration: GenerationDefaults | undefined;
  turnMaxTokens: number | undefined;
};

export type MidTurnCompactionResult = {
  compacted: boolean;
  blocked: boolean;
  error?: AutoCompactBlockedError;
};

/**
 * One mid-turn automatic-compaction check. The soft check (onlyHardCeiling
 * false) runs after a complete tool batch; the hard check (onlyHardCeiling true)
 * runs after queued/background input has been drained, right before the next
 * provider request. On a compact the active in-memory message array is rebound
 * to the post-checkpoint history (replacement + retained frontier), and the
 * stale provider occupancy is cleared so the next check re-estimates. On a
 * hard-ceiling failure the loop is blocked: a system notice is appended and the
 * caller breaks before the unsafe request. The compact provider call is a
 * standalone request (never a bootstrap/loop turn) so it cannot re-enter this
 * check; the outer loop signal cancels it.
 */
export async function runMidTurnCompaction(
  params: MidTurnCompactionParams,
  observation: CompactionObservation,
  onlyHardCeiling: boolean,
): Promise<MidTurnCompactionResult> {
  const estimatedNextRequestTokens = estimateRequestTokens(params.messages, params.systemPrompt, params.tools);
  const result = await runAutomaticCompaction({
    rootDir: params.rootDir,
    sessionId: params.session.sessionId,
    engine: params.engine,
    providerSelection: { provider: params.providerId, model: params.model },
    generation: params.generation,
    signal: params.signal,
    onEvent: params.onEvent,
    phase: "mid-turn",
    onlyHardCeiling,
    estimateReplacementTokens: (replacement) => estimateRequestTokens(
      replacement.map(toVesicleMessage),
      params.systemPrompt,
      params.tools,
    ),
    budget: {
      config: params.autoCompactConfig,
      limits: params.limits,
      generation: params.configGeneration,
      turnMaxTokens: params.turnMaxTokens,
      lastContextInputTokens: observation.lastContextInputTokens,
      lastRequestObservation: observation.lastRequestObservation,
      estimatedNextRequestTokens,
    },
  });
  if (result.kind === "cancelled") throw result.error;
  if (result.kind === "compacted") {
    observation.lastContextInputTokens = undefined;
    observation.lastRequestObservation = undefined;
    const snapshot = await loadSessionSnapshot(params.rootDir, params.session.sessionId, { synthesizeDanglingToolResults: false });
    const rebuilt = snapshot.messages.map(toVesicleMessage);
    params.messages.length = 0;
    params.messages.push(...rebuilt);
    return { compacted: true, blocked: false };
  }
  if (result.kind === "hard-failed") {
    await params.session.append({
      role: "system",
      content: `Context budget exceeded and automatic compaction failed: ${result.errorMessage} Run /compact manually or switch to a model with a larger context window.`,
      metadata: { kind: "compact-blocked" },
    });
    return {
      compacted: false,
      blocked: true,
      error: new AutoCompactBlockedError(
        result.errorMessage,
        result.check.kind === "hard-ceiling"
          ? {
            projectedTokens: result.check.projectedTokens,
            hardInputCeilingTokens: result.check.hardInputCeilingTokens,
            softTriggerTokens: result.check.softTriggerTokens,
            usageSource: result.check.usageSource,
          }
          : undefined,
        true,
      ),
    };
  }
  return { compacted: false, blocked: false };
}
