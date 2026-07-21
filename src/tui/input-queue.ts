import { createSignal, type Accessor } from "solid-js";
import type { VesicleImageAttachment } from "../providers/shared/types";
import type { CommandQueueBoundary } from "./commands/types";
import type { ComposerElement, ComposerState } from "./composer";

export type QueuedUserMessage = {
  id: number;
  kind: "message";
  value: string;
  elements: ComposerElement[];
  images: VesicleImageAttachment[];
};

export type QueuedCommand = {
  id: number;
  kind: "command";
  raw: string;
  commandName: string;
  args: string;
  boundary: CommandQueueBoundary;
};

export type QueuedInput = QueuedUserMessage | QueuedCommand;

export type InputQueue = {
  clear: () => void;
  enqueueCommand: (command: Omit<QueuedCommand, "id" | "kind">) => number;
  enqueueMessage: (message: Omit<QueuedUserMessage, "id" | "kind">) => number;
  items: Accessor<QueuedInput[]>;
  restoreNext: (item: QueuedInput) => void;
  takeLast: () => QueuedInput | undefined;
  takeMessages: () => QueuedUserMessage[];
  takeNext: () => QueuedInput | undefined;
  takeToolBoundaryCommands: () => QueuedCommand[];
};

export function createInputQueue(): InputQueue {
  const [items, setItems] = createSignal<QueuedInput[]>([]);
  let nextId = 1;

  function enqueueMessage(message: Omit<QueuedUserMessage, "id" | "kind">): number {
    setItems((current) => [...current, cloneItem({ ...message, id: nextId++, kind: "message" })]);
    return items().length;
  }

  function enqueueCommand(command: Omit<QueuedCommand, "id" | "kind">): number {
    setItems((current) => [...current, cloneItem({ ...command, id: nextId++, kind: "command" })]);
    return items().length;
  }

  function takeNext(): QueuedInput | undefined {
    const next = items()[0];
    if (!next) return undefined;
    setItems((current) => current.slice(1));
    return cloneItem(next);
  }

  function takeLast(): QueuedInput | undefined {
    const next = items().at(-1);
    if (!next) return undefined;
    setItems((current) => current.slice(0, -1));
    return cloneItem(next);
  }

  function takeMessages(): QueuedUserMessage[] {
    const messages = items().filter((item): item is QueuedUserMessage => item.kind === "message");
    if (messages.length === 0) return [];
    const messageIds = new Set(messages.map((message) => message.id));
    setItems((current) => current.filter((item) => !messageIds.has(item.id)));
    return messages.map(cloneMessage);
  }

  function takeToolBoundaryCommands(): QueuedCommand[] {
    const commands: QueuedCommand[] = [];
    for (const item of items()) {
      if (item.kind !== "command") continue;
      if (item.boundary !== "tool-round") break;
      commands.push(item);
    }
    if (commands.length === 0) return [];
    const commandIds = new Set(commands.map((command) => command.id));
    setItems((current) => current.filter((item) => !commandIds.has(item.id)));
    return commands.map(cloneCommand);
  }

  function restoreNext(item: QueuedInput): void {
    setItems((current) => [cloneItem(item), ...current]);
  }

  function clear(): void {
    setItems([]);
  }

  return { clear, enqueueCommand, enqueueMessage, items, restoreNext, takeLast, takeMessages, takeNext, takeToolBoundaryCommands };
}

export function composerStateFromQueuedInput(item: QueuedInput): ComposerState {
  if (item.kind === "command") return { value: item.raw, cursor: item.raw.length, elements: [] };
  return {
    value: item.value,
    cursor: item.value.length,
    elements: item.elements.map((element) => ({ ...element })),
  };
}

export function queuedInputText(item: QueuedInput): string {
  return item.kind === "command" ? item.raw : item.value;
}

function cloneItem(item: QueuedInput): QueuedInput {
  return item.kind === "command" ? cloneCommand(item) : cloneMessage(item);
}

function cloneMessage(message: QueuedUserMessage): QueuedUserMessage {
  return {
    ...message,
    elements: message.elements.map((element) => ({ ...element })),
    images: message.images.map((image) => ({ ...image })),
  };
}

function cloneCommand(command: QueuedCommand): QueuedCommand {
  return { ...command };
}
