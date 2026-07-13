import { useKeyboard, usePaste, useRenderer } from "@opentui/solid";
import type { Accessor, Setter } from "solid-js";
import { copySelectionToClipboard } from "./clipboard";
import { normalizeKeyName } from "./composer";
import type { PendingEngineSwitchState, PendingGateState, PendingPermissionState, PendingUserQuestionState, TuiKeyEvent } from "./decision-interaction";
import type { ModelPickerState } from "./views/BottomSurface";
import type { RewindPickerState, SessionPickerState } from "./types";

export type InputRoutingOptions = {
  renderer: ReturnType<typeof useRenderer>;
  setStatus: Setter<string>;
  rewindPicker: Accessor<RewindPickerState | null>;
  handleRewindKey: (key: TuiKeyEvent) => boolean;
  modelPicker: Accessor<ModelPickerState | null>;
  handleModelPickerKey: (key: TuiKeyEvent) => boolean;
  sessionPicker: Accessor<SessionPickerState | null>;
  handleSessionPickerKey: (key: TuiKeyEvent) => boolean;
  yoloConfirmStage: Accessor<1 | 2 | null>;
  handleYoloKey: (key: TuiKeyEvent) => boolean;
  pendingUserQuestion: Accessor<PendingUserQuestionState | null>;
  handleQuestionKey: (key: TuiKeyEvent) => boolean;
  pendingGate: Accessor<PendingGateState | null>;
  pendingEngineSwitch: Accessor<PendingEngineSwitchState | null>;
  pendingPermission: Accessor<PendingPermissionState | null>;
  pendingChildPermission: Accessor<unknown | null>;
  handleGateKey: (key: TuiKeyEvent) => boolean;
  pasteClipboardImage: () => Promise<void>;
  handleComposerKey: (key: TuiKeyEvent) => boolean;
  handlePromptEscape: () => void;
  handleDecisionPaste: (text: string) => boolean;
  insertComposerPaste: (text: string) => void;
};

export function registerInputRouting(options: InputRoutingOptions): void {
  let lastCtrlCAt = 0;

  useKeyboard((rawKey) => {
    const key = { ...rawKey, name: normalizeKeyName(rawKey.name) };
    if (key.ctrl && key.name === "c") {
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
    if (options.rewindPicker()) {
      if (options.handleRewindKey(key)) consumeKey(key);
      return;
    }
    if (options.modelPicker()) {
      if (options.handleModelPickerKey(key)) consumeKey(key);
      return;
    }
    if (options.sessionPicker()) {
      if (options.handleSessionPickerKey(key)) consumeKey(key);
      return;
    }
    if (options.yoloConfirmStage()) {
      if (options.handleYoloKey(key)) consumeKey(key);
      return;
    }
    if (options.pendingUserQuestion()) {
      if (options.handleQuestionKey(key)) consumeKey(key);
      return;
    }
    if (options.pendingGate() || options.pendingEngineSwitch() || options.pendingPermission() || options.pendingChildPermission()) {
      if (options.handleGateKey(key)) consumeKey(key);
      return;
    }
    if (key.name?.toLowerCase() === "v" && (key.meta || key.option)) {
      consumeKey(key);
      void options.pasteClipboardImage();
      return;
    }
    if (options.handleComposerKey(key)) {
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
    if (options.pendingGate() || options.pendingEngineSwitch() || options.pendingUserQuestion() || options.pendingPermission() || options.pendingChildPermission() || options.yoloConfirmStage() || options.sessionPicker() || options.rewindPicker()) return;
    options.insertComposerPaste(text);
    event.preventDefault();
  });
}

function consumeKey(key: TuiKeyEvent): void {
  key.preventDefault?.();
  key.stopPropagation?.();
}
