import { resolvePermission } from "../core/agent-loop/run";
import type { PermissionRequest, PermissionResolution } from "../core/permissions";
import { loadSessionSnapshot } from "../core/session/store";
import type { PendingPermissionState } from "./decision-interaction";
import { displayTranscriptFromSnapshot, vesicleMessagesFromResumed } from "./session-presenter";
import type { DecisionContinuationOptions } from "./turn-controller-options";

type PermissionContinuationOptions = Pick<DecisionContinuationOptions,
  | "activeGeneration" | "activeProviderSelection" | "agentCards" | "agentManager" | "beginUsageTurn" | "busy"
  | "clearGateFeedback" | "handleAgentEvent" | "handleInterruptedTurn" | "handleResult" | "onProviderContextSnapshot"
  | "pendingChildPermission" | "pendingPermission" | "permissionBroker" | "permissionContext" | "queuedWork"
  | "recordActivity" | "reportError" | "rootDir" | "runCancellable" | "setBusy" | "setConversation"
  | "setGateFeedbackMode" | "setMessages" | "setPendingPermission" | "setStatus"
>;

export function createPermissionContinuation(options: PermissionContinuationOptions) {
  async function submitPermissionResolution(resolution: PermissionResolution): Promise<void> {
    const pending = options.pendingPermission();
    if (!pending || options.busy()) return;
    options.setBusy(true);
    options.queuedWork.block();
    options.setStatus(`resolving permission: ${resolution.decision}`);
    options.recordActivity({ kind: "tool", text: `${resolution.decision} ${pending.request.toolName}` });
    options.setPendingPermission(null);
    options.setGateFeedbackMode(null);
    options.clearGateFeedback();
    options.beginUsageTurn();
    try {
      const outcome = await options.runCancellable((signal) => resolvePermission({
        engine: pending.engine,
        sessionId: pending.sessionId,
        messages: pending.messages,
        request: pending.request,
        remainingToolCalls: pending.remainingToolCalls,
        deferredAgentPermissions: pending.deferredAgentPermissions,
        resolution,
        providerSelection: options.activeProviderSelection(),
        generation: options.activeGeneration(),
        permission: options.permissionContext(),
        signal,
        onEvent: options.handleAgentEvent,
        onProviderContextSnapshot: options.onProviderContextSnapshot,
        agentManager: options.agentManager(),
        permissionBroker: options.permissionBroker,
        takePendingUserInputs: options.queuedWork.takePendingUserInputs,
        runToolBoundaryCommands: options.queuedWork.runToolBoundaryCommands,
      }));
      if (outcome.kind === "interrupted") {
        if (!await options.queuedWork.handleInterruption(pending.sessionId)) await reconcilePermissionAfterContinuationFailure(pending);
        options.handleInterruptedTurn();
      } else options.handleResult(outcome.value);
    } catch (error) {
      await reconcilePermissionAfterContinuationFailure(pending);
      options.reportError(error);
    } finally {
      options.setBusy(false);
    }
  }

  async function reconcilePermissionAfterContinuationFailure(pending: PendingPermissionState): Promise<void> {
    try {
      const snapshot = await loadSessionSnapshot(options.rootDir, pending.sessionId, { synthesizeDanglingToolResults: false });
      if (snapshot.pendingPermission?.id === pending.request.id) {
        options.setPendingPermission(pending);
        return;
      }
      options.setPendingPermission(null);
      options.setConversation(vesicleMessagesFromResumed(snapshot.messages));
      options.setMessages(displayTranscriptFromSnapshot(snapshot.messages, options.agentCards()));
      options.setStatus("permission resolved; provider continuation stopped");
    } catch {
      options.setPendingPermission(pending);
    }
  }

  function submitChildPermissionResolution(resolution: PermissionResolution): void {
    const request = options.pendingChildPermission() as PermissionRequest | null;
    if (!request || !options.permissionBroker.resolve(request.id, resolution)) return;
    options.setGateFeedbackMode(null);
    options.clearGateFeedback();
    options.setStatus(`${resolution.decision} ${request.agent?.handle ?? "SubAgent"} ${request.toolName}`);
    options.recordActivity({ kind: "agent", text: `${resolution.decision} ${request.agent?.handle ?? "SubAgent"} ${request.toolName}` });
  }

  return { submitChildPermissionResolution, submitPermissionResolution };
}
