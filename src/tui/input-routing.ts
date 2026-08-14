import { useKeyboard, usePaste, useRenderer } from "@opentui/solid";
import type { Accessor, Setter } from "solid-js";
import type { GateRequest } from "../core/gate/types";
import type { PermissionRequest } from "../core/permissions";
import { copySelectionToClipboard } from "./clipboard";
import { normalizeKeyName } from "./composer";
import type { PendingQualityDecisionState, PendingUserQuestionState, TuiKeyEvent } from "./decision-interaction";
import { resolveBottomSurfaceMode, type ModelPickerState, type QualityPickerState, type QualityRewriteConfirmState } from "./views/BottomSurface";
import type { RewindPickerState, SessionPickerState } from "./types";
import type { BranchPickerState } from "./branch/controller";
import type { SkillPickerState } from "./skill-picker-controller";

export type InputRoutingOptions = {
  renderer: ReturnType<typeof useRenderer>;
  /** Called after the renderer has been destroyed when the user quits the TUI. */
  onExit?: () => void;
  setStatus: Setter<string>;
  rewindPicker: Accessor<RewindPickerState | null>;
  handleRewindKey: (key: TuiKeyEvent) => boolean;
  branchPicker: Accessor<BranchPickerState | null>;
  handleBranchKey: (key: TuiKeyEvent) => boolean;
  modelPicker: Accessor<ModelPickerState | null>;
  handleModelPickerKey: (key: TuiKeyEvent) => boolean;
  qualityPicker: Accessor<QualityPickerState | null>;
  handleQualityPickerKey: (key: TuiKeyEvent) => boolean;
  qualityRewriteConfirm: Accessor<QualityRewriteConfirmState | null>;
  handleRewriteConfirmKey: (key: TuiKeyEvent) => boolean;
  sessionPicker: Accessor<SessionPickerState | null>;
  handleSessionPickerKey: (key: TuiKeyEvent) => boolean;
  skillPicker: Accessor<SkillPickerState | null>;
  handleSkillPickerKey: (key: TuiKeyEvent) => boolean;
  yoloConfirmStage: Accessor<1 | 2 | null>;
  handleYoloKey: (key: TuiKeyEvent) => boolean;
  activePermissionRequest: Accessor<PermissionRequest | undefined>;
  pendingUserQuestion: Accessor<PendingUserQuestionState | null>;
  pendingQualityDecision?: Accessor<PendingQualityDecisionState | null>;
  handleQualityKey?: (key: TuiKeyEvent) => boolean;
  handleQuestionKey: (key: TuiKeyEvent) => boolean;
  activeGateRequest: Accessor<GateRequest | null>;
  handleGateKey: (key: TuiKeyEvent) => boolean;
  pasteClipboardImage: () => Promise<void>;
  handleComposerKey: (key: TuiKeyEvent) => boolean;
  handlePromptEscape: () => void;
  handleDecisionPaste: (text: string) => boolean;
  insertComposerPaste: (text: string) => void;
  handleStageMessageKey?: (key: TuiKeyEvent) => boolean;
  /** Ctrl+R on the Chat page: re-run the last turn as a new candidate (#88). */
  triggerRegenerate?: () => void;
  /** Ctrl+B on both pages: open the candidate-tree panel (any-depth switching). */
  triggerBranch?: () => void;
  /** Alt+←/→ reached a surface without the candidate switcher (Workspace/hero):
   * report guidance instead of swallowing the key silently. */
  onRejectedCandidateSwitch?: () => void;
  sideQuestionOverlay?: Accessor<unknown>;
  handleSideQuestionKey?: (key: TuiKeyEvent) => boolean;
  splashActive?: Accessor<boolean>;
  dismissSplash?: () => void;
  artifactFocusActive?: Accessor<boolean>;
  enterArtifactFocus?: () => boolean;
  handleArtifactFocusKey?: (key: TuiKeyEvent) => boolean;
  togglePage?: () => void;
  workspaceActive?: Accessor<boolean>;
  workspaceFocusRegion?: Accessor<string>;
  workspaceEditableSourcePasteActive?: Accessor<boolean>;
  handleWorkspaceKey?: (key: TuiKeyEvent) => boolean;
};

export type InputRouter = {
  handleKey: (rawKey: TuiKeyEvent) => void;
  handlePaste: (event: { bytes: Uint8Array; preventDefault: () => void }) => void;
};

type WorkspacePasteOwnership = "shared-composer" | "native-editor" | "blocked";

function resolveWorkspacePasteOwnership(options: InputRoutingOptions): WorkspacePasteOwnership {
  if (!options.workspaceActive?.()) return "shared-composer";
  const region = options.workspaceFocusRegion?.();
  if (region === "composer") return "shared-composer";
  if (region === "editor" && options.workspaceEditableSourcePasteActive?.() === true) {
    return "native-editor";
  }
  return "blocked";
}

/**
 * Pure routing decisions, factored out of the SolidJS hooks so they can be
 * exercised directly in tests (the headless testRender harness never fires
 * `useKeyboard`'s onMount, so the mounted hook itself is not testable).
 * `useInputRouting` wires this into `useKeyboard` / `usePaste` unchanged.
 */
export function createInputRouter(options: InputRoutingOptions): InputRouter {
  let lastCtrlCAt = 0;
  const quit = () => process.nextTick(() => {
    options.renderer.destroy();
    options.onExit?.();
  });
  const bottomSurfaceMode = () => resolveBottomSurfaceMode({
    yoloStage: options.yoloConfirmStage(),
    permissionRequest: options.activePermissionRequest(),
    question: options.pendingUserQuestion(),
    quality: options.pendingQualityDecision?.() ?? null,
    gate: options.activeGateRequest(),
    rewind: options.rewindPicker(),
    branch: options.branchPicker(),
    session: options.sessionPicker(),
    skillPicker: options.skillPicker(),
    qualityPicker: options.qualityPicker(),
    qualityRewriteConfirm: options.qualityRewriteConfirm(),
    model: options.modelPicker(),
  });

  function handleKey(rawKey: TuiKeyEvent): void {
    const key = createRoutingKey(rawKey);
    if (key.ctrl && key.name === "c") {
      consumeKey(key);
      void copySelectionToClipboard(options.renderer).then((copied) => {
        if (copied) {
          options.renderer.clearSelection();
          options.setStatus("selection copied");
          lastCtrlCAt = 0;
          return;
        }
        const now = Date.now();
        if (now - lastCtrlCAt < 3000) {
          quit();
          return;
        }
        lastCtrlCAt = now;
        options.setStatus("press Ctrl+C again to exit");
      });
      return;
    }
    if (key.ctrl && key.name === "q") {
      quit();
      return;
    }
    // The startup splash swallows all other input: the first keypress ends it
    // immediately and must not leak into the composer or any panel.
    if (options.splashActive?.()) {
      options.dismissSplash?.();
      consumeKey(key);
      return;
    }
    if (options.sideQuestionOverlay?.() && options.handleSideQuestionKey) {
      if (options.handleSideQuestionKey(key)) consumeKey(key);
      return;
    }
    const mode = bottomSurfaceMode();
    switch (mode.kind) {
      case "yolo":
        if (options.handleYoloKey(key)) consumeKey(key);
        return;
      case "permission":
      case "gate":
        if (options.handleGateKey(key)) consumeKey(key);
        return;
      case "question":
        if (options.handleQuestionKey(key)) consumeKey(key);
        return;
      case "quality":
        if (options.handleQualityKey?.(key)) consumeKey(key);
        return;
      case "rewind":
        if (options.handleRewindKey(key)) consumeKey(key);
        return;
      case "branch":
        if (options.handleBranchKey(key)) consumeKey(key);
        return;
      case "session":
        if (options.handleSessionPickerKey(key)) consumeKey(key);
        return;
      case "skill-picker":
        if (options.handleSkillPickerKey(key)) consumeKey(key);
        return;
      case "model":
        if (options.handleModelPickerKey(key)) consumeKey(key);
        return;
      case "quality-picker":
        if (options.handleQualityPickerKey(key)) consumeKey(key);
        return;
      case "quality-rewrite-confirm":
        if (options.handleRewriteConfirmKey(key)) consumeKey(key);
        return;
      case "composer":
        break;
    }
    // Page switch (Ctrl+O) sits above artifact focus and composer keys so it
    // works from every non-modal surface; bottom-surface modals above still
    // own their keys while active.
    if (key.ctrl && !key.shift && key.name === "o" && options.togglePage) {
      options.togglePage();
      consumeKey(key);
      return;
    }
    // Candidate tree (Ctrl+B) sits at the same layer: above workspace routing
    // so the Workspace tree's catch-all never swallows it, after the modal
    // switch so an open panel keeps its keys. Plain Ctrl+B is 0x02 in
    // traditional VT terminals on all three platforms. Taking it over
    // supersedes the composer's Emacs backward-char (bare left arrow and
    // Meta+b word movement remain).
    if (key.ctrl && !key.shift && key.name === "b" && options.triggerBranch) {
      options.triggerBranch();
      consumeKey(key);
      return;
    }
    // The Workspace page owns keys next (tree/viewer/quick-open/focus).
    // Tri-state routing: consumed → done; false + composer focus → fall
    // through to shared composer (image paste, text keys); false + other
    // region → native widget (textarea) handles the key, stop here.
    const workspaceActive = options.workspaceActive?.() === true;
    if (workspaceActive && options.handleWorkspaceKey) {
      if (options.handleWorkspaceKey(key)) { consumeKey(key); return; }
      if (options.workspaceFocusRegion?.() !== "composer") return;
    }
    // Regenerate (#88): plain Ctrl+R is representable as the same 0x12 byte in
    // traditional VT terminals on Windows, macOS, and Linux. Keep this after
    // Workspace routing so that page retains its existing Ctrl+R file reload.
    if (!workspaceActive && key.ctrl && !key.shift && key.name === "r" && options.triggerRegenerate) {
      options.triggerRegenerate();
      consumeKey(key);
      return;
    }
    if (options.artifactFocusActive?.()) {
      if (options.handleArtifactFocusKey?.(key)) consumeKey(key);
      return;
    }
    if ((key.meta || key.option) && key.name === "a" && options.enterArtifactFocus?.()) {
      consumeKey(key);
      return;
    }
    if (isClipboardImagePasteKey(key)) {
      consumeKey(key);
      void options.pasteClipboardImage();
      return;
    }
    if (options.handleStageMessageKey?.(key)) {
      consumeKey(key);
      return;
    }
    if (options.handleComposerKey(key)) {
      consumeKey(key);
      return;
    }
    if (isComposerDirectionKey(key)) {
      // ScrollBox handles modified arrows too, but composer intentionally does not.
      // Alt+←/→ here means the candidate switcher is out of reach on this
      // surface (Workspace page or hero): guide instead of swallowing silently.
      const altLike = key.meta === true || key.option === true;
      if (altLike && !key.ctrl && (key.name === "left" || key.name === "right")) {
        options.onRejectedCandidateSwitch?.();
      }
      consumeKey(key);
      return;
    }
    if (key.name === "escape") {
      options.handlePromptEscape();
      consumeKey(key);
    }
  }

  function handlePaste(event: { bytes: Uint8Array; preventDefault: () => void }): void {
    if (options.splashActive?.()) {
      options.dismissSplash?.();
      event.preventDefault();
      return;
    }
    if (options.sideQuestionOverlay?.()) {
      event.preventDefault();
      return;
    }
    const text = new TextDecoder().decode(event.bytes);
    if (options.handleDecisionPaste(text)) {
      event.preventDefault();
      return;
    }
    if (bottomSurfaceMode().kind !== "composer") {
      event.preventDefault();
      return;
    }
    const workspaceOwnership = resolveWorkspacePasteOwnership(options);
    if (workspaceOwnership === "native-editor") {
      // Leave the event unconsumed so OpenTUI delivers it to the focused
      // Workspace textarea's own paste handler.
      return;
    }
    if (workspaceOwnership === "blocked") {
      event.preventDefault();
      return;
    }
    options.insertComposerPaste(text);
    event.preventDefault();
  }

  return { handleKey, handlePaste };
}

export function useInputRouting(options: InputRoutingOptions): void {
  const router = createInputRouter(options);
  useKeyboard(router.handleKey);
  usePaste(router.handlePaste);
}

export function createRoutingKey(rawKey: TuiKeyEvent): TuiKeyEvent {
  return {
    ...rawKey,
    name: normalizeKeyName(rawKey.name),
    preventDefault: rawKey.preventDefault?.bind(rawKey),
    stopPropagation: rawKey.stopPropagation?.bind(rawKey),
  };
}

export function consumeKey(key: TuiKeyEvent): void {
  key.preventDefault?.();
  key.stopPropagation?.();
}

export function isClipboardImagePasteKey(key: TuiKeyEvent): boolean {
  return key.name?.toLowerCase() === "v"
    && key.shift !== true
    && (key.ctrl === true || key.meta === true || key.option === true);
}

function isComposerDirectionKey(key: TuiKeyEvent): boolean {
  return key.name === "up" || key.name === "down" || key.name === "left" || key.name === "right";
}
