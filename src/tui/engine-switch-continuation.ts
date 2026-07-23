import { resolveEngineSwitch, type EngineSwitchConfirmedResult } from "../core/agent-loop/run";
import type { GateResolution } from "../core/gate/types";
import type { PendingEngineSwitchState } from "./decision-interaction";
import type { DecisionContinuationOptions } from "./turn-controller-options";

type EngineSwitchContinuationOptions = Pick<DecisionContinuationOptions,
  | "activeEngine" | "activeGeneration" | "activeProviderSelection" | "agentManager" | "beginUsageTurn"
  | "busy" | "clearGateFeedback" | "compactSession" | "handleAgentEvent" | "handleInterruptedTurn"
  | "handleResult" | "onProviderContextSnapshot" | "pendingEngineSwitch" | "permissionBroker"
  | "permissionContext" | "queuedWork" | "recordActivity" | "reportError" | "runCancellable"
  | "setActiveEngine" | "setBusy" | "setConversation" | "setGateFeedbackMode" | "setMessages"
  | "setPendingEngineSwitch" | "setSessionId" | "setSessionPath" | "setStatus"
>;

export function createEngineSwitchContinuation(options: EngineSwitchContinuationOptions) {
  async function submitEngineSwitchResolution(
    resolution: GateResolution,
    submitOptions: { summarizeContext?: boolean } = {},
  ): Promise<void> {
    const pending = options.pendingEngineSwitch();
    if (!pending || options.busy()) return;
    const summarizeContext = resolution.decision === "confirm" && submitOptions.summarizeContext === true;
    let switchApplied = false;
    beginEngineSwitchResolution(pending, resolution, summarizeContext);
    try {
      const outcome = await options.runCancellable((signal) => resolveEngineSwitch({
        engine: pending.profile?.id ?? options.activeEngine(),
        sessionId: pending.sessionId,
        messages: pending.messages,
        toolCallId: pending.toolCallId,
        request: pending.request,
        resolution,
        ...(summarizeContext ? { contextPolicy: "summary" as const } : {}),
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
        if (!await options.queuedWork.handleInterruption(pending.sessionId)) options.setPendingEngineSwitch(pending);
        options.handleInterruptedTurn();
        return;
      }
      if (outcome.value.kind === "engine_switched") {
        switchApplied = true;
        await applyEngineSwitchResult(outcome.value, summarizeContext);
      } else options.handleResult(outcome.value);
    } catch (error) {
      if (!switchApplied) options.setPendingEngineSwitch(pending);
      options.reportError(error);
    } finally {
      options.setBusy(false);
    }
  }

  function beginEngineSwitchResolution(pending: PendingEngineSwitchState, resolution: GateResolution, summarize: boolean): void {
    options.setBusy(true);
    options.queuedWork.block();
    options.setStatus(summarize ? "resolving engine switch with summary" : `resolving engine switch: ${resolution.decision}`);
    options.recordActivity({ kind: "gate", text: `resolving engine switch to ${pending.request.targetEngine} as ${summarize ? "confirm-summary" : resolution.decision}` });
    options.setPendingEngineSwitch(null);
    options.setGateFeedbackMode(null);
    options.clearGateFeedback();
    options.setMessages((previous) => [...previous, {
      role: "user",
      content: `[engine-switch:${pending.request.targetEngine}] ${resolution.decision}${resolution.feedback ? ` — ${resolution.feedback}` : ""}`,
    }]);
    if (resolution.decision !== "confirm") options.beginUsageTurn();
  }

  async function applyEngineSwitchResult(result: EngineSwitchConfirmedResult, summarizeContext: boolean): Promise<void> {
    options.setConversation([...result.messages]);
    options.setSessionId(result.sessionId);
    options.setSessionPath(result.sessionPath);
    options.setActiveEngine(result.engine);
    options.setStatus(`engine ${result.engine}`);
    options.recordActivity({ kind: "system", text: `engine switched to ${result.engine}` });
    if (summarizeContext) {
      const compact = await options.compactSession("Preserve the engine handoff, user intent, important files/artifacts, unresolved issues, and the next useful step.");
      options.setMessages((previous) => [...previous, { role: "system", content: `Engine switched to ${result.engine} with summarized context (${compact.messagesSummarized} messages). Future turns will use that profile.` }]);
    } else {
      options.setMessages((previous) => [...previous, { role: "system", content: `Engine switched to ${result.engine}. Future turns will use that profile.` }]);
    }
    options.queuedWork.release();
  }

  return { submitEngineSwitchResolution };
}
