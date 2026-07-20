import { createEffect, createMemo, createSignal, type Accessor, type Setter } from "solid-js";
import type { ModelCapabilities } from "../config/env";
import type { ProviderRegistry, ProviderSelection } from "../config/providers";
import type { ArtifactEntry } from "../core/artifacts/workbench";
import type { SessionSummary } from "../core/session/store";
import { ingestImageBytes } from "../core/attachments/store";
import type { VesicleImageAttachment } from "../providers/shared/types";
import { readImageFromClipboard } from "./clipboard";
import {
  applyComposerKey,
  insertComposerImage,
  insertComposerText,
  setComposerValue,
  type ComposerElement,
  type ComposerState,
} from "./composer";
import type { PromptHistoryEntry } from "./composer-history";
import { composerVisualLineCount } from "./composer-layout";
import type { ActivityEntry, AgentCardState, Message, OptionItem } from "./types";
import type { TuiKeyEvent } from "./decision-interaction";
import { PromptEscapeController } from "./prompt-escape";
import { createModelPickerController } from "./model-picker-controller";
import { createCommandCompletionController } from "./command-completion-controller";

export type ComposerControllerOptions = {
  rootDir: string;
  terminalWidth: Accessor<number>;
  providerRegistry: Accessor<ProviderRegistry | null>;
  activeProvider: Accessor<string>;
  ensureProviderRegistry: () => Promise<ProviderRegistry>;
  applyProviderSelection: (selection: Partial<ProviderSelection>) => Promise<ProviderSelection>;
  persistProviderSwitch: (selection: ProviderSelection) => Promise<void>;
  agentCards: Accessor<AgentCardState[]>;
  sessionId: Accessor<string | undefined>;
  refreshArtifacts: () => Promise<ArtifactEntry[]>;
  listSessions: () => Promise<SessionSummary[]>;
  busy: Accessor<boolean>;
  activeModelCapabilities: Accessor<ModelCapabilities | undefined>;
  status: Accessor<string>;
  setStatus: Setter<string>;
  setMessages: Setter<Message[]>;
  recordActivity: (entry: ActivityEntry) => void;
  reportError: (error: unknown) => void;
  submitPrompt: (value: string, images?: VesicleImageAttachment[], elements?: ComposerElement[]) => Promise<void>;
  abortTurn: () => boolean;
  openRewind: () => Promise<void>;
};

export function createComposerController(options: ComposerControllerOptions) {
  const [inputValue, setInputValue] = createSignal("");
  const [inputCursor, setInputCursor] = createSignal(0);
  const [inputKillBuffer, setInputKillBuffer] = createSignal<string | undefined>();
  const [inputElements, setInputElements] = createSignal<ComposerElement[]>([]);
  const [inputImages, setInputImages] = createSignal<VesicleImageAttachment[]>([]);
  const [promptHistory, setPromptHistory] = createSignal<PromptHistoryEntry[]>([]);
  const [historyIndex, setHistoryIndex] = createSignal<number | null>(null);
  const promptEscape = new PromptEscapeController();
  const modelPickerController = createModelPickerController(options);
  const commandCompletionController = createCommandCompletionController({
    rootDir: options.rootDir,
    inputValue,
    applyComposerState: applyState,
    clearComposer: clear,
    setInputImages,
    setHistoryIndex,
    providerRegistry: options.providerRegistry,
    activeProvider: options.activeProvider,
    refreshArtifacts: options.refreshArtifacts,
    listSessions: options.listSessions,
    agentCards: options.agentCards,
    sessionId: options.sessionId,
    busy: options.busy,
    setStatus: options.setStatus,
    submitPrompt: (value) => options.submitPrompt(value),
  });

  const {
    commandArgumentDraft,
    commandArgumentItems,
    commandArgumentMenuOpen,
    commandArgumentSelected,
    commandMenuItems,
    commandMenuOpen,
    commandMenuSelected,
    handleKey: handleCommandCompletionKey,
  } = commandCompletionController;
  const composerInputWidth = createMemo(() => Math.max(8, options.terminalWidth() - 4));
  const inputVisualLines = createMemo(() => composerVisualLineCount(inputValue(), composerInputWidth()));
  const composerPopupOpen = createMemo(() => commandMenuOpen() || commandArgumentMenuOpen());
  const inputNeedsExpandedBottom = createMemo(() => composerPopupOpen() || inputVisualLines() > 1);

  function currentState(): ComposerState {
    return {
      value: inputValue(),
      cursor: inputCursor(),
      killBuffer: inputKillBuffer(),
      elements: inputElements(),
    };
  }

  function applyState(state: ComposerState): void {
    setInputValue(state.value);
    setInputCursor(state.cursor);
    setInputKillBuffer(state.killBuffer);
    setInputElements(state.elements ?? []);
  }

  function clear(): void {
    applyState(setComposerValue(""));
    setInputImages([]);
  }

  function handleKey(key: TuiKeyEvent): boolean {
    if (handleCommandCompletionKey(key)) return true;
    const result = applyComposerKey(currentState(), key, { columns: composerInputWidth() });
    if (!result.handled) return false;
    applyState(result.state);
    if (result.action?.type === "submit") submitComposerAction(result.action.value, result.action.elements ?? []);
    else if (result.action?.type === "history_up") {
      if (!options.busy()) recallHistory(-1);
    } else if (result.action?.type === "history_down") {
      if (historyIndex() !== null && !options.busy()) recallHistory(1);
    } else {
      setHistoryIndex(null);
    }
    return true;
  }

  function submitComposerAction(value: string, elements: ComposerElement[]): void {
    if (options.busy()) {
      options.setStatus("request in flight; draft kept");
      return;
    }
    if (value.trim().length === 0) return;
    const images = imagesForElements(elements);
    if (images.length > 0 && options.activeModelCapabilities()?.vision !== true) {
      options.setStatus("current model does not declare vision support; draft kept");
      return;
    }
    clear();
    void options.submitPrompt(value, images, elements);
  }

  function recallHistory(direction: -1 | 1): void {
    const history = promptHistory();
    if (history.length === 0) return;
    const current = historyIndex();
    const next = current === null ? history.length - 1 : Math.max(0, Math.min(history.length - 1, current + direction));
    setHistoryIndex(next);
    const entry = history[next];
    if (!entry) return;
    applyState({ value: entry.value, cursor: entry.value.length, elements: entry.elements.map((element) => ({ ...element })) });
    setInputImages(entry.images.map((image) => ({ ...image })));
  }

  function imagesForElements(elements: ComposerElement[]): VesicleImageAttachment[] {
    const byId = new Map(inputImages().map((image) => [image.id, image]));
    return elements.flatMap((element) => {
      const image = byId.get(element.attachmentId);
      return image ? [{ ...image }] : [];
    });
  }

  function recordHistory(value: string, elements: ComposerElement[], images: VesicleImageAttachment[]): void {
    const entry: PromptHistoryEntry = {
      value,
      elements: elements.map((element) => ({ ...element })),
      images: images.map((image) => ({ ...image })),
    };
    setPromptHistory((previous) => [...previous.filter((candidate) => candidate.value !== value), entry].slice(-50));
  }

  function handleEscape(): void {
    const draft = inputValue();
    switch (promptEscape.press({ busy: options.busy(), draft, hasSession: Boolean(options.sessionId()) })) {
      case "interrupt":
        if (options.abortTurn()) options.setStatus("interrupting request");
        return;
      case "clear":
        if (draft.trim() || inputImages().length > 0) recordHistory(draft, inputElements(), inputImages());
        clear();
        options.setStatus("input cleared");
        return;
      case "arm-clear":
        options.setStatus("Esc again to clear");
        setTimeout(() => {
          if (options.status() === "Esc again to clear") options.setStatus("ready");
        }, 1000);
        return;
      case "rewind":
        void options.openRewind();
        return;
      case "arm-rewind":
      case "noop":
        return;
    }
  }

  async function pasteClipboardImage(): Promise<void> {
    options.setStatus("reading clipboard image");
    try {
      const bytes = await readImageFromClipboard();
      if (!bytes) throw new Error("No supported image was found in the clipboard.");
      const image = await ingestImageBytes(options.rootDir, bytes, { source: "clipboard", filename: "clipboard.png" });
      const number = inputElements().filter((element) => element.type === "image").length + 1;
      const withImage = insertComposerImage(currentState(), image.id, `[Image #${number}]`);
      applyState(insertComposerText(withImage, " "));
      setInputImages((current) => [...current, image]);
      setHistoryIndex(null);
      options.setStatus(options.activeModelCapabilities()?.vision === true
        ? `attached Image #${number}`
        : `attached Image #${number}; current model does not declare vision support`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      options.setStatus(`image paste failed: ${message}`);
      options.recordActivity({ kind: "system", text: `image paste failed: ${message}` });
    }
  }

  function insertPastedText(text: string): void {
    applyState(insertComposerText(currentState(), text));
  }

  return {
    ...modelPickerController,
    commandArgumentDraft,
    applyState,
    clear,
    commandArgumentItems,
    commandArgumentMenuOpen,
    commandArgumentSelected,
    commandMenuItems,
    commandMenuOpen,
    commandMenuSelected,
    composerInputWidth,
    composerPopupOpen,
    handleEscape,
    handleKey,
    historyIndex,
    inputCursor,
    inputElements,
    inputImages,
    inputNeedsExpandedBottom,
    inputValue,
    insertPastedText,
    pasteClipboardImage,
    promptHistory,
    recordHistory,
    setHistoryIndex,
    setInputImages,
    setPromptHistory,
  };
}
