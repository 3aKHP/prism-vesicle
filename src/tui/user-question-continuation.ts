import { resolveUserQuestion } from "../core/agent-loop/run";
import type { RunPromptResult } from "../core/agent-loop/run";
import type { UserQuestionAnswer } from "../core/user-question/types";
import { displayUserQuestionAnswer, type PendingUserQuestionState } from "./decision-interaction";
import { displayTranscriptFromSnapshot, vesicleMessagesFromResumed } from "./session-presenter";
import { loadSessionSnapshot } from "../core/session/store";
import type { QueuedWorkController } from "./queued-work-controller";
import type { PermissionContext, TurnAgentPort, TurnDecisionPort, TurnRuntimePort, TurnSessionPort, TurnTranscriptPort, TurnUsagePort, TurnRunCancellable } from "./turn-controller-options";

type UserQuestionContinuationOptions = {
  runtime: Pick<TurnRuntimePort, "activeProviderSelection" | "activeGeneration" | "busy" | "setBusy" | "permissionBroker">;
  decision: Pick<TurnDecisionPort, "pendingUserQuestion" | "setPendingUserQuestion" | "questionSelected" | "setQuestionSelected" | "questionFreeformText" | "clearQuestionFreeform">;
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

export function createUserQuestionContinuation(options: UserQuestionContinuationOptions) {
  const { activeProviderSelection, activeGeneration, busy, setBusy, permissionBroker } = options.runtime;
  const { pendingUserQuestion, setPendingUserQuestion, questionSelected, setQuestionSelected, questionFreeformText, clearQuestionFreeform } = options.decision;
  const { setMessages, setStatus, recordActivity } = options.transcript;
  const { agentCards, agentManager, handleAgentEvent, onProviderContextSnapshot } = options.agent;
  const { beginUsageTurn } = options.usage;
  const { rootDir, setConversation } = options.session;
  const { queuedWork, runCancellable, handleResult, handleInterruptedTurn, reportError, permissionContext } = options;

  async function submitUserQuestionAnswer(selectedIndex: number): Promise<void> {
    const pending = pendingUserQuestion();
    if (!pending || busy()) return;
    const option = pending.question.options[selectedIndex];
    if (!option) return;
    if (option.kind === "freeform") {
      submitUserQuestionFreeform(questionFreeformText());
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
    const pending = pendingUserQuestion();
    if (!pending || busy()) return;
    const text = (typeof value === "string" ? value : questionFreeformText()).trim();
    if (!text) {
      setStatus("type a free-form answer or press Esc");
      return;
    }
    const selectedIndex = questionSelected();
    const option = pending.question.options[selectedIndex];
    if (!option || option.kind !== "freeform") return;
    clearQuestionFreeform();
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
    setBusy(true);
    queuedWork.block();
    setStatus(`answering question: ${pending.question.header}`);
    recordActivity({ kind: "gate", text: `answering question ${pending.question.header}: ${answer.kind === "freeform" ? "Other" : answer.label}` });
    setPendingUserQuestion(null);
    setQuestionSelected(0);
    clearQuestionFreeform();
    setMessages((previous) => [...previous, { role: "user", content: displayUserQuestionAnswer(pending.question.header, answer) }]);
    beginUsageTurn();
    try {
      const outcome = await runCancellable((signal) => resolveUserQuestion({
        engine: pending.engine,
        sessionId: pending.sessionId,
        messages: pending.messages,
        toolCallId: pending.toolCallId,
        question: pending.question,
        delegationDecision: pending.delegationDecision,
        answer,
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
        if (!await queuedWork.handleInterruption(pending.sessionId)) {
          ({ state: recoveryState, status: recoveryStatus } = await reconcileUserQuestionAfterContinuationFailure(pending, selectedIndex));
        }
        handleInterruptedTurn();
        if (recoveryStatus) setStatus(recoveryStatus);
      } else {
        handleResult(outcome.value);
        await options.refreshCandidateSwitcher(pending.sessionId);
      }
    } catch (error) {
      ({ state: recoveryState, status: recoveryStatus } = await reconcileUserQuestionAfterContinuationFailure(pending, selectedIndex));
      reportError(error);
      if (recoveryStatus) setStatus(recoveryStatus);
    } finally {
      setBusy(recoveryState === "blocked");
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
      const snapshot = await loadSessionSnapshot(rootDir, pending.sessionId, {
        synthesizeDanglingToolResults: false,
      });
      if (snapshot.pendingDelegationRetry || snapshot.pendingDelegationDecisionRecovery) {
        setPendingUserQuestion(null);
        return {
          state: "blocked",
          status: "Harness delegation recovery pending; restart Vesicle and resume this session",
        };
      }
      if (snapshot.pendingUserQuestion?.toolCallId === pending.toolCallId) {
        setPendingUserQuestion(pending);
        setQuestionSelected(selectedIndex);
        return { state: "restored" };
      }
      setPendingUserQuestion(null);
      setConversation(vesicleMessagesFromResumed(snapshot.messages));
      setMessages(displayTranscriptFromSnapshot(snapshot.messages, agentCards()));
      return {
        state: "resolved",
        status: "question resolved; provider continuation stopped",
      };
    } catch {
      setPendingUserQuestion(null);
      return {
        state: "blocked",
        status: "Unable to verify Harness delegation recovery; restart Vesicle and resume this session",
      };
    }
  }

  return { submitUserQuestionAnswer, submitUserQuestionFreeform };
}
