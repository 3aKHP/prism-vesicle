import type { RunPromptResult } from "../core/agent-loop/run";
import type { PermissionRequest } from "../core/permissions";
import { displayTextFromThinkingBlocks } from "../providers/shared/thinking";
import { renderValidationNotice } from "./commands/render";
import { truncateLine } from "./format";
import type { QueuedWorkController } from "./queued-work-controller";
import type { TurnDecisionPort, TurnHostActionPort, TurnRuntimePort, TurnSessionPort, TurnTranscriptPort, TurnUsagePort } from "./turn-controller-options";
import { parseToolArgs, toolTarget } from "./tool-render";
import type { Message } from "./types";

type ResultOptions = {
  runtime: Pick<TurnRuntimePort, "activeEngine" | "activeModel">;
  session: Pick<TurnSessionPort, "setConversation" | "setSessionId" | "setSessionPath" | "setSessionPicker">;
  transcript: Pick<TurnTranscriptPort, "setMessages" | "setOutput" | "setStatus" | "lastDisplayedToolAssistantContent" | "setLastDisplayedToolAssistantContent">;
  decision: Pick<TurnDecisionPort,
    | "setPendingEngineSwitch" | "setPendingGate" | "setPendingPermission"
    | "setPendingQualityDecision" | "setPendingUserQuestion"
    | "clearQuestionFreeform" | "setGateFocus" | "setGateFeedbackMode" | "clearGateFeedback"
    | "setQuestionSelected" | "setQualitySelected">;
  usage: Pick<TurnUsagePort, "publishTurnUsage">;
  hostAction: Pick<TurnHostActionPort, "refreshArtifacts" | "refreshQualityWarnings">;
  queuedWork: QueuedWorkController;
};

export function createTurnResultController(options: ResultOptions) {
  const { activeEngine, activeModel } = options.runtime;
  const { setConversation, setSessionId, setSessionPath, setSessionPicker } = options.session;
  const { setMessages, setOutput, setStatus, lastDisplayedToolAssistantContent, setLastDisplayedToolAssistantContent } = options.transcript;
  const { setPendingEngineSwitch, setPendingGate, setPendingPermission, setPendingQualityDecision, setPendingUserQuestion, clearQuestionFreeform, setGateFocus, setGateFeedbackMode, clearGateFeedback, setQuestionSelected, setQualitySelected } = options.decision;
  const { publishTurnUsage } = options.usage;
  const { refreshArtifacts, refreshQualityWarnings } = options.hostAction;
  const { queuedWork } = options;

  function handleResult(result: RunPromptResult): void {
    publishTurnUsage();
    if (result.kind === "complete") queuedWork.release();
    else queuedWork.block();
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
    setPendingGate({ ...result, engine: result.profile.id });
    setGateFocus("confirm");
    setGateFeedbackMode(null);
    clearGateFeedback();
    appendPendingAssistant(result.assistantContent, `Stop gate pending: ${result.gate.gate}. Use ↑/↓ + Enter, type to add a note, Tab to read the summary.`);
    setStatus(`gate pending: ${result.gate.gate}`);
  }

  function applyPendingEngineSwitchResult(result: Extract<RunPromptResult, { kind: "needs_engine_switch" }>): void {
    applyPendingResultBase(result);
    setPendingEngineSwitch(result);
    setGateFocus("confirm");
    setGateFeedbackMode(null);
    clearGateFeedback();
    appendPendingAssistant(result.assistantContent, `Engine switch requested: ${result.profile.id} -> ${result.request.targetEngine}. Confirm below to switch future turns.`);
    setStatus(`engine switch pending: ${result.request.targetEngine}`);
  }

  function applyPendingQuestionResult(result: Extract<RunPromptResult, { kind: "needs_user_question" }>): void {
    applyPendingResultBase(result);
    setPendingUserQuestion({ ...result, engine: result.profile.id });
    setQuestionSelected(0);
    clearQuestionFreeform();
    appendPendingAssistant(result.assistantContent, `Question pending: ${result.question.header}. Choose an option below to continue.`);
    setStatus(`question pending: ${result.question.header}`);
  }

  function applyPendingPermissionResult(result: Extract<RunPromptResult, { kind: "needs_permission" }>): void {
    applyPendingResultBase(result);
    setPendingPermission({ ...result, engine: result.profile.id });
    const target = permissionTargetSummary(result.request);
    appendPendingAssistant(
      result.assistantContent,
      `Permission pending: ${result.request.toolName}${target ? ` · ${target}` : ""}.`,
      Boolean(result.assistantContent),
    );
    setStatus(`permission pending: ${result.request.toolName}`);
  }

  function applyPendingQualityDecisionResult(result: Extract<RunPromptResult, { kind: "needs_quality_decision" }>): void {
    applyPendingResultBase(result);
    setPendingQualityDecision({ ...result, engine: result.profile.id });
    setQualitySelected(result.decision.canRetry ? 0 : 1);
    setMessages((previous) => [...previous, {
      role: "system",
      content: `Automatic quality revision is ${result.decision.reason}. The current version still has ${result.decision.findingCount} blocking finding${result.decision.findingCount === 1 ? "" : "s"}.`,
    }]);
    setStatus(`quality decision pending: ${result.decision.findingCount} finding${result.decision.findingCount === 1 ? "" : "s"}`);
    void refreshQualityWarnings(result.sessionId);
  }

  function applyPendingResultBase(result: Exclude<RunPromptResult, { kind: "complete" }>): void {
    setConversation([...result.messages]);
    setSessionId(result.sessionId);
    setSessionPath(result.sessionPath);
    setPendingGate(null);
    setPendingEngineSwitch(null);
    setPendingUserQuestion(null);
    setPendingPermission(null);
    setPendingQualityDecision(null);
    setSessionPicker(null);
    setOutput(result.assistantContent);
  }

  function appendPendingAssistant(content: string, notice: string, showAssistant = true): void {
    const alreadyDisplayed = lastDisplayedToolAssistantContent() === content;
    setMessages((previous) => [
      ...previous,
      ...(!alreadyDisplayed && showAssistant ? [{ role: "assistant" as const, content }] : []),
      { role: "system", content: notice },
    ]);
  }

  /**
   * One-line bounded summary of what the pending permission asks to do. The
   * approval box disappears once the turn resolves, so the transcript line is
   * the durable record; it reuses the `●` card header rendering so both stay
   * in the same vocabulary.
   */
  function permissionTargetSummary(request: PermissionRequest): string {
    const target = toolTarget(request.toolName, parseToolArgs(request.arguments));
    return target ? truncateLine(target.replace(/\s+/g, " ").trim(), 200) : "";
  }

  function applyCompleteResult(result: Extract<RunPromptResult, { kind: "complete" }>): void {
    clearPendingInteractions();
    setLastDisplayedToolAssistantContent(null);
    setConversation([...result.messages]);
    setSessionId(result.sessionId);
    setSessionPath(result.sessionPath);
    setOutput(result.response.content);
    void refreshArtifacts();
    const appended: Message[] = [];
    const reasoningText = displayTextFromThinkingBlocks(result.response.thinkingBlocks) ?? result.response.reasoningContent;
    if (!result.response.toolCalls?.length && reasoningText?.trim()) appended.push({ role: "system", content: reasoningText, kind: "reasoning" });
    if (!result.response.toolCalls?.length && result.response.content.trim()) {
      appended.push({ ...(result.assistantRecordUuid ? { id: result.assistantRecordUuid } : {}), role: "assistant", content: result.response.content, engine: activeEngine(), model: activeModel() });
    }
    // A clean auto-validation pass (no errors and no warnings) no longer gets a
    // message-stream card: it is still recorded in the activity log and the
    // validator still runs every turn, so a passing runtime-packet check no
    // longer interrupts every Stage turn (issue #111). Findings keep their
    // card. /validate renders its own notice through a separate command path.
    let validationErrors = 0;
    let validationWarnings = 0;
    if (result.validation) {
      for (const entry of result.validation.results) {
        validationErrors += entry.result.errors.length;
        validationWarnings += entry.result.warnings.length;
      }
    }
    if (result.validation && (validationErrors > 0 || validationWarnings > 0)) {
      appended.push({ role: "system", content: renderValidationNotice(result.validation) });
    }
    setMessages((previous) => [...previous, ...appended]);
    setStatus(validationErrors > 0 ? "complete with validation findings"
      : validationWarnings > 0 ? "complete with validation warnings"
        : result.quality?.outcome === "inconclusive" ? "complete; quality check incomplete"
          : result.quality?.outcome === "findings" ? `complete with ${result.quality.findingCount} observed style issue${result.quality.findingCount === 1 ? "" : "s"}`
            : result.quality?.outcome === "clean" ? "complete; no blocking quality rules matched"
              : "complete");
    void refreshQualityWarnings(result.sessionId);
  }

  function clearPendingInteractions(): void {
    setPendingGate(null);
    setPendingEngineSwitch(null);
    setPendingUserQuestion(null);
    setPendingPermission(null);
    setPendingQualityDecision(null);
    clearQuestionFreeform();
    setGateFeedbackMode(null);
    clearGateFeedback();
  }

  return { handleResult };
}
