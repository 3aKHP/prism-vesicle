import { createMemo, createSignal, type Accessor, type Setter } from "solid-js";
import type { EngineId } from "../core/engine/profile";
import type { GateResolution } from "../core/gate/types";
import type { PermissionMode, PermissionRequest, PermissionResolution } from "../core/permissions";
import {
  applyComposerKey,
  insertComposerText,
  type ComposerState,
} from "./composer";
import {
  engineSwitchGateFocusOrder,
  gateComposerIsActive,
  gateFocusOrder,
  gateResolutionFromState,
  type GateFocusTarget,
} from "./GatePrompt";
import { questionComposerIsActive, questionPanelMinHeight } from "./QuestionPrompt";
import { permissionPanelHeight } from "./PermissionPrompt";
import {
  engineSwitchGateRequest,
  permissionResolutionFromGate,
  type PendingEngineSwitchState,
  type PendingGateState,
  type PendingPermissionState,
  type PendingUserQuestionState,
  type TuiKeyEvent,
} from "./decision-interaction";

export type DecisionControllerOptions = {
  busy: Accessor<boolean>;
  activeEngine: Accessor<EngineId>;
  permissionMode: Accessor<PermissionMode>;
  setStatus: Setter<string>;
  submitPermission: (resolution: PermissionResolution) => void;
  submitChildPermission: (resolution: PermissionResolution) => void;
  submitEngineSwitch: (resolution: GateResolution, options?: { summarizeContext?: boolean }) => void;
  submitGate: (resolution: GateResolution) => void;
  submitQuestionOption: (selectedIndex: number) => void;
  submitQuestionFreeform: (value: unknown) => void;
  applyPermissionMode: (mode: PermissionMode) => Promise<void>;
};

export function createDecisionController(options: DecisionControllerOptions) {
  const [pendingGate, setPendingGate] = createSignal<PendingGateState | null>(null);
  const [pendingEngineSwitch, setPendingEngineSwitch] = createSignal<PendingEngineSwitchState | null>(null);
  const [pendingUserQuestion, setPendingUserQuestion] = createSignal<PendingUserQuestionState | null>(null);
  const [pendingPermission, setPendingPermission] = createSignal<PendingPermissionState | null>(null);
  const [pendingChildPermission, setPendingChildPermission] = createSignal<PermissionRequest | null>(null);
  const [yoloConfirmStage, setYoloConfirmStage] = createSignal<1 | 2 | null>(null);
  const [questionSelected, setQuestionSelected] = createSignal(0);
  const [questionFreeformText, setQuestionFreeformText] = createSignal("");
  const [questionFreeformCursor, setQuestionFreeformCursor] = createSignal(0);
  const [questionFreeformKillBuffer, setQuestionFreeformKillBuffer] = createSignal<string | undefined>();
  const [gateFocus, setGateFocus] = createSignal<GateFocusTarget>("confirm");
  const [gateFeedbackMode, setGateFeedbackMode] = createSignal<GateFocusTarget | null>(null);
  const [gateFeedback, setGateFeedback] = createSignal("");
  const [gateFeedbackCursor, setGateFeedbackCursor] = createSignal(0);
  const [gateFeedbackKillBuffer, setGateFeedbackKillBuffer] = createSignal<string | undefined>();

  const activeGateRequest = createMemo(() => {
    const gate = pendingGate();
    if (gate) return gate.gate;
    const engineSwitch = pendingEngineSwitch();
    return engineSwitch ? engineSwitchGateRequest(options.activeEngine(), engineSwitch.request) : null;
  });
  const activePermissionRequest = createMemo(() => pendingPermission()?.request ?? pendingChildPermission() ?? undefined);
  const decisionPanelMinHeight = createMemo(() => {
    const pending = pendingUserQuestion();
    if (pendingEngineSwitch()) return 10;
    if (activePermissionRequest()) return permissionPanelHeight;
    return pending ? questionPanelMinHeight(pending.question, questionSelected()) : 9;
  });

  function handleGateKey(key: TuiKeyEvent): boolean {
    if (options.busy() && !pendingChildPermission()) return false;
    const focusOrder = currentGateFocusOrder();
    if (gateComposerIsActive(gateFocus(), gateFeedbackMode()) && key.name !== "tab" && key.name !== "escape") {
      const result = applyComposerKey(currentGateFeedbackState(), key);
      if (result.handled) {
        applyGateFeedbackState(result.state);
        if (result.action?.type === "submit") submitFocusedGate(gateResolutionFromState(gateFocus(), result.action.value));
        else if (result.action?.type === "history_up") moveGateFocus(-1, focusOrder);
        else if (result.action?.type === "history_down") moveGateFocus(1, focusOrder);
        return true;
      }
    }
    if (key.name === "up" || (key.ctrl && key.name === "p")) {
      moveGateFocus(-1, focusOrder);
      return true;
    }
    if (key.name === "down" || (key.ctrl && key.name === "n")) {
      moveGateFocus(1, focusOrder);
      return true;
    }
    if (key.name === "tab") {
      const target = gateFocus();
      if (target === "reject" || target === "confirm-summary") return true;
      setGateFeedbackMode((previous) => previous === target ? null : target);
      clearGateFeedback();
      return true;
    }
    if (key.name === "return" || key.name === "enter") {
      submitFocusedGate(gateResolutionFromState(gateFocus(), gateFeedback()));
      return true;
    }
    if (key.name === "escape") {
      setGateFeedbackMode(null);
      clearGateFeedback();
      setGateFocus("reject");
      return true;
    }
    return false;
  }

  function submitFocusedGate(resolution: GateResolution): void {
    if (pendingPermission()) options.submitPermission(permissionResolutionFromGate(resolution));
    else if (pendingChildPermission()) options.submitChildPermission(permissionResolutionFromGate(resolution));
    else if (pendingEngineSwitch()) options.submitEngineSwitch(resolution, { summarizeContext: gateFocus() === "confirm-summary" });
    else options.submitGate(resolution);
  }

  function handleYoloKey(key: TuiKeyEvent): boolean {
    if (key.name === "up" || key.name === "down" || (key.ctrl && (key.name === "p" || key.name === "n"))) {
      setGateFocus((current) => current === "confirm" ? "reject" : "confirm");
      return true;
    }
    if (key.name === "escape") {
      setGateFocus("reject");
      setYoloConfirmStage(null);
      options.setStatus(`permission mode ${options.permissionMode()}`);
      return true;
    }
    if (key.name !== "return" && key.name !== "enter") return false;
    if (gateFocus() === "reject") {
      setYoloConfirmStage(null);
      options.setStatus(`permission mode ${options.permissionMode()}`);
    } else if (yoloConfirmStage() === 1) {
      setYoloConfirmStage(2);
    } else {
      void options.applyPermissionMode("YOLO");
      setYoloConfirmStage(null);
    }
    return true;
  }

  function handleQuestionKey(key: TuiKeyEvent): boolean {
    const pending = pendingUserQuestion();
    if (!pending || options.busy()) return false;
    const selectedOption = pending.question.options[questionSelected()];
    if (questionComposerIsActive(selectedOption)) return handleQuestionComposerKey(key, pending.question.options.length, pending.question.header);
    if (key.name === "up" || (key.ctrl && key.name === "p")) {
      moveQuestionSelection(-1, pending.question.options.length);
      return true;
    }
    if (key.name === "down" || (key.ctrl && key.name === "n")) {
      moveQuestionSelection(1, pending.question.options.length);
      return true;
    }
    if (key.name === "return" || key.name === "enter") {
      options.submitQuestionOption(questionSelected());
      return true;
    }
    return false;
  }

  function handleQuestionComposerKey(key: TuiKeyEvent, optionCount: number, header: string): boolean {
    if (key.name === "escape") {
      clearQuestionFreeform();
      options.setStatus(`question pending: ${header}`);
      return true;
    }
    const result = applyComposerKey(currentQuestionFreeformState(), key);
    if (!result.handled) return false;
    applyQuestionFreeformState(result.state);
    if (result.action?.type === "submit") options.submitQuestionFreeform(result.action.value);
    else if (result.action?.type === "history_up") moveQuestionSelection(-1, optionCount);
    else if (result.action?.type === "history_down") moveQuestionSelection(1, optionCount);
    return true;
  }

  function handlePaste(text: string): boolean {
    if ((pendingGate() || pendingEngineSwitch() || pendingPermission() || pendingChildPermission())
      && gateComposerIsActive(gateFocus(), gateFeedbackMode())) {
      applyGateFeedbackState(insertComposerText(currentGateFeedbackState(), text));
      return true;
    }
    if (pendingUserQuestion() && questionComposerIsActive(selectedQuestionOption())) {
      applyQuestionFreeformState(insertComposerText(currentQuestionFreeformState(), text));
      return true;
    }
    return false;
  }

  function currentGateFocusOrder(): GateFocusTarget[] {
    return pendingEngineSwitch() ? engineSwitchGateFocusOrder : gateFocusOrder;
  }

  function moveGateFocus(delta: -1 | 1, order = currentGateFocusOrder()): void {
    const current = gateFocus();
    const index = Math.max(0, order.indexOf(current));
    setGateFocus(order[(index + delta + order.length) % order.length]);
  }

  function moveQuestionSelection(delta: -1 | 1, count: number): void {
    setQuestionSelected((previous) => (previous + delta + count) % count);
  }

  function selectedQuestionOption() {
    const pending = pendingUserQuestion();
    return pending?.question.options[questionSelected()];
  }

  function currentGateFeedbackState(): ComposerState {
    return { value: gateFeedback(), cursor: gateFeedbackCursor(), killBuffer: gateFeedbackKillBuffer(), elements: [] };
  }

  function applyGateFeedbackState(state: ComposerState): void {
    setGateFeedback(state.value);
    setGateFeedbackCursor(state.cursor);
    setGateFeedbackKillBuffer(state.killBuffer);
  }

  function currentQuestionFreeformState(): ComposerState {
    return { value: questionFreeformText(), cursor: questionFreeformCursor(), killBuffer: questionFreeformKillBuffer(), elements: [] };
  }

  function applyQuestionFreeformState(state: ComposerState): void {
    setQuestionFreeformText(state.value);
    setQuestionFreeformCursor(state.cursor);
    setQuestionFreeformKillBuffer(state.killBuffer);
  }

  function clearGateFeedback(): void {
    setGateFeedback("");
    setGateFeedbackCursor(0);
    setGateFeedbackKillBuffer(undefined);
  }

  function clearQuestionFreeform(): void {
    setQuestionFreeformText("");
    setQuestionFreeformCursor(0);
    setQuestionFreeformKillBuffer(undefined);
  }

  return {
    activeGateRequest,
    activePermissionRequest,
    clearGateFeedback,
    clearQuestionFreeform,
    decisionPanelMinHeight,
    gateFeedback,
    gateFeedbackCursor,
    gateFeedbackMode,
    gateFocus,
    handleGateKey,
    handlePaste,
    handleQuestionKey,
    handleYoloKey,
    pendingChildPermission,
    pendingEngineSwitch,
    pendingGate,
    pendingPermission,
    pendingUserQuestion,
    questionFreeformCursor,
    questionFreeformText,
    questionSelected,
    setGateFeedback,
    setGateFeedbackCursor,
    setGateFeedbackKillBuffer,
    setGateFeedbackMode,
    setGateFocus,
    setPendingChildPermission,
    setPendingEngineSwitch,
    setPendingGate,
    setPendingPermission,
    setPendingUserQuestion,
    setQuestionFreeformCursor,
    setQuestionFreeformKillBuffer,
    setQuestionFreeformText,
    setQuestionSelected,
    setYoloConfirmStage,
    yoloConfirmStage,
  };
}
