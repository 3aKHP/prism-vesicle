import { resolveQualityDecision } from "../core/agent-loop/run";
import type { RunPromptResult } from "../core/agent-loop/run";
import { loadSessionSnapshot } from "../core/session/store";
import type { PendingQualityDecisionState } from "./decision-interaction";
import { pendingQualityDecisionFromSnapshot } from "./quality-decision-state";
import type { QueuedWorkController } from "./queued-work-controller";
import type { PermissionContext, TurnAgentPort, TurnDecisionPort, TurnHostActionPort, TurnRuntimePort, TurnSessionPort, TurnTranscriptPort, TurnUsagePort, TurnRunCancellable } from "./turn-controller-options";

type QualityDecisionContinuationOptions = {
  runtime: Pick<TurnRuntimePort, "activeProviderSelection" | "activeGeneration" | "busy" | "setBusy" | "permissionBroker">;
  decision: Pick<TurnDecisionPort, "pendingQualityDecision" | "setPendingQualityDecision" | "setQualitySelected">;
  transcript: Pick<TurnTranscriptPort, "setMessages" | "setStatus" | "recordActivity">;
  agent: Pick<TurnAgentPort, "agentManager" | "handleAgentEvent" | "onProviderContextSnapshot">;
  usage: Pick<TurnUsagePort, "beginUsageTurn">;
  session: Pick<TurnSessionPort, "rootDir">;
  hostAction: Pick<TurnHostActionPort, "refreshQualityWarnings" | "resumeQualitySession">;
  queuedWork: QueuedWorkController;
  runCancellable: TurnRunCancellable;
  handleResult: (result: RunPromptResult) => void;
  handleInterruptedTurn: () => void;
  reportError: (error: unknown) => void;
  permissionContext: () => PermissionContext;
  resolveQualityDecision?: typeof resolveQualityDecision;
};

export function createQualityDecisionContinuation(options: QualityDecisionContinuationOptions) {
  const { activeProviderSelection, activeGeneration, busy, setBusy, permissionBroker } = options.runtime;
  const { pendingQualityDecision, setPendingQualityDecision, setQualitySelected } = options.decision;
  const { setMessages, setStatus, recordActivity } = options.transcript;
  const { agentManager, handleAgentEvent, onProviderContextSnapshot } = options.agent;
  const { beginUsageTurn } = options.usage;
  const { rootDir } = options.session;
  const { refreshQualityWarnings, resumeQualitySession } = options.hostAction;
  const { queuedWork, runCancellable, handleResult, handleInterruptedTurn, reportError, permissionContext, resolveQualityDecision: resolveQualityDecisionOverride } = options;

  async function submitQualityDecision(resolution: "retry" | "accept" | "stop"): Promise<void> {
    const pending = pendingQualityDecision();
    if (!pending || busy()) return;
    if (resolution === "retry" && !pending.decision.canRetry) {
      setStatus(pending.decision.blockedReason ?? "quality retry is unavailable under the active Harness identity");
      return;
    }
    setBusy(true);
    queuedWork.block();
    setPendingQualityDecision(null);
    setStatus(resolution === "retry" ? "starting user-authorized quality revision" : `recording quality decision: ${resolution}`);
    recordActivity({ kind: "validation", text: `quality decision: ${resolution}` });
    setMessages((previous) => [...previous, {
      role: "user",
      content: resolution === "retry" ? "[quality] revise again"
        : resolution === "accept" ? "[quality] use current version with warning"
          : "[quality] stop",
    }]);
    if (resolution === "retry") beginUsageTurn();
    try {
      const execute = (signal?: AbortSignal) => (resolveQualityDecisionOverride ?? resolveQualityDecision)({
        engine: pending.engine,
        sessionId: pending.sessionId,
        rootDir,
        resolution,
        providerSelection: activeProviderSelection(),
        generation: activeGeneration(),
        permission: permissionContext(),
        ...(signal ? { signal } : {}),
        onEvent: handleAgentEvent,
        onProviderContextSnapshot: onProviderContextSnapshot,
        agentManager: agentManager(),
        permissionBroker,
        takePendingUserInputs: queuedWork.takePendingUserInputs,
        runToolBoundaryCommands: queuedWork.runToolBoundaryCommands,
      });
      if (resolution === "retry") {
        const outcome = await runCancellable((signal) => execute(signal));
        if (outcome.kind === "interrupted") {
          if (!await queuedWork.handleInterruption(pending.sessionId)) await reconcileQualityDecision(pending);
          handleInterruptedTurn();
        } else if (outcome.value.kind === "quality_resolved") {
          await applyQualityResolution(outcome.value.sessionId);
        } else {
          handleResult(outcome.value);
        }
      } else {
        const result = await execute();
        if (result.kind !== "quality_resolved") handleResult(result);
        else await applyQualityResolution(result.sessionId);
      }
    } catch (error) {
      await reconcileQualityDecision(pending);
      reportError(error);
    } finally {
      setBusy(false);
    }
  }

  async function applyQualityResolution(sessionId: string): Promise<void> {
    await refreshQualityWarnings(sessionId);
    await resumeQualitySession(sessionId);
    queuedWork.release();
  }

  async function reconcileQualityDecision(pending: PendingQualityDecisionState): Promise<void> {
    try {
      const snapshot = await loadSessionSnapshot(rootDir, pending.sessionId, { synthesizeDanglingToolResults: false });
      const restored = pendingQualityDecisionFromSnapshot(snapshot);
      setPendingQualityDecision(restored ?? null);
      setQualitySelected(restored?.decision.canRetry === false ? 1 : 0);
      if (restored) setStatus("quality decision remains pending");
    } catch {
      setPendingQualityDecision(pending);
    }
  }

  return { submitQualityDecision };
}
