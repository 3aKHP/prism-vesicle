import { createMemo, createSignal, type Accessor, type Setter } from "solid-js";
import type { EngineId } from "../core/engine/profile";
import type { GateResolution } from "../core/gate/types";
import type { PermissionMode, PermissionRequest, PermissionResolution } from "../core/permissions";
import {
  applyComposerKey,
  insertComposerText,
  printableTextFromKey,
  type ComposerState,
} from "./composer";
import {
  engineSwitchGateFocusOrder,
  gateComposerIsActive,
  gateFocusOrder,
  gateResolutionFromState,
  type GateFocusTarget,
  type PromptZone,
} from "./GatePrompt";
import { questionComposerIsActive, questionPanelMinHeight } from "./QuestionPrompt";
import { bodyScrollMaxOffset, bodyScrollWindow } from "./format";
import { permissionPanelHeight } from "./PermissionPrompt";
import {
  engineSwitchGateRequest,
  permissionResolutionFromGate,
  type PendingEngineSwitchState,
  type PendingGateState,
  type PendingPermissionState,
  type PendingQualityDecisionState,
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
  submitQualityDecision: (resolution: "retry" | "accept" | "stop") => void;
  applyPermissionMode: (mode: PermissionMode) => Promise<void>;
};

export function createDecisionController(options: DecisionControllerOptions) {
  const [pendingGate, rawSetPendingGate] = createSignal<PendingGateState | null>(null);
  const [pendingEngineSwitch, rawSetPendingEngineSwitch] = createSignal<PendingEngineSwitchState | null>(null);
  const [pendingUserQuestion, rawSetPendingUserQuestion] = createSignal<PendingUserQuestionState | null>(null);
  const [pendingPermission, rawSetPendingPermission] = createSignal<PendingPermissionState | null>(null);
  const [pendingQualityDecision, setPendingQualityDecision] = createSignal<PendingQualityDecisionState | null>(null);
  const [pendingChildPermission, rawSetPendingChildPermission] = createSignal<PermissionRequest | null>(null);
  const [yoloConfirmStage, setYoloConfirmStage] = createSignal<1 | 2 | null>(null);
  const [questionSelected, setQuestionSelected] = createSignal(0);
  const [qualitySelected, setQualitySelected] = createSignal(0);
  const [questionFreeformText, setQuestionFreeformText] = createSignal("");
  const [questionFreeformCursor, setQuestionFreeformCursor] = createSignal(0);
  const [questionFreeformKillBuffer, setQuestionFreeformKillBuffer] = createSignal<string | undefined>();
  const [gateFocus, setGateFocus] = createSignal<GateFocusTarget>("confirm");
  const [gateFeedbackMode, setGateFeedbackMode] = createSignal<GateFocusTarget | null>(null);
  const [gateFeedback, setGateFeedback] = createSignal("");
  const [gateFeedbackCursor, setGateFeedbackCursor] = createSignal(0);
  const [gateFeedbackKillBuffer, setGateFeedbackKillBuffer] = createSignal<string | undefined>();

  // —— body-reading focus zone (#268 item 4) ——
  // While a decision prompt with folded body text (gate summary, permission
  // detail, question text) is open, Tab/Shift+Tab toggle between the options
  // zone (today's decision keys) and a body zone where ↑/↓ scroll the folded
  // text. The scroll extent is reported by whichever prompt component is
  // rendering (registerBodyExtent), so the offset always clamps to the real
  // window even when wrapping or the panel budget changes.
  const [promptZone, setPromptZone] = createSignal<PromptZone>("options");
  const [bodyScrollOffset, setBodyScrollOffset] = createSignal(0);
  const [bodyExtent, setBodyExtent] = createSignal<{ total: number; visible: number }>({ total: 0, visible: 0 });

  const bodyScrollMax = () => {
    const { total, visible } = bodyExtent();
    return bodyScrollMaxOffset(total, visible);
  };
  function scrollBody(delta: 1 | -1): void {
    setBodyScrollOffset((current) => Math.min(bodyScrollMax(), Math.max(0, current + delta)));
  }
  function scrollBodyToEdge(edge: "home" | "end"): void {
    setBodyScrollOffset(edge === "home" ? 0 : bodyScrollMax());
  }
  /** Report the rendered body's line extent; the active prompt component
   * calls this whenever its wrapped-line count or visible budget changes.
   * The offset re-clamps through the shared window primitive so the rule
   * lives in one place. */
  function registerBodyExtent(total: number, visible: number): void {
    setBodyExtent({ total, visible });
    setBodyScrollOffset(bodyScrollWindow(total, visible, bodyScrollOffset()).start);
  }
  function enterBodyZone(): void {
    // No offset reset here: re-entering the body zone mid-prompt keeps the
    // reading position; only a new prompt (the reset effect) scrolls to top.
    setPromptZone("body");
  }
  function leaveBodyZone(): void {
    setPromptZone("options");
  }
  function isTabKey(key: TuiKeyEvent): boolean {
    return key.name === "tab";
  }
  /** Body-zone key routing, shared by the gate and question handlers: arrows
   * scroll, Home/End jump, Tab/Enter/Esc return to the options zone — Enter
   * never submits from the reading zone — and every other key is swallowed. */
  function handleBodyZoneKey(key: TuiKeyEvent): boolean {
    if (key.name === "up" || (key.ctrl && key.name === "p")) {
      scrollBody(-1);
      return true;
    }
    if (key.name === "down" || (key.ctrl && key.name === "n")) {
      scrollBody(1);
      return true;
    }
    if (key.name === "home") {
      scrollBodyToEdge("home");
      return true;
    }
    if (key.name === "end") {
      scrollBodyToEdge("end");
      return true;
    }
    if (isTabKey(key) || key.name === "return" || key.name === "enter" || key.name === "escape") {
      leaveBodyZone();
      return true;
    }
    return true;
  }
  // A new decision prompt (fresh request object) starts over: options zone,
  // scrolled to the top. The pending setters wrap this imperatively (not via
  // an effect) so the reset is exercised by the same unit tests that drive
  // the key routing.
  function resetBodyZoneState(): void {
    setPromptZone("options");
    setBodyScrollOffset(0);
    setBodyExtent({ total: 0, visible: 0 });
  }
  function wrapPendingSetter<T>(raw: Setter<T | null>): Setter<T | null> {
    // Solid's Setter is an overloaded generic; the assertion is confined to
    // this one seam and the wrapper forwards every form unchanged.
    return ((value: never) => {
      resetBodyZoneState();
      return raw(value);
    }) as Setter<T | null>;
  }
  const setPendingGate = wrapPendingSetter(rawSetPendingGate);
  const setPendingEngineSwitch = wrapPendingSetter(rawSetPendingEngineSwitch);
  const setPendingUserQuestion = wrapPendingSetter(rawSetPendingUserQuestion);
  const setPendingPermission = wrapPendingSetter(rawSetPendingPermission);
  const setPendingChildPermission = wrapPendingSetter(rawSetPendingChildPermission);

  const activeGateRequest = createMemo(() => {
    const gate = pendingGate();
    if (gate) return gate.gate;
    const engineSwitch = pendingEngineSwitch();
    return engineSwitch ? engineSwitchGateRequest(options.activeEngine(), engineSwitch.request) : null;
  });
  const activePermissionRequest = createMemo(() => pendingPermission()?.request ?? pendingChildPermission() ?? undefined);
  const decisionPanelMinHeight = createMemo(() => {
    const pending = pendingUserQuestion();
    if (pendingQualityDecision()) return 8;
    if (pendingEngineSwitch()) return 10;
    if (activePermissionRequest()) return permissionPanelHeight;
    return pending ? questionPanelMinHeight(pending.question, questionSelected()) : 9;
  });

  function handleQualityKey(key: TuiKeyEvent): boolean {
    const pending = pendingQualityDecision();
    if (!pending || options.busy()) return false;
    if (key.name === "up" || (key.ctrl && key.name === "p")) {
      setQualitySelected((current) => (current + 2) % 3);
      return true;
    }
    if (key.name === "down" || (key.ctrl && key.name === "n")) {
      setQualitySelected((current) => (current + 1) % 3);
      return true;
    }
    if (key.name === "escape") {
      options.setStatus("quality decision remains pending");
      return true;
    }
    if (key.name !== "return" && key.name !== "enter") return false;
    const resolution = (["retry", "accept", "stop"] as const)[qualitySelected()]!;
    if (resolution === "retry" && !pending.decision.canRetry) {
      options.setStatus(pending.decision.blockedReason ?? "quality retry is unavailable under the active Harness identity");
      return true;
    }
    options.submitQualityDecision(resolution);
    return true;
  }

  function handleGateKey(key: TuiKeyEvent): boolean {
    if (options.busy() && !pendingChildPermission()) return false;
    if (promptZone() === "body") return handleBodyZoneKey(key);
    const focusOrder = currentGateFocusOrder();
    const composerActive = gateComposerIsActive(gateFocus(), gateFeedbackMode());
    // Type-to-note (#268 item 4): plain typing (or paste, in handlePaste)
    // on a focused confirm option arms its note composer and lands there —
    // the question prompt's "free answer accepts typing" behavior, adopted
    // for the gate family. Reject always owns its composer already;
    // confirm-summary has no note surface, so typing there stays swallowed.
    const typeToNote = !composerActive && gateFocus() === "confirm" && printableTextFromKey(key).length > 0;
    if ((composerActive || typeToNote) && !isTabKey(key) && key.name !== "escape") {
      if (typeToNote) setGateFeedbackMode("confirm");
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
    if (isTabKey(key)) {
      enterBodyZone();
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
    if (promptZone() === "body") return handleBodyZoneKey(key);
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
    if (isTabKey(key)) {
      enterBodyZone();
      return true;
    }
    if (key.name === "return" || key.name === "enter") {
      options.submitQuestionOption(questionSelected());
      return true;
    }
    return false;
  }

  function handleQuestionComposerKey(key: TuiKeyEvent, optionCount: number, header: string): boolean {
    if (isTabKey(key)) {
      enterBodyZone();
      return true;
    }
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
      && promptZone() === "options") {
      // Same auto-arm as typing: paste into the gate family while no note
      // composer is live arms the focused option's note first (confirm only —
      // reject already owns its composer, confirm-summary has none).
      if (!gateComposerIsActive(gateFocus(), gateFeedbackMode())) {
        if (gateFocus() !== "confirm") return true;
        setGateFeedbackMode("confirm");
      }
      applyGateFeedbackState(insertComposerText(currentGateFeedbackState(), text));
      return true;
    }
    if (pendingUserQuestion() && promptZone() === "options" && questionComposerIsActive(selectedQuestionOption())) {
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
    bodyScrollOffset,
    clearGateFeedback,
    clearQuestionFreeform,
    decisionPanelMinHeight,
    gateFeedback,
    gateFeedbackCursor,
    gateFeedbackMode,
    gateFocus,
    handleGateKey,
    handleQualityKey,
    handlePaste,
    handleQuestionKey,
    handleYoloKey,
    pendingChildPermission,
    pendingEngineSwitch,
    pendingGate,
    pendingPermission,
    pendingQualityDecision,
    pendingUserQuestion,
    promptZone,
    questionFreeformCursor,
    questionFreeformText,
    questionSelected,
    qualitySelected,
    registerBodyExtent,
    setGateFeedback,
    setGateFeedbackCursor,
    setGateFeedbackKillBuffer,
    setGateFeedbackMode,
    setGateFocus,
    setPendingChildPermission,
    setPendingEngineSwitch,
    setPendingGate,
    setPendingPermission,
    setPendingQualityDecision,
    setPendingUserQuestion,
    setQuestionFreeformCursor,
    setQuestionFreeformKillBuffer,
    setQuestionFreeformText,
    setQuestionSelected,
    setQualitySelected,
    setYoloConfirmStage,
    yoloConfirmStage,
  };
}
