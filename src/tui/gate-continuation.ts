import { resolveGate } from "../core/agent-loop/run";
import type { GateResolution } from "../core/gate/types";
import type { DecisionContinuationOptions } from "./turn-controller-options";

type GateContinuationOptions = Pick<DecisionContinuationOptions,
  | "activeGeneration" | "activeProviderSelection" | "agentManager" | "beginUsageTurn" | "busy"
  | "clearGateFeedback" | "handleAgentEvent" | "handleInterruptedTurn" | "handleResult"
  | "onProviderContextSnapshot" | "pendingGate" | "permissionBroker" | "permissionContext" | "queuedWork"
  | "recordActivity" | "reportError" | "runCancellable" | "setBusy" | "setGateFeedbackMode"
  | "setMessages" | "setPendingGate" | "setStatus"
>;

export function createGateContinuation(options: GateContinuationOptions) {
  async function submitGateResolution(resolution: GateResolution): Promise<void> {
    const gate = options.pendingGate();
    if (!gate || options.busy()) return;
    beginGateResolution(gate.gate.gate, resolution);
    try {
      const outcome = await options.runCancellable((signal) => resolveGate({
        engine: gate.engine,
        sessionId: gate.sessionId,
        messages: gate.messages,
        toolCallId: gate.toolCallId,
        gate: gate.gate,
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
        if (!await options.queuedWork.handleInterruption(gate.sessionId)) options.setPendingGate(gate);
        options.handleInterruptedTurn();
      } else options.handleResult(outcome.value);
    } catch (error) {
      options.setPendingGate(gate);
      options.reportError(error);
    } finally {
      options.setBusy(false);
    }
  }

  function beginGateResolution(gateName: string, resolution: GateResolution): void {
    options.setBusy(true);
    options.queuedWork.block();
    options.setStatus(`resolving gate: ${resolution.decision}`);
    options.recordActivity({ kind: "gate", text: `resolving ${gateName} as ${resolution.decision}` });
    options.setPendingGate(null);
    options.setGateFeedbackMode(null);
    options.clearGateFeedback();
    options.setMessages((previous) => [...previous, {
      role: "user",
      content: `[gate:${gateName}] ${resolution.decision}${resolution.feedback ? ` — ${resolution.feedback}` : ""}`,
    }]);
    options.beginUsageTurn();
  }

  return { submitGateResolution };
}
