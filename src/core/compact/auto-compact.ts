import type { ProviderSelection } from "../../config/providers";
import type { VesicleRequest } from "../../providers/shared/types";
import type { ProviderRetryInfo } from "../../providers/shared/types";
import type { EngineId } from "../engine/profile";
import type { AgentLoopEvent } from "../agent-loop/types";
import type { ResumedMessage } from "../session/store";
import { evaluateBudgetCheck, projectOccupancy, type BudgetCheckResult, type BudgetInputs } from "./context-budget";
import { runPortableCompaction, type PortableCompactionReason } from "./service";

/**
 * Automatic pre-turn compaction (issue #107 §6/§7). Evaluates the context
 * budget against the live provider/model config, and — only when auto-compaction
 * is fully configured and the projected next request crosses the soft trigger —
 * runs the portable-compaction pipeline with `trigger: "auto"`. The compact
 * provider request itself never re-enters automatic evaluation (it is a
 * standalone request, not a bootstrap turn), so there is no recursion.
 *
 * Soft-trigger failure keeps the old head and lets the request continue (the
 * request was still within the hard ceiling). Hard-ceiling failure blocks the
 * provider request without mutating the session, so the caller can retain the
 * draft and the user can retry, manually compact, or switch model.
 */

export type PreTurnCompactionResult =
  | { kind: "skipped"; check: BudgetCheckResult }
  | { kind: "compacted"; checkpointUuid: string; check: BudgetCheckResult }
  | { kind: "cancelled"; check: BudgetCheckResult; error: unknown }
  | { kind: "soft-failed"; check: BudgetCheckResult; errorMessage: string }
  | { kind: "hard-failed"; check: BudgetCheckResult; errorMessage: string };

/**
 * Thrown by bootstrap when a mandatory hard-ceiling compaction fails or does not
 * reduce enough. It is raised BEFORE the new user record is persisted, so the
 * session is not mutated and the caller can retain the draft and let the user
 * retry, manually compact, or switch model. Carries the structured check data so
 * the UI can surface an actionable reason (projected vs. ceiling) instead of a
 * generic string.
 */
export type AutoCompactBlockedContext = {
  projectedTokens: number;
  hardInputCeilingTokens: number;
  softTriggerTokens: number;
  usageSource: "provider" | "estimated";
};

export class AutoCompactBlockedError extends Error {
  readonly context: AutoCompactBlockedContext | undefined;
  readonly inputPersisted: boolean;
  constructor(errorMessage: string, context?: AutoCompactBlockedContext, inputPersisted = false) {
    super(formatBlockedMessage(errorMessage, context));
    this.name = "AutoCompactBlockedError";
    this.context = context;
    this.inputPersisted = inputPersisted;
  }
}

function formatBlockedMessage(errorMessage: string, context?: AutoCompactBlockedContext): string {
  if (!context) return errorMessage;
  return `${errorMessage} (projected ${context.projectedTokens} tokens, usage ${context.usageSource}; soft trigger ${context.softTriggerTokens}, hard ceiling ${context.hardInputCeilingTokens}). Retry, run /compact manually, or switch to a model with a larger context window.`;
}

export type RunAutomaticCompactionOptions = {
  rootDir: string;
  sessionId: string;
  engine: EngineId;
  providerSelection?: Partial<ProviderSelection>;
  generation?: VesicleRequest["generation"];
  signal?: AbortSignal;
  onRetry?: (info: ProviderRetryInfo) => void;
  onEvent?: (event: AgentLoopEvent) => void;
  budget: BudgetInputs;
  phase: "pre-turn" | "mid-turn";
  /**
   * When true (the mid-turn pre-request hard check), compact only on a
   * hard-ceiling projection — the post-tool soft check already handled
   * soft-trigger compaction for this boundary, so a soft-trigger here would
   * double-compact the same request.
   */
  onlyHardCeiling?: boolean;
  /** Estimate the exact normal request if this replacement were installed. */
  estimateReplacementTokens: (messages: ResumedMessage[]) => number;
};

/**
 * Run one automatic-compaction evaluation + (if needed) the portable pipeline.
 * Used by both the pre-turn bootstrap check (phase "pre-turn") and the mid-turn
 * loop checks (phase "mid-turn"). The caller decides what to do with the result:
 * the pre-turn caller throws AutoCompactBlockedError on hard-failed; the
 * mid-turn caller rebuilds the in-memory message array on compacted and breaks
 * the loop on hard-failed.
 */
export async function runAutomaticCompaction(options: RunAutomaticCompactionOptions): Promise<PreTurnCompactionResult> {
  const check = evaluateBudgetCheck(options.budget);
  emitCheck(options.onEvent, options.phase, check);

  if (check.kind === "below" || check.kind === "inactive" || check.kind === "degraded") {
    return { kind: "skipped", check };
  }
  if (options.onlyHardCeiling && check.kind === "soft-trigger") {
    return { kind: "skipped", check };
  }

  const reason: PortableCompactionReason = check.kind === "hard-ceiling" ? "hard-ceiling" : "soft-threshold";
  const started = Date.now();
  options.onEvent?.({ type: "compact_started", phase: options.phase, trigger: "auto", reason });

  const outcome = await runPortableCompaction({
    rootDir: options.rootDir,
    sessionId: options.sessionId,
    engine: options.engine,
    providerSelection: options.providerSelection,
    generation: options.generation,
    trigger: "auto",
    phase: options.phase,
    reason,
    signal: options.signal,
    onRetry: options.onRetry,
    automaticBudget: {
      beforeTokens: check.projectedTokens,
      beforeEstimateTokens: options.budget.estimatedNextRequestTokens,
      beforeSource: check.usageSource,
      softTriggerTokens: check.softTriggerTokens,
      hardInputCeilingTokens: check.hardInputCeilingTokens,
      estimateReplacementTokens: options.estimateReplacementTokens,
      projectReplacementTokens: (estimatedTokens) => projectOccupancy({
        ...options.budget,
        estimatedNextRequestTokens: estimatedTokens,
      })?.value ?? estimatedTokens,
    },
  });
  const durationMs = Date.now() - started;

  if (outcome.kind === "completed") {
    options.onEvent?.({
      type: "compact_completed",
      phase: options.phase,
      trigger: "auto",
      reason,
      checkpointUuid: outcome.checkpointUuid,
      evictedUnits: outcome.messagesSummarized,
      retainedUnits: outcome.retainedUnits,
      durationMs,
      beforeTokens: check.projectedTokens,
      ...(outcome.projectedAfterTokens !== undefined ? { projectedAfterTokens: outcome.projectedAfterTokens } : {}),
      ...(check.kind === "soft-trigger" || check.kind === "hard-ceiling" ? { usageSource: check.usageSource } : {}),
    });
    return { kind: "compacted", checkpointUuid: outcome.checkpointUuid, check };
  }

  if (outcome.kind === "cancelled") {
    options.onEvent?.({ type: "compact_cancelled", phase: options.phase, trigger: "auto", reason, durationMs });
    return { kind: "cancelled", check, error: outcome.error };
  }

  const errorMessage = outcome.kind === "failed"
    ? (outcome.error instanceof Error ? outcome.error.message : String(outcome.error))
    : "Nothing left to compact before the next request.";
  options.onEvent?.({ type: "compact_failed", phase: options.phase, trigger: "auto", reason, durationMs, errorMessage });
  // A soft-trigger failure happened while the request was still within the hard
  // ceiling, so the caller may continue on the old head. A hard-ceiling failure
  // must block the provider request without mutating the session.
  return check.kind === "hard-ceiling"
    ? { kind: "hard-failed", check, errorMessage }
    : { kind: "soft-failed", check, errorMessage };
}

function emitCheck(onEvent: ((event: AgentLoopEvent) => void) | undefined, phase: "pre-turn" | "mid-turn", check: BudgetCheckResult): void {
  if (!onEvent) return;
  if (check.kind === "inactive") {
    onEvent({ type: "compact_check", phase, result: "inactive", inactiveReason: check.reason });
    return;
  }
  if (check.kind === "degraded") {
    onEvent({ type: "compact_check", phase, result: "degraded" });
    return;
  }
  onEvent({
    type: "compact_check",
    phase,
    result: check.kind,
    projectedTokens: check.projectedTokens,
    usageSource: check.usageSource,
    softTriggerTokens: check.kind === "below" ? undefined : check.softTriggerTokens,
    hardInputCeilingTokens: check.kind === "below" ? undefined : check.hardInputCeilingTokens,
  });
}
