import { createEffect, createMemo, createSignal, untrack, type Accessor, type Setter } from "solid-js";
import type { ProviderRegistry } from "../config/providers";
import type { ArtifactEntry } from "../core/artifacts/workbench";
import type { SessionSummary } from "../core/session/store";
import type { VesicleImageAttachment } from "../providers/shared/types";
import { builtinCommands } from "./commands/builtin";
import { matchOptionItems, resolveCommandArgumentCompletion } from "./commands/argument-completion";
import { matchCommands } from "./commands/match";
import type { CommandArgumentCompletion } from "./commands/types";
import { clampCommandMenuSelection, moveCommandMenuSelection } from "./commands/selection";
import { normalizeKeyName, setComposerValue, type ComposerState } from "./composer";
import type { TuiKeyEvent } from "./decision-interaction";
import type { AgentCardState, OptionItem } from "./types";

export type CommandCompletionControllerOptions = {
  rootDir: string;
  inputValue: Accessor<string>;
  applyComposerState: (state: ComposerState) => void;
  clearComposer: () => void;
  setInputImages: Setter<VesicleImageAttachment[]>;
  setHistoryIndex: Setter<number | null>;
  providerRegistry: Accessor<ProviderRegistry | null>;
  activeProvider: Accessor<string>;
  refreshArtifacts: () => Promise<ArtifactEntry[]>;
  listSessions: () => Promise<SessionSummary[]>;
  agentCards: Accessor<AgentCardState[]>;
  sessionId: Accessor<string | undefined>;
  busy: Accessor<boolean>;
  setStatus: Setter<string>;
  submitPrompt: (value: string) => Promise<void>;
};

export function createCommandCompletionController(options: CommandCompletionControllerOptions) {
  const commandMenuOpen = createMemo(() => options.inputValue().startsWith("/") && !options.inputValue().slice(1).includes(" "));
  const commandMenuQuery = createMemo(() => options.inputValue().slice(1));
  const commandMenuItems = createMemo(() => matchCommands(commandMenuQuery(), builtinCommands));
  const [commandMenuSelected, setCommandMenuSelected] = createSignal(0);
  createEffect(() => {
    setCommandMenuSelected((selected) => clampCommandMenuSelection(selected, commandMenuItems().length));
  });
  let previousCommandMenuQuery: string | null = null;
  createEffect(() => {
    const query = commandMenuOpen() ? commandMenuQuery() : null;
    if (query !== previousCommandMenuQuery) setCommandMenuSelected(0);
    previousCommandMenuQuery = query;
  });

  const commandArgumentDraft = createMemo(() => resolveCommandArgumentCompletion(options.inputValue(), builtinCommands, {
    rootDir: options.rootDir,
    providerRegistry: options.providerRegistry,
    activeProvider: options.activeProvider,
    refreshArtifacts: options.refreshArtifacts,
    listSessions: options.listSessions,
    agentOptions,
  }));
  const commandArgumentSourceKey = createMemo(() => commandArgumentDraft()?.sourceKey ?? null);
  const [loadedItems, setLoadedItems] = createSignal<OptionItem[]>([]);
  const [loadedSourceKey, setLoadedSourceKey] = createSignal<string | null>(null);
  const dynamicLoads = new Map<string, Promise<OptionItem[]>>();

  // Dynamic sources refresh once per grammar stage. Query edits reuse their
  // candidates, and a cleanup guard prevents an old scan from replacing a new
  // stage after the draft changes or the user presses Escape.
  createEffect(() => {
    const sourceKey = commandArgumentSourceKey();
    const draft = untrack(commandArgumentDraft);
    if (!sourceKey || !draft || Array.isArray(draft.items)) {
      setLoadedSourceKey(null);
      setLoadedItems([]);
      return;
    }
    let current = true;
    setLoadedSourceKey(null);
    setLoadedItems([]);
    const loadKey = sourceKey.startsWith("stage:") ? "stage:cards" : sourceKey;
    let load = dynamicLoads.get(loadKey);
    if (!load) {
      load = draft.items();
      dynamicLoads.set(loadKey, load);
      void load.catch(() => { dynamicLoads.delete(loadKey); });
    }
    void load.then((items) => {
      if (!current) return;
      setLoadedItems(items);
      setLoadedSourceKey(sourceKey);
    }).catch(() => {
      if (!current) return;
      setLoadedItems([]);
      setLoadedSourceKey(sourceKey);
    });
    return () => { current = false; };
  });

  const commandArgumentItems = createMemo<OptionItem[]>(() => {
    const draft = commandArgumentDraft();
    if (!draft) return [];
    const items = Array.isArray(draft.items)
      ? draft.items
      : loadedSourceKey() === draft.sourceKey ? loadedItems() : [];
    return matchOptionItems(draft.query, items);
  });
  const commandArgumentMenuOpen = createMemo(() => Boolean(commandArgumentDraft()));
  const [commandArgumentSelected, setCommandArgumentSelected] = createSignal(0);
  createEffect(() => {
    setCommandArgumentSelected((selected) => clampCommandMenuSelection(selected, commandArgumentItems().length));
  });
  let previousCommandArgumentKey: string | null = null;
  createEffect(() => {
    const key = commandArgumentDraft()?.selectionKey ?? null;
    if (key !== previousCommandArgumentKey) setCommandArgumentSelected(0);
    previousCommandArgumentKey = key;
  });

  function agentOptions(): OptionItem[] {
    return options.agentCards()
      .filter((agent) => agent.parentSessionId === options.sessionId())
      .map((agent) => ({ id: agent.handle, label: agent.handle, detail: `${agent.status} · ${agent.description}` }));
  }

  function handleKey(key: TuiKeyEvent): boolean {
    if (commandMenuOpen()) return handleCommandMenuKey(key);
    if (commandArgumentMenuOpen()) return handleCommandArgumentMenuKey(key);
    return false;
  }

  function handleCommandMenuKey(key: TuiKeyEvent): boolean {
    const name = normalizeKeyName(key.name);
    if (name === "up" || (key.ctrl && name === "p")) {
      setCommandMenuSelected((selected) => moveCommandMenuSelection(selected, -1, commandMenuItems().length));
      return true;
    }
    if (name === "down" || (key.ctrl && name === "n")) {
      setCommandMenuSelected((selected) => moveCommandMenuSelection(selected, 1, commandMenuItems().length));
      return true;
    }
    if (name === "tab") {
      const command = commandMenuItems()[commandMenuSelected()];
      if (command) completeCommandName(command.name);
      return true;
    }
    if (name === "return" || name === "enter") {
      const command = commandMenuItems()[commandMenuSelected()];
      if (!command) return true;
      if (options.inputValue() === `/${command.name}`) submitCompletedCommandArgument(`/${command.name}`);
      else completeCommandName(command.name);
      return true;
    }
    if (name === "escape") {
      options.clearComposer();
      return true;
    }
    return false;
  }

  function completeCommandName(name: string): void {
    options.applyComposerState(setComposerValue(`/${name} `));
    options.setInputImages([]);
    setCommandMenuSelected(0);
    options.setHistoryIndex(null);
  }

  function handleCommandArgumentMenuKey(key: TuiKeyEvent): boolean {
    const name = normalizeKeyName(key.name);
    const items = commandArgumentItems();
    if (name === "up" || (key.ctrl && name === "p")) {
      setCommandArgumentSelected((selected) => moveCommandMenuSelection(selected, -1, items.length));
      return true;
    }
    if (name === "down" || (key.ctrl && name === "n")) {
      setCommandArgumentSelected((selected) => moveCommandMenuSelection(selected, 1, items.length));
      return true;
    }
    if (name === "tab") {
      completeSelectedCommandArgument();
      return true;
    }
    if (name === "enter" || name === "return") {
      const item = items[commandArgumentSelected()];
      const completed = item ? selectedCommandArgumentValue(item) : null;
      if (!completed) return false;
      const executable = completed.trimEnd();
      if (options.inputValue() === executable) submitCompletedCommandArgument(executable);
      else applyCompletedCommandArgument(completed);
      return true;
    }
    if (name === "escape") {
      options.clearComposer();
      return true;
    }
    return false;
  }

  function completeSelectedCommandArgument(): void {
    const item = commandArgumentItems()[commandArgumentSelected()];
    const completed = item ? selectedCommandArgumentValue(item) : null;
    if (completed) applyCompletedCommandArgument(completed);
  }

  function selectedCommandArgumentValue(item: OptionItem): string | null {
    return commandArgumentDraft()?.complete(item) ?? null;
  }

  function submitCompletedCommandArgument(value: string): void {
    if (options.busy()) {
      options.setStatus("request in flight; draft kept");
      return;
    }
    options.clearComposer();
    void options.submitPrompt(value);
  }

  function applyCompletedCommandArgument(value: string): void {
    options.applyComposerState(setComposerValue(value));
    options.setInputImages([]);
    setCommandArgumentSelected(0);
    options.setHistoryIndex(null);
  }

  return {
    commandArgumentDraft,
    commandArgumentItems,
    commandArgumentMenuOpen,
    commandArgumentSelected,
    commandMenuItems,
    commandMenuOpen,
    commandMenuSelected,
    handleKey,
  };
}
