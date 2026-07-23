import { resolveQualityDecision } from "../core/agent-loop/run";
import { loadSessionSnapshot } from "../core/session/store";
import type { PendingQualityDecisionState } from "./decision-interaction";
import { pendingQualityDecisionFromSnapshot } from "./quality-decision-state";
import type { DecisionContinuationOptions } from "./turn-controller-options";

type QualityDecisionContinuationOptions = Pick<DecisionContinuationOptions,
  | "activeGeneration" | "activeProviderSelection" | "agentManager" | "beginUsageTurn" | "busy"
  | "handleAgentEvent" | "handleInterruptedTurn" | "handleResult" | "onProviderContextSnapshot"
  | "pendingQualityDecision" | "permissionBroker" | "permissionContext" | "queuedWork" | "recordActivity"
  | "refreshQualityWarnings" | "reportError" | "resolveQualityDecision" | "resumeQualitySession" | "rootDir"
  | "runCancellable" | "setBusy" | "setMessages" | "setPendingQualityDecision" | "setQualitySelected" | "setStatus"
>;

export function createQualityDecisionContinuation(options: QualityDecisionContinuationOptions) {
  async function submitQualityDecision(resolution: "retry" | "accept" | "stop"): Promise<void> {
    const pending = options.pendingQualityDecision();
    if (!pending || options.busy()) return;
    if (resolution === "retry" && !pending.decision.canRetry) {
      options.setStatus(pending.decision.blockedReason ?? "quality retry is unavailable under the active Harness identity");
      return;
    }
    options.setBusy(true);
    options.queuedWork.block();
    options.setPendingQualityDecision(null);
    options.setStatus(resolution === "retry" ? "starting user-authorized quality revision" : `recording quality decision: ${resolution}`);
    options.recordActivity({ kind: "validation", text: `quality decision: ${resolution}` });
    options.setMessages((previous) => [...previous, {
      role: "user",
      content: resolution === "retry" ? "[quality] revise again"
        : resolution === "accept" ? "[quality] use current version with warning"
          : "[quality] stop",
    }]);
    if (resolution === "retry") options.beginUsageTurn();
    try {
      const execute = (signal?: AbortSignal) => (options.resolveQualityDecision ?? resolveQualityDecision)({
        engine: pending.engine,
        sessionId: pending.sessionId,
        rootDir: options.rootDir,
        resolution,
        providerSelection: options.activeProviderSelection(),
        generation: options.activeGeneration(),
        permission: options.permissionContext(),
        ...(signal ? { signal } : {}),
        onEvent: options.handleAgentEvent,
        onProviderContextSnapshot: options.onProviderContextSnapshot,
        agentManager: options.agentManager(),
        permissionBroker: options.permissionBroker,
        takePendingUserInputs: options.queuedWork.takePendingUserInputs,
        runToolBoundaryCommands: options.queuedWork.runToolBoundaryCommands,
      });
      if (resolution === "retry") {
        const outcome = await options.runCancellable((signal) => execute(signal));
        if (outcome.kind === "interrupted") {
          if (!await options.queuedWork.handleInterruption(pending.sessionId)) await reconcileQualityDecision(pending);
          options.handleInterruptedTurn();
        } else if (outcome.value.kind === "quality_resolved") {
          await applyQualityResolution(outcome.value.sessionId);
        } else {
          options.handleResult(outcome.value);
        }
      } else {
        const result = await execute();
        if (result.kind !== "quality_resolved") options.handleResult(result);
        else await applyQualityResolution(result.sessionId);
      }
    } catch (error) {
      await reconcileQualityDecision(pending);
      options.reportError(error);
    } finally {
      options.setBusy(false);
    }
  }

  async function applyQualityResolution(sessionId: string): Promise<void> {
    await options.refreshQualityWarnings(sessionId);
    await options.resumeQualitySession(sessionId);
    options.queuedWork.release();
  }

  async function reconcileQualityDecision(pending: PendingQualityDecisionState): Promise<void> {
    try {
      const snapshot = await loadSessionSnapshot(options.rootDir, pending.sessionId, { synthesizeDanglingToolResults: false });
      const restored = pendingQualityDecisionFromSnapshot(snapshot);
      options.setPendingQualityDecision(restored ?? null);
      options.setQualitySelected(restored?.decision.canRetry === false ? 1 : 0);
      if (restored) options.setStatus("quality decision remains pending");
    } catch {
      options.setPendingQualityDecision(pending);
    }
  }

  return { submitQualityDecision };
}
