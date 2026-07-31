import { createEffect, createSignal, type Accessor, type Setter } from "solid-js";
import type { PendingUserInput } from "../core/agent-loop/types";
import { loadSessionSnapshot } from "../core/session/store";
import type { VesicleImageAttachment, VesicleMessage } from "../providers/shared/types";
import type { ComposerElement } from "./composer";
import { executeQueuedCommands } from "./command-scheduler";
import type { InputQueue } from "./input-queue";
import { displayTranscriptFromSnapshot, vesicleMessagesFromResumed } from "./session-presenter";
import type { ActivityEntry, AgentCardState, Message } from "./types";

type QueuedWorkOptions = {
  rootDir: string;
  inputQueue: InputQueue;
  canDrain: Accessor<boolean>;
  agentCards: Accessor<AgentCardState[]>;
  setConversation: Setter<VesicleMessage[]>;
  setMessages: Setter<Message[]>;
  setStatus: Setter<string>;
  recordActivity: (entry: ActivityEntry) => void;
  recordPromptHistory: (value: string, elements: ComposerElement[], images: VesicleImageAttachment[]) => void;
  submitPrompt: (value: string, images: VesicleImageAttachment[], elements: ComposerElement[]) => Promise<void>;
  executeLocalCommand: (raw: string) => Promise<void>;
  reportError: (error: unknown) => void;
};

/**
 * One-shot interrupt takeover intent, owned by this controller (not a field on
 * `QueuedInput`). `markInterruptRequested()` snapshots the FIFO head id after a
 * successful prompt-level abort; `handleInterruption()` consumes the state and
 * releases the queue only when that exact head still leads after durable
 * projection rebuild.
 */
export type InterruptTakeover =
  | { kind: "none" }
  | { kind: "queued-head"; inputId: number };

export type QueuedWorkController = {
  block: () => void;
  release: () => void;
  prepareTurn: () => void;
  markInterruptRequested: () => void;
  handleInterruption: (sessionId: string | undefined) => Promise<boolean>;
  drainIfReady: () => boolean;
  takePendingUserInputs: () => PendingUserInput[];
  runToolBoundaryCommands: () => Promise<void>;
};

export function createQueuedWorkController(options: QueuedWorkOptions): QueuedWorkController {
  const [ready, setReady] = createSignal(false);
  const [takeover, setTakeover] = createSignal<InterruptTakeover>({ kind: "none" });

  function block(): void {
    setReady(false);
  }

  function release(): void {
    setReady(true);
  }

  function prepareTurn(): void {
    block();
    setTakeover({ kind: "none" });
  }

  function markInterruptRequested(): void {
    const head = options.inputQueue.peekNext();
    setTakeover(head ? { kind: "queued-head", inputId: head.id } : { kind: "none" });
  }

  async function handleInterruption(sessionId: string | undefined): Promise<boolean> {
    const captured = takeover();
    setTakeover({ kind: "none" });
    if (captured.kind === "none") return false;
    if (!sessionId) return false;
    try {
      const snapshot = await loadSessionSnapshot(options.rootDir, sessionId, { synthesizeDanglingToolResults: true });
      options.setConversation(vesicleMessagesFromResumed(snapshot.messages));
      options.setMessages(displayTranscriptFromSnapshot(snapshot.messages, options.agentCards()));
    } catch (error) {
      options.reportError(error);
      return false;
    }
    const head = options.inputQueue.peekNext();
    if (!head || head.id !== captured.inputId) return false;
    setReady(true);
    return true;
  }

  function takePendingUserInputs(): PendingUserInput[] {
    const queued = options.inputQueue.takeMessages();
    if (queued.length === 0) return [];
    for (const message of queued) {
      options.recordPromptHistory(message.value, message.elements, message.images);
    }
    options.setMessages((previous) => [
      ...previous,
      ...queued.map((message) => ({
        role: "user" as const,
        content: message.value.trim(),
        ...(message.images.length ? { images: message.images } : {}),
      })),
    ]);
    options.setStatus(`sending ${queued.length} queued message${queued.length === 1 ? "" : "s"}`);
    options.recordActivity({ kind: "provider", text: `injecting ${queued.length} queued user message${queued.length === 1 ? "" : "s"}` });
    return queued.map((message) => ({
      content: message.value,
      ...(message.images.length ? { images: message.images } : {}),
    }));
  }

  async function runToolBoundaryCommands(): Promise<void> {
    await executeQueuedCommands(options.inputQueue.takeToolBoundaryCommands(), {
      beforeExecute: (command) => options.setStatus(`running queued command /${command.commandName}`),
      execute: options.executeLocalCommand,
      restoreNext: options.inputQueue.restoreNext,
      reportError: options.reportError,
    });
  }

  function drainIfReady(): boolean {
    if (!ready() || !options.canDrain() || options.inputQueue.items().length === 0) return false;
    const next = options.inputQueue.takeNext();
    if (!next) return false;
    block();
    if (next.kind === "message") {
      void options.submitPrompt(next.value, next.images, next.elements).catch((error) => {
        options.inputQueue.restoreNext(next);
        options.reportError(error);
      });
      return true;
    }
    void options.executeLocalCommand(next.raw).then(
      release,
      (error) => {
        options.reportError(error);
        release();
      },
    );
    return true;
  }

  createEffect(() => {
    drainIfReady();
  });

  return {
    block,
    release,
    prepareTurn,
    markInterruptRequested,
    handleInterruption,
    drainIfReady,
    takePendingUserInputs,
    runToolBoundaryCommands,
  };
}
