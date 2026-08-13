import { resolvePermission } from "../core/agent-loop/run";
import type { RunPromptResult } from "../core/agent-loop/run";
import type { PermissionRequest, PermissionResolution } from "../core/permissions";
import { loadSessionSnapshot } from "../core/session/store";
import type { PendingPermissionState } from "./decision-interaction";
import { displayTranscriptFromSnapshot, vesicleMessagesFromResumed } from "./session-presenter";
import type { QueuedWorkController } from "./queued-work-controller";
import type { PermissionContext, TurnAgentPort, TurnDecisionPort, TurnRuntimePort, TurnSessionPort, TurnTranscriptPort, TurnUsagePort, TurnRunCancellable } from "./turn-controller-options";

type PermissionContinuationOptions = {
  runtime: Pick<TurnRuntimePort, "activeProviderSelection" | "activeGeneration" | "busy" | "setBusy" | "permissionBroker">;
  decision: Pick<TurnDecisionPort, "pendingPermission" | "setPendingPermission" | "pendingChildPermission" | "setGateFeedbackMode" | "clearGateFeedback">;
  transcript: Pick<TurnTranscriptPort, "setMessages" | "setStatus" | "recordActivity">;
  agent: Pick<TurnAgentPort, "agentCards" | "agentManager" | "handleAgentEvent" | "onProviderContextSnapshot">;
  usage: Pick<TurnUsagePort, "beginUsageTurn">;
  session: Pick<TurnSessionPort, "rootDir" | "setConversation">;
  queuedWork: QueuedWorkController;
  runCancellable: TurnRunCancellable;
  handleResult: (result: RunPromptResult) => void;
  handleInterruptedTurn: () => void;
  reportError: (error: unknown) => void;
  permissionContext: () => PermissionContext;
  refreshCandidateSwitcher: (sessionId: string) => Promise<void>;
};

export function createPermissionContinuation(options: PermissionContinuationOptions) {
  const { activeProviderSelection, activeGeneration, busy, setBusy, permissionBroker } = options.runtime;
  const { pendingPermission, setPendingPermission, pendingChildPermission, setGateFeedbackMode, clearGateFeedback } = options.decision;
  const { setMessages, setStatus, recordActivity } = options.transcript;
  const { agentCards, agentManager, handleAgentEvent, onProviderContextSnapshot } = options.agent;
  const { beginUsageTurn } = options.usage;
  const { rootDir, setConversation } = options.session;
  const { queuedWork, runCancellable, handleResult, handleInterruptedTurn, reportError, permissionContext, refreshCandidateSwitcher } = options;

  async function submitPermissionResolution(resolution: PermissionResolution): Promise<void> {
    const pending = pendingPermission();
    if (!pending || busy()) return;
    setBusy(true);
    queuedWork.block();
    setStatus(`resolving permission: ${resolution.decision}`);
    recordActivity({ kind: "tool", text: `${resolution.decision} ${pending.request.toolName}` });
    setPendingPermission(null);
    setGateFeedbackMode(null);
    clearGateFeedback();
    beginUsageTurn();
    try {
      const outcome = await runCancellable((signal) => resolvePermission({
        engine: pending.engine,
        sessionId: pending.sessionId,
        messages: pending.messages,
        request: pending.request,
        remainingToolCalls: pending.remainingToolCalls,
        deferredAgentPermissions: pending.deferredAgentPermissions,
        resolution,
        providerSelection: activeProviderSelection(),
        generation: activeGeneration(),
        permission: permissionContext(),
        signal,
        onEvent: handleAgentEvent,
        onProviderContextSnapshot: onProviderContextSnapshot,
        agentManager: agentManager(),
        permissionBroker,
        takePendingUserInputs: queuedWork.takePendingUserInputs,
        runToolBoundaryCommands: queuedWork.runToolBoundaryCommands,
      }));
      if (outcome.kind === "interrupted") {
        if (!await queuedWork.handleInterruption(pending.sessionId)) await reconcilePermissionAfterContinuationFailure(pending);
        handleInterruptedTurn();
      } else {
        handleResult(outcome.value);
        await refreshCandidateSwitcher(pending.sessionId);
      }
    } catch (error) {
      await reconcilePermissionAfterContinuationFailure(pending);
      reportError(error);
    } finally {
      setBusy(false);
    }
  }

  async function reconcilePermissionAfterContinuationFailure(pending: PendingPermissionState): Promise<void> {
    try {
      const snapshot = await loadSessionSnapshot(rootDir, pending.sessionId, { synthesizeDanglingToolResults: false });
      if (snapshot.pendingPermission?.id === pending.request.id) {
        setPendingPermission(pending);
        return;
      }
      setPendingPermission(null);
      setConversation(vesicleMessagesFromResumed(snapshot.messages));
      setMessages(displayTranscriptFromSnapshot(snapshot.messages, agentCards()));
      setStatus("permission resolved; provider continuation stopped");
    } catch {
      setPendingPermission(pending);
    }
  }

  function submitChildPermissionResolution(resolution: PermissionResolution): void {
    const request = pendingChildPermission() as PermissionRequest | null;
    if (!request || !permissionBroker.resolve(request.id, resolution)) return;
    setGateFeedbackMode(null);
    clearGateFeedback();
    setStatus(`${resolution.decision} ${request.agent?.handle ?? "SubAgent"} ${request.toolName}`);
    recordActivity({ kind: "agent", text: `${resolution.decision} ${request.agent?.handle ?? "SubAgent"} ${request.toolName}` });
  }

  return { submitChildPermissionResolution, submitPermissionResolution };
}
