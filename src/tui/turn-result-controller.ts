import type { RunPromptResult } from "../core/agent-loop/run";
import { displayTextFromThinkingBlocks } from "../providers/shared/thinking";
import { renderValidationNotice } from "./commands/render";
import type { TurnControllerOptions } from "./turn-controller-options";
import type { Message } from "./types";

type ResultOptions = Pick<TurnControllerOptions,
  | "activeEngine"
  | "activeModel"
  | "clearGateFeedback"
  | "clearQuestionFreeform"
  | "lastDisplayedToolAssistantContent"
  | "publishTurnUsage"
  | "refreshArtifacts"
  | "setConversation"
  | "setGateFeedbackMode"
  | "setGateFocus"
  | "setLastDisplayedToolAssistantContent"
  | "setMessages"
  | "setOutput"
  | "setPendingEngineSwitch"
  | "setPendingGate"
  | "setPendingPermission"
  | "setPendingQualityDecision"
  | "setPendingUserQuestion"
  | "setQuestionSelected"
  | "setQualitySelected"
  | "setSessionId"
  | "setSessionPath"
  | "setSessionPicker"
  | "setStatus"
  | "refreshQualityWarnings"
>;

export function createTurnResultController(options: ResultOptions) {
  function handleResult(result: RunPromptResult): void {
    options.publishTurnUsage();
    switch (result.kind) {
      case "needs_user":
        applyPendingGateResult(result);
        return;
      case "needs_engine_switch":
        applyPendingEngineSwitchResult(result);
        return;
      case "needs_user_question":
        applyPendingQuestionResult(result);
        return;
      case "needs_permission":
        applyPendingPermissionResult(result);
        return;
      case "needs_quality_decision":
        applyPendingQualityDecisionResult(result);
        return;
      case "complete":
        applyCompleteResult(result);
        return;
    }
  }

  function applyPendingGateResult(result: Extract<RunPromptResult, { kind: "needs_user" }>): void {
    applyPendingResultBase(result);
    options.setPendingGate({ ...result, engine: result.profile.id });
    options.setGateFocus("confirm");
    options.setGateFeedbackMode(null);
    options.clearGateFeedback();
    appendPendingAssistant(result.assistantContent, `Stop gate pending: ${result.gate.gate}. Use ↑/↓ + Enter, or type into the amend box (Tab).`);
    options.setStatus(`gate pending: ${result.gate.gate}`);
  }

  function applyPendingEngineSwitchResult(result: Extract<RunPromptResult, { kind: "needs_engine_switch" }>): void {
    applyPendingResultBase(result);
    options.setPendingEngineSwitch(result);
    options.setGateFocus("confirm");
    options.setGateFeedbackMode(null);
    options.clearGateFeedback();
    appendPendingAssistant(result.assistantContent, `Engine switch requested: ${result.profile.id} -> ${result.request.targetEngine}. Confirm below to switch future turns.`);
    options.setStatus(`engine switch pending: ${result.request.targetEngine}`);
  }

  function applyPendingQuestionResult(result: Extract<RunPromptResult, { kind: "needs_user_question" }>): void {
    applyPendingResultBase(result);
    options.setPendingUserQuestion({ ...result, engine: result.profile.id });
    options.setQuestionSelected(0);
    options.clearQuestionFreeform();
    appendPendingAssistant(result.assistantContent, `Question pending: ${result.question.header}. Choose an option below to continue.`);
    options.setStatus(`question pending: ${result.question.header}`);
  }

  function applyPendingPermissionResult(result: Extract<RunPromptResult, { kind: "needs_permission" }>): void {
    applyPendingResultBase(result);
    options.setPendingPermission({ ...result, engine: result.profile.id });
    appendPendingAssistant(result.assistantContent, `Permission pending: ${result.request.toolName}.`, Boolean(result.assistantContent));
    options.setStatus(`permission pending: ${result.request.toolName}`);
  }

  function applyPendingQualityDecisionResult(result: Extract<RunPromptResult, { kind: "needs_quality_decision" }>): void {
    applyPendingResultBase(result);
    options.setPendingQualityDecision({ ...result, engine: result.profile.id });
    options.setQualitySelected(result.decision.canRetry ? 0 : 1);
    options.setMessages((previous) => [...previous, {
      role: "system",
      content: `Automatic quality revision is ${result.decision.reason}. The current version still has ${result.decision.findingCount} blocking finding${result.decision.findingCount === 1 ? "" : "s"}.`,
    }]);
    options.setStatus(`quality decision pending: ${result.decision.findingCount} finding${result.decision.findingCount === 1 ? "" : "s"}`);
    void options.refreshQualityWarnings(result.sessionId);
  }

  function applyPendingResultBase(result: Exclude<RunPromptResult, { kind: "complete" }>): void {
    options.setConversation([...result.messages]);
    options.setSessionId(result.sessionId);
    options.setSessionPath(result.sessionPath);
    options.setPendingGate(null);
    options.setPendingEngineSwitch(null);
    options.setPendingUserQuestion(null);
    options.setPendingPermission(null);
    options.setPendingQualityDecision(null);
    options.setSessionPicker(null);
    options.setOutput(result.assistantContent);
  }

  function appendPendingAssistant(content: string, notice: string, showAssistant = true): void {
    const alreadyDisplayed = options.lastDisplayedToolAssistantContent() === content;
    options.setMessages((previous) => [
      ...previous,
      ...(!alreadyDisplayed && showAssistant ? [{ role: "assistant" as const, content }] : []),
      { role: "system", content: notice },
    ]);
  }

  function applyCompleteResult(result: Extract<RunPromptResult, { kind: "complete" }>): void {
    clearPendingInteractions();
    options.setLastDisplayedToolAssistantContent(null);
    options.setConversation([...result.messages]);
    options.setSessionId(result.sessionId);
    options.setSessionPath(result.sessionPath);
    options.setOutput(result.response.content);
    void options.refreshArtifacts();
    const appended: Message[] = [];
    const reasoningText = displayTextFromThinkingBlocks(result.response.thinkingBlocks) ?? result.response.reasoningContent;
    if (!result.response.toolCalls?.length && reasoningText?.trim()) appended.push({ role: "system", content: reasoningText, kind: "reasoning" });
    if (!result.response.toolCalls?.length && result.response.content.trim()) {
      appended.push({ role: "assistant", content: result.response.content, engine: options.activeEngine(), model: options.activeModel() });
    }
    if (result.validation) appended.push({ role: "system", content: renderValidationNotice(result.validation) });
    options.setMessages((previous) => [...previous, ...appended]);
    options.setStatus(result.validation?.ok === false ? "complete with validation findings"
      : result.quality?.outcome === "inconclusive" ? "complete; quality check incomplete"
        : result.quality?.outcome === "findings" ? `complete with ${result.quality.findingCount} observed style issue${result.quality.findingCount === 1 ? "" : "s"}`
          : result.quality?.outcome === "clean" ? "complete; no blocking quality rules matched"
            : "complete");
    void options.refreshQualityWarnings(result.sessionId);
  }

  function clearPendingInteractions(): void {
    options.setPendingGate(null);
    options.setPendingEngineSwitch(null);
    options.setPendingUserQuestion(null);
    options.setPendingPermission(null);
    options.setPendingQualityDecision(null);
    options.clearQuestionFreeform();
    options.setGateFeedbackMode(null);
    options.clearGateFeedback();
  }

  return { handleResult };
}
