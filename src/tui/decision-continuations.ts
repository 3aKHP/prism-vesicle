import type { EngineSwitchConfirmedResult, RunPromptResult } from "../core/agent-loop/run";
import { resolveEngineSwitch, resolveGate, resolvePermission, resolveUserQuestion } from "../core/agent-loop/run";
import type { GateResolution } from "../core/gate/types";
import type { PermissionResolution } from "../core/permissions";
import { loadSessionSnapshot } from "../core/session/store";
import type { UserQuestionAnswer } from "../core/user-question/types";
import type { PendingEngineSwitchState, PendingPermissionState, PendingUserQuestionState } from "./decision-interaction";
import { displayUserQuestionAnswer } from "./decision-interaction";
import { displayTranscriptFromSnapshot, vesicleMessagesFromResumed } from "./session-presenter";
import type { DecisionContinuationOptions } from "./turn-controller-options";

export function createDecisionContinuations(options: DecisionContinuationOptions) {
  async function submitPermissionResolution(resolution: PermissionResolution): Promise<void> {
    const pending = options.pendingPermission();
    if (!pending || options.busy()) return;
    options.setBusy(true);
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
        agentManager: options.agentManager(),
        permissionBroker: options.permissionBroker,
      }));
      if (outcome.kind === "interrupted") {
        await reconcilePermissionAfterContinuationFailure(pending);
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
    const request = options.pendingChildPermission() as import("../core/permissions").PermissionRequest | null;
    if (!request || !options.permissionBroker.resolve(request.id, resolution)) return;
    options.setGateFeedbackMode(null);
    options.clearGateFeedback();
    options.setStatus(`${resolution.decision} ${request.agent?.handle ?? "SubAgent"} ${request.toolName}`);
    options.recordActivity({ kind: "agent", text: `${resolution.decision} ${request.agent?.handle ?? "SubAgent"} ${request.toolName}` });
  }

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
        agentManager: options.agentManager(),
        permissionBroker: options.permissionBroker,
      }));
      if (outcome.kind === "interrupted") {
        options.setPendingGate(gate);
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
        agentManager: options.agentManager(),
        permissionBroker: options.permissionBroker,
      }));
      if (outcome.kind === "interrupted") {
        options.setPendingEngineSwitch(pending);
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
  }

  async function submitUserQuestionAnswer(selectedIndex: number): Promise<void> {
    const pending = options.pendingUserQuestion();
    if (!pending || options.busy()) return;
    const option = pending.question.options[selectedIndex];
    if (!option) return;
    if (option.kind === "freeform") {
      submitUserQuestionFreeform(options.questionFreeformText());
      return;
    }
    await submitUserQuestionAnswerPayload(pending, {
      selectedIndex,
      label: option.label,
      description: option.description,
      ...(option.kind ? { kind: option.kind } : {}),
    }, selectedIndex);
  }

  function submitUserQuestionFreeform(value: unknown): void {
    const pending = options.pendingUserQuestion();
    if (!pending || options.busy()) return;
    const text = (typeof value === "string" ? value : options.questionFreeformText()).trim();
    if (!text) {
      options.setStatus("type a free-form answer or press Esc");
      return;
    }
    const selectedIndex = options.questionSelected();
    const option = pending.question.options[selectedIndex];
    if (!option || option.kind !== "freeform") return;
    options.clearQuestionFreeform();
    void submitUserQuestionAnswerPayload(pending, {
      selectedIndex,
      label: option.label,
      description: option.description,
      kind: "freeform",
      freeformText: text,
    }, selectedIndex);
  }

  async function submitUserQuestionAnswerPayload(
    pending: PendingUserQuestionState,
    answer: UserQuestionAnswer,
    selectedIndex: number,
  ): Promise<void> {
    options.setBusy(true);
    options.setStatus(`answering question: ${pending.question.header}`);
    options.recordActivity({ kind: "gate", text: `answering question ${pending.question.header}: ${answer.kind === "freeform" ? "Other" : answer.label}` });
    options.setPendingUserQuestion(null);
    options.setQuestionSelected(0);
    options.clearQuestionFreeform();
    options.setMessages((previous) => [...previous, { role: "user", content: displayUserQuestionAnswer(pending.question.header, answer) }]);
    options.beginUsageTurn();
    try {
      const outcome = await options.runCancellable((signal) => resolveUserQuestion({
        engine: pending.engine,
        sessionId: pending.sessionId,
        messages: pending.messages,
        toolCallId: pending.toolCallId,
        question: pending.question,
        answer,
        providerSelection: options.activeProviderSelection(),
        generation: options.activeGeneration(),
        permission: options.permissionContext(),
        signal,
        onEvent: options.handleAgentEvent,
        agentManager: options.agentManager(),
        permissionBroker: options.permissionBroker,
      }));
      if (outcome.kind === "interrupted") {
        options.setPendingUserQuestion(pending);
        options.setQuestionSelected(selectedIndex);
        options.handleInterruptedTurn();
      } else options.handleResult(outcome.value);
    } catch (error) {
      options.setPendingUserQuestion(pending);
      options.setQuestionSelected(selectedIndex);
      options.reportError(error);
    } finally {
      options.setBusy(false);
    }
  }

  return {
    submitChildPermissionResolution,
    submitEngineSwitchResolution,
    submitGateResolution,
    submitPermissionResolution,
    submitUserQuestionAnswer,
    submitUserQuestionFreeform,
  };
}
