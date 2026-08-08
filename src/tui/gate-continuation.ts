import { resolveGate } from "../core/agent-loop/run";
import type { RunPromptResult } from "../core/agent-loop/run";
import type { GateResolution } from "../core/gate/types";
import type { QueuedWorkController } from "./queued-work-controller";
import type { PermissionContext, TurnDecisionPort, TurnAgentPort, TurnRuntimePort, TurnTranscriptPort, TurnUsagePort, TurnRunCancellable } from "./turn-controller-options";

type GateContinuationOptions = {
  runtime: Pick<TurnRuntimePort, "activeProviderSelection" | "activeGeneration" | "busy" | "setBusy" | "permissionBroker">;
  decision: Pick<TurnDecisionPort, "pendingGate" | "setPendingGate" | "setGateFeedbackMode" | "clearGateFeedback">;
  transcript: Pick<TurnTranscriptPort, "setMessages" | "setStatus" | "recordActivity">;
  agent: Pick<TurnAgentPort, "agentManager" | "handleAgentEvent" | "onProviderContextSnapshot">;
  usage: Pick<TurnUsagePort, "beginUsageTurn">;
  queuedWork: QueuedWorkController;
  runCancellable: TurnRunCancellable;
  handleResult: (result: RunPromptResult) => void;
  handleInterruptedTurn: () => void;
  reportError: (error: unknown) => void;
  permissionContext: () => PermissionContext;
};

export function createGateContinuation(options: GateContinuationOptions) {
  const { activeProviderSelection, activeGeneration, busy, setBusy, permissionBroker } = options.runtime;
  const { pendingGate, setPendingGate, setGateFeedbackMode, clearGateFeedback } = options.decision;
  const { setMessages, setStatus, recordActivity } = options.transcript;
  const { agentManager, handleAgentEvent, onProviderContextSnapshot } = options.agent;
  const { beginUsageTurn } = options.usage;
  const { queuedWork, runCancellable, handleResult, handleInterruptedTurn, reportError, permissionContext } = options;

  async function submitGateResolution(resolution: GateResolution): Promise<void> {
    const gate = pendingGate();
    if (!gate || busy()) return;
    beginGateResolution(gate.gate.gate, resolution);
    try {
      const outcome = await runCancellable((signal) => resolveGate({
        engine: gate.engine,
        sessionId: gate.sessionId,
        messages: gate.messages,
        toolCallId: gate.toolCallId,
        gate: gate.gate,
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
        if (!await queuedWork.handleInterruption(gate.sessionId)) setPendingGate(gate);
        handleInterruptedTurn();
      } else handleResult(outcome.value);
    } catch (error) {
      setPendingGate(gate);
      reportError(error);
    } finally {
      setBusy(false);
    }
  }

  function beginGateResolution(gateName: string, resolution: GateResolution): void {
    setBusy(true);
    queuedWork.block();
    setStatus(`resolving gate: ${resolution.decision}`);
    recordActivity({ kind: "gate", text: `resolving ${gateName} as ${resolution.decision}` });
    setPendingGate(null);
    setGateFeedbackMode(null);
    clearGateFeedback();
    setMessages((previous) => [...previous, {
      role: "user",
      content: `[gate:${gateName}] ${resolution.decision}${resolution.feedback ? ` — ${resolution.feedback}` : ""}`,
    }]);
    beginUsageTurn();
  }

  return { submitGateResolution };
}
