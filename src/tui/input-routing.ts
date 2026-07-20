import { useKeyboard, usePaste, useRenderer } from "@opentui/solid";
import type { Accessor, Setter } from "solid-js";
import type { GateRequest } from "../core/gate/types";
import type { PermissionRequest } from "../core/permissions";
import { copySelectionToClipboard } from "./clipboard";
import { normalizeKeyName } from "./composer";
import type { PendingQualityDecisionState, PendingUserQuestionState, TuiKeyEvent } from "./decision-interaction";
import { resolveBottomSurfaceMode, type ModelPickerState, type QualityPickerState } from "./views/BottomSurface";
import type { RewindPickerState, SessionPickerState } from "./types";

export type InputRoutingOptions = {
  renderer: ReturnType<typeof useRenderer>;
  setStatus: Setter<string>;
  rewindPicker: Accessor<RewindPickerState | null>;
  handleRewindKey: (key: TuiKeyEvent) => boolean;
  modelPicker: Accessor<ModelPickerState | null>;
  handleModelPickerKey: (key: TuiKeyEvent) => boolean;
  qualityPicker: Accessor<QualityPickerState | null>;
  handleQualityPickerKey: (key: TuiKeyEvent) => boolean;
  sessionPicker: Accessor<SessionPickerState | null>;
  handleSessionPickerKey: (key: TuiKeyEvent) => boolean;
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
  artifactFocusActive?: Accessor<boolean>;
  enterArtifactFocus?: () => boolean;
  handleArtifactFocusKey?: (key: TuiKeyEvent) => boolean;
};

export function useInputRouting(options: InputRoutingOptions): void {
  let lastCtrlCAt = 0;
  const bottomSurfaceMode = () => resolveBottomSurfaceMode({
    yoloStage: options.yoloConfirmStage(),
    permissionRequest: options.activePermissionRequest(),
    question: options.pendingUserQuestion(),
    quality: options.pendingQualityDecision?.() ?? null,
    gate: options.activeGateRequest(),
    rewind: options.rewindPicker(),
    session: options.sessionPicker(),
    qualityPicker: options.qualityPicker(),
    model: options.modelPicker(),
  });

  useKeyboard((rawKey) => {
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
          process.nextTick(() => options.renderer.destroy());
          return;
        }
        lastCtrlCAt = now;
        options.setStatus("press Ctrl+C again to exit");
      });
      return;
    }
    if (key.ctrl && key.name === "q") {
      process.nextTick(() => options.renderer.destroy());
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
      case "session":
        if (options.handleSessionPickerKey(key)) consumeKey(key);
        return;
      case "model":
        if (options.handleModelPickerKey(key)) consumeKey(key);
        return;
      case "quality-picker":
        if (options.handleQualityPickerKey(key)) consumeKey(key);
        return;
      case "composer":
        break;
    }
    if (options.artifactFocusActive?.()) {
      if (options.handleArtifactFocusKey?.(key)) consumeKey(key);
      return;
    }
    if ((key.meta || key.option) && key.name === "a" && options.enterArtifactFocus?.()) {
      consumeKey(key);
      return;
    }
    if (key.name?.toLowerCase() === "v" && (key.meta || key.option)) {
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
      consumeKey(key);
      return;
    }
    if (key.name === "escape") {
      options.handlePromptEscape();
      consumeKey(key);
    }
  });

  usePaste((event) => {
    const text = new TextDecoder().decode(event.bytes);
    if (options.handleDecisionPaste(text)) {
      event.preventDefault();
      return;
    }
    if (bottomSurfaceMode().kind !== "composer") {
      event.preventDefault();
      return;
    }
    options.insertComposerPaste(text);
    event.preventDefault();
  });
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

function isComposerDirectionKey(key: TuiKeyEvent): boolean {
  return key.name === "up" || key.name === "down" || key.name === "left" || key.name === "right";
}
