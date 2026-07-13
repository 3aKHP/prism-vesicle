import { createEffect, createMemo, createSignal, type Accessor, type Setter } from "solid-js";
import type { ProviderRegistry } from "../config/providers";
import type { VesicleImageAttachment } from "../providers/shared/types";
import { builtinCommands } from "./commands/builtin";
import {
  completeAgentArgument,
  completeFixedArgument,
  completeModelArgument,
  fixedArgumentOptions,
  matchOptionItems,
  parseAgentArgumentDraft,
  parseFixedArgumentDraft,
  parseModelArgumentDraft,
} from "./commands/argument-completion";
import { matchCommands } from "./commands/match";
import { modelOptionItems, providerOptionItems } from "./commands/options";
import { clampCommandMenuSelection, moveCommandMenuSelection } from "./commands/selection";
import { normalizeKeyName, setComposerValue, type ComposerState } from "./composer";
import type { TuiKeyEvent } from "./decision-interaction";
import type { AgentCardState, OptionItem } from "./types";

export type CommandCompletionControllerOptions = {
  inputValue: Accessor<string>;
  applyComposerState: (state: ComposerState) => void;
  clearComposer: () => void;
  setInputImages: Setter<VesicleImageAttachment[]>;
  setHistoryIndex: Setter<number | null>;
  providerRegistry: Accessor<ProviderRegistry | null>;
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

  const modelArgumentDraft = createMemo(() => parseModelArgumentDraft(options.inputValue()));
  const fixedArgumentDraft = createMemo(() => parseFixedArgumentDraft(options.inputValue()));
  const agentArgumentDraft = createMemo(() => parseAgentArgumentDraft(options.inputValue()));
  const commandArgumentMenuOpen = createMemo(() => Boolean(modelArgumentDraft() || fixedArgumentDraft() || agentArgumentDraft()));
  const commandArgumentItems = createMemo<OptionItem[]>(() => {
    const modelDraft = modelArgumentDraft();
    if (modelDraft) {
      const registry = options.providerRegistry();
      if (!registry) return [];
      const candidates = modelDraft.stage === "provider"
        ? providerOptionItems(registry)
        : modelOptionItems(registry, modelDraft.providerId);
      return matchOptionItems(modelDraft.query, candidates);
    }
    const fixedDraft = fixedArgumentDraft();
    if (fixedDraft) return matchOptionItems(fixedDraft.query, fixedArgumentOptions(fixedDraft.command));
    const agentDraft = agentArgumentDraft();
    if (!agentDraft) return [];
    const handles = agentOptionItems();
    const candidates = agentDraft.stage === "command"
      ? [
          { id: "stop", label: "stop", detail: "Interrupt a running SubAgent" },
          { id: "retry", label: "retry", detail: "Retry paused background-result delivery" },
          ...handles,
        ]
      : handles.filter((item) => {
          const agent = options.agentCards().find((candidate) => candidate.handle === item.id);
          return agent?.status === "queued" || agent?.status === "running";
        });
    return matchOptionItems(agentDraft.query, candidates);
  });
  const [commandArgumentSelected, setCommandArgumentSelected] = createSignal(0);
  createEffect(() => {
    setCommandArgumentSelected((selected) => clampCommandMenuSelection(selected, commandArgumentItems().length));
  });
  let previousCommandArgumentKey: string | null = null;
  createEffect(() => {
    const modelDraft = modelArgumentDraft();
    const fixedDraft = fixedArgumentDraft();
    const agentDraft = agentArgumentDraft();
    const key = modelDraft
      ? `model:${modelDraft.stage}:${modelDraft.stage === "model" ? `${modelDraft.providerId}:` : ""}${modelDraft.query}`
      : fixedDraft
        ? `fixed:${fixedDraft.command}:${fixedDraft.query}`
        : agentDraft
          ? `agent:${agentDraft.stage}:${agentDraft.query}`
          : null;
    if (key !== previousCommandArgumentKey) setCommandArgumentSelected(0);
    previousCommandArgumentKey = key;
  });

  function agentOptionItems(): OptionItem[] {
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
    const modelDraft = modelArgumentDraft();
    if (modelDraft) return completeModelArgument(modelDraft, item);
    const fixedDraft = fixedArgumentDraft();
    if (fixedDraft) return completeFixedArgument(fixedDraft, item);
    const agentDraft = agentArgumentDraft();
    return agentDraft ? completeAgentArgument(agentDraft, item) : null;
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
    agentArgumentDraft,
    commandArgumentItems,
    commandArgumentMenuOpen,
    commandArgumentSelected,
    commandMenuItems,
    commandMenuOpen,
    commandMenuSelected,
    fixedArgumentDraft,
    handleKey,
    modelArgumentDraft,
  };
}
