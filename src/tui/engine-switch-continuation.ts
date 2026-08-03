import { resolveEngineSwitch, type EngineSwitchConfirmedResult } from "../core/agent-loop/run";
import type { RunPromptResult } from "../core/agent-loop/run";
import type { GateResolution } from "../core/gate/types";
import type { PendingEngineSwitchState } from "./decision-interaction";
import type { QueuedWorkController } from "./queued-work-controller";
import type { PermissionContext, TurnAgentPort, TurnDecisionPort, TurnHostActionPort, TurnRuntimePort, TurnSessionPort, TurnTranscriptPort, TurnUsagePort, TurnRunCancellable } from "./turn-controller-options";

type EngineSwitchContinuationOptions = {
  runtime: Pick<TurnRuntimePort, "activeEngine" | "setActiveEngine" | "activeProviderSelection" | "activeGeneration" | "busy" | "setBusy" | "permissionBroker">;
  decision: Pick<TurnDecisionPort, "pendingEngineSwitch" | "setPendingEngineSwitch" | "setGateFeedbackMode" | "clearGateFeedback">;
  transcript: Pick<TurnTranscriptPort, "setMessages" | "setStatus" | "recordActivity">;
  agent: Pick<TurnAgentPort, "agentManager" | "handleAgentEvent" | "onProviderContextSnapshot">;
  usage: Pick<TurnUsagePort, "beginUsageTurn">;
  session: Pick<TurnSessionPort, "setConversation" | "setSessionId" | "setSessionPath">;
  hostAction: Pick<TurnHostActionPort, "compactSession">;
  queuedWork: QueuedWorkController;
  runCancellable: TurnRunCancellable;
  handleResult: (result: RunPromptResult) => void;
  handleInterruptedTurn: () => void;
  reportError: (error: unknown) => void;
  permissionContext: () => PermissionContext;
};

export function createEngineSwitchContinuation(options: EngineSwitchContinuationOptions) {
  const { activeEngine, setActiveEngine, activeProviderSelection, activeGeneration, busy, setBusy, permissionBroker } = options.runtime;
  const { pendingEngineSwitch, setPendingEngineSwitch, setGateFeedbackMode, clearGateFeedback } = options.decision;
  const { setMessages, setStatus, recordActivity } = options.transcript;
  const { agentManager, handleAgentEvent, onProviderContextSnapshot } = options.agent;
  const { beginUsageTurn } = options.usage;
  const { setConversation, setSessionId, setSessionPath } = options.session;
  const { compactSession } = options.hostAction;
  const { queuedWork, runCancellable, handleResult, handleInterruptedTurn, reportError, permissionContext } = options;

  async function submitEngineSwitchResolution(
    resolution: GateResolution,
    submitOptions: { summarizeContext?: boolean } = {},
  ): Promise<void> {
    const pending = pendingEngineSwitch();
    if (!pending || busy()) return;
    const summarizeContext = resolution.decision === "confirm" && submitOptions.summarizeContext === true;
    let switchApplied = false;
    beginEngineSwitchResolution(pending, resolution, summarizeContext);
    try {
      const outcome = await runCancellable((signal) => resolveEngineSwitch({
        engine: pending.profile?.id ?? activeEngine(),
        sessionId: pending.sessionId,
        messages: pending.messages,
        toolCallId: pending.toolCallId,
        request: pending.request,
        resolution,
        ...(summarizeContext ? { contextPolicy: "summary" as const } : {}),
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
        if (!await queuedWork.handleInterruption(pending.sessionId)) setPendingEngineSwitch(pending);
        handleInterruptedTurn();
        return;
      }
      if (outcome.value.kind === "engine_switched") {
        switchApplied = true;
        await applyEngineSwitchResult(outcome.value, summarizeContext);
      } else handleResult(outcome.value);
    } catch (error) {
      if (!switchApplied) setPendingEngineSwitch(pending);
      reportError(error);
    } finally {
      setBusy(false);
    }
  }

  function beginEngineSwitchResolution(pending: PendingEngineSwitchState, resolution: GateResolution, summarize: boolean): void {
    setBusy(true);
    queuedWork.block();
    setStatus(summarize ? "resolving engine switch with summary" : `resolving engine switch: ${resolution.decision}`);
    recordActivity({ kind: "gate", text: `resolving engine switch to ${pending.request.targetEngine} as ${summarize ? "confirm-summary" : resolution.decision}` });
    setPendingEngineSwitch(null);
    setGateFeedbackMode(null);
    clearGateFeedback();
    setMessages((previous) => [...previous, {
      role: "user",
      content: `[engine-switch:${pending.request.targetEngine}] ${resolution.decision}${resolution.feedback ? ` — ${resolution.feedback}` : ""}`,
    }]);
    if (resolution.decision !== "confirm") beginUsageTurn();
  }

  async function applyEngineSwitchResult(result: EngineSwitchConfirmedResult, summarizeContext: boolean): Promise<void> {
    setConversation([...result.messages]);
    setSessionId(result.sessionId);
    setSessionPath(result.sessionPath);
    setActiveEngine(result.engine);
    setStatus(`engine ${result.engine}`);
    recordActivity({ kind: "system", text: `engine switched to ${result.engine}` });
    if (summarizeContext) {
      const compact = await compactSession("Preserve the engine handoff, user intent, important files/artifacts, unresolved issues, and the next useful step.");
      setMessages((previous) => [...previous, { role: "system", content: `Engine switched to ${result.engine} with summarized context (${compact.messagesSummarized} messages). Future turns will use that profile.` }]);
    } else {
      setMessages((previous) => [...previous, { role: "system", content: `Engine switched to ${result.engine}. Future turns will use that profile.` }]);
    }
    queuedWork.release();
  }

  return { submitEngineSwitchResolution };
}
