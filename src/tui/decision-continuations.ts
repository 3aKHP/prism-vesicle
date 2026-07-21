import type { EngineSwitchConfirmedResult } from "../core/agent-loop/run";
import { resolveEngineSwitch, resolveGate, resolvePermission, resolveQualityDecision, resolveUserQuestion } from "../core/agent-loop/run";
import type { GateResolution } from "../core/gate/types";
import type { PermissionResolution } from "../core/permissions";
import { loadSessionSnapshot } from "../core/session/store";
import type { UserQuestionAnswer } from "../core/user-question/types";
import type { PendingEngineSwitchState, PendingPermissionState, PendingQualityDecisionState, PendingUserQuestionState } from "./decision-interaction";
import { displayUserQuestionAnswer } from "./decision-interaction";
import { displayTranscriptFromSnapshot, vesicleMessagesFromResumed } from "./session-presenter";
import type { DecisionContinuationOptions } from "./turn-controller-options";
import { pendingQualityDecisionFromSnapshot } from "./quality-decision-state";

export function createDecisionContinuations(options: DecisionContinuationOptions) {
  async function submitQualityDecision(resolution: "retry" | "accept" | "stop"): Promise<void> {
    const pending = options.pendingQualityDecision();
    if (!pending || options.busy()) return;
    if (resolution === "retry" && !pending.decision.canRetry) {
      options.setStatus(pending.decision.blockedReason ?? "quality retry is unavailable under the active Harness identity");
      return;
    }
    options.setBusy(true);
    options.setQueuedInputReady(false);
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
        agentManager: options.agentManager(),
        permissionBroker: options.permissionBroker,
        takePendingUserInputs: options.takePendingUserInputs,
        runToolBoundaryCommands: options.runToolBoundaryCommands,
      });
      if (resolution === "retry") {
        const outcome = await options.runCancellable((signal) => execute(signal));
        if (outcome.kind === "interrupted") {
          if (options.queuedSendAfterInterrupt()) await reconcileInterruptedForQueuedInput(pending.sessionId);
          else await reconcileQualityDecision(pending);
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
    options.setQueuedInputReady(true);
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

  async function submitPermissionResolution(resolution: PermissionResolution): Promise<void> {
    const pending = options.pendingPermission();
    if (!pending || options.busy()) return;
    options.setBusy(true);
    options.setQueuedInputReady(false);
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
        takePendingUserInputs: options.takePendingUserInputs,
        runToolBoundaryCommands: options.runToolBoundaryCommands,
      }));
      if (outcome.kind === "interrupted") {
        if (options.queuedSendAfterInterrupt()) await reconcileInterruptedForQueuedInput(pending.sessionId);
        else await reconcilePermissionAfterContinuationFailure(pending);
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
        takePendingUserInputs: options.takePendingUserInputs,
        runToolBoundaryCommands: options.runToolBoundaryCommands,
      }));
      if (outcome.kind === "interrupted") {
        if (options.queuedSendAfterInterrupt()) await reconcileInterruptedForQueuedInput(gate.sessionId);
        else options.setPendingGate(gate);
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
    options.setQueuedInputReady(false);
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
        takePendingUserInputs: options.takePendingUserInputs,
        runToolBoundaryCommands: options.runToolBoundaryCommands,
      }));
      if (outcome.kind === "interrupted") {
        if (options.queuedSendAfterInterrupt()) await reconcileInterruptedForQueuedInput(pending.sessionId);
        else options.setPendingEngineSwitch(pending);
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
    options.setQueuedInputReady(false);
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
    options.setQueuedInputReady(true);
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
      ...(option.id ? { optionId: option.id } : {}),
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
    let recoveryState: "restored" | "resolved" | "blocked" = "resolved";
    let recoveryStatus: string | undefined;
    options.setBusy(true);
    options.setQueuedInputReady(false);
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
        delegationDecision: pending.delegationDecision,
        answer,
        providerSelection: options.activeProviderSelection(),
        generation: options.activeGeneration(),
        permission: options.permissionContext(),
        signal,
        onEvent: options.handleAgentEvent,
        agentManager: options.agentManager(),
        permissionBroker: options.permissionBroker,
        takePendingUserInputs: options.takePendingUserInputs,
        runToolBoundaryCommands: options.runToolBoundaryCommands,
      }));
      if (outcome.kind === "interrupted") {
        if (options.queuedSendAfterInterrupt()) {
          await reconcileInterruptedForQueuedInput(pending.sessionId);
        } else {
          ({ state: recoveryState, status: recoveryStatus } = await reconcileUserQuestionAfterContinuationFailure(pending, selectedIndex));
        }
        options.handleInterruptedTurn();
        if (recoveryStatus) options.setStatus(recoveryStatus);
      } else options.handleResult(outcome.value);
    } catch (error) {
      ({ state: recoveryState, status: recoveryStatus } = await reconcileUserQuestionAfterContinuationFailure(pending, selectedIndex));
      options.reportError(error);
      if (recoveryStatus) options.setStatus(recoveryStatus);
    } finally {
      options.setBusy(recoveryState === "blocked");
    }
  }

  async function reconcileUserQuestionAfterContinuationFailure(
    pending: PendingUserQuestionState,
    selectedIndex: number,
  ): Promise<{
    state: "restored" | "resolved" | "blocked";
    status?: string;
  }> {
    try {
      const snapshot = await loadSessionSnapshot(options.rootDir, pending.sessionId, {
        synthesizeDanglingToolResults: false,
      });
      if (snapshot.pendingDelegationRetry || snapshot.pendingDelegationDecisionRecovery) {
        options.setPendingUserQuestion(null);
        return {
          state: "blocked",
          status: "Harness delegation recovery pending; restart Vesicle and resume this session",
        };
      }
      if (snapshot.pendingUserQuestion?.toolCallId === pending.toolCallId) {
        options.setPendingUserQuestion(pending);
        options.setQuestionSelected(selectedIndex);
        return { state: "restored" };
      }
      options.setPendingUserQuestion(null);
      options.setConversation(vesicleMessagesFromResumed(snapshot.messages));
      options.setMessages(displayTranscriptFromSnapshot(snapshot.messages, options.agentCards()));
      return {
        state: "resolved",
        status: "question resolved; provider continuation stopped",
      };
    } catch {
      options.setPendingUserQuestion(null);
      return {
        state: "blocked",
        status: "Unable to verify Harness delegation recovery; restart Vesicle and resume this session",
      };
    }
  }

  async function reconcileInterruptedForQueuedInput(sessionId: string): Promise<void> {
    const snapshot = await loadSessionSnapshot(options.rootDir, sessionId, { synthesizeDanglingToolResults: true });
    options.setConversation(vesicleMessagesFromResumed(snapshot.messages));
    options.setMessages(displayTranscriptFromSnapshot(snapshot.messages, options.agentCards()));
  }

  return {
    submitQualityDecision,
    submitChildPermissionResolution,
    submitEngineSwitchResolution,
    submitGateResolution,
    submitPermissionResolution,
    submitUserQuestionAnswer,
    submitUserQuestionFreeform,
  };
}
