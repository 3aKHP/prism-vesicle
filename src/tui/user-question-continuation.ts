import { resolveUserQuestion } from "../core/agent-loop/run";
import type { UserQuestionAnswer } from "../core/user-question/types";
import { displayUserQuestionAnswer, type PendingUserQuestionState } from "./decision-interaction";
import { displayTranscriptFromSnapshot, vesicleMessagesFromResumed } from "./session-presenter";
import { loadSessionSnapshot } from "../core/session/store";
import type { DecisionContinuationOptions } from "./turn-controller-options";

type UserQuestionContinuationOptions = Pick<DecisionContinuationOptions,
  | "activeGeneration" | "activeProviderSelection" | "agentCards" | "agentManager" | "beginUsageTurn"
  | "busy" | "clearQuestionFreeform" | "handleAgentEvent" | "handleInterruptedTurn" | "handleResult"
  | "onProviderContextSnapshot" | "pendingUserQuestion" | "permissionBroker" | "permissionContext"
  | "questionFreeformText" | "questionSelected" | "queuedWork" | "recordActivity" | "reportError"
  | "rootDir" | "runCancellable" | "setBusy" | "setConversation" | "setMessages" | "setPendingUserQuestion"
  | "setQuestionSelected" | "setStatus"
>;

export function createUserQuestionContinuation(options: UserQuestionContinuationOptions) {
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
    options.queuedWork.block();
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
        onProviderContextSnapshot: options.onProviderContextSnapshot,
        agentManager: options.agentManager(),
        permissionBroker: options.permissionBroker,
        takePendingUserInputs: options.queuedWork.takePendingUserInputs,
        runToolBoundaryCommands: options.queuedWork.runToolBoundaryCommands,
      }));
      if (outcome.kind === "interrupted") {
        if (!await options.queuedWork.handleInterruption(pending.sessionId)) {
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

  return { submitUserQuestionAnswer, submitUserQuestionFreeform };
}
