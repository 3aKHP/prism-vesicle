import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, mock, test } from "bun:test";
import { createRoot, createSignal } from "solid-js";

// PNG magic header is enough for ingestImageBytes' media-type detection.
const pngBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);

mock.module("../../../src/tui/clipboard", () => ({
  readImageFromClipboard: async () => pngBytes,
}));
import { createSessionStore } from "../../../src/core/session/store";
import type { VesicleImageAttachment, VesicleMessage } from "../../../src/providers/shared/types";
import type { ComposerElement } from "../../../src/tui/composer";
import { createComposerController } from "../../../src/tui/composer-controller";
import { createInputQueue } from "../../../src/tui/input-queue";
import { createInputRouter, type InputRoutingOptions } from "../../../src/tui/input-routing";
import { createQueuedWorkController } from "../../../src/tui/queued-work-controller";
import { TurnCancellation } from "../../../src/tui/turn-cancellation";
import type { Message } from "../../../src/tui/types";

type FreshSubmission = {
  value: string;
  images: VesicleImageAttachment[];
  elements: ComposerElement[];
};

type Harness = {
  router: ReturnType<typeof createInputRouter>;
  composer: ReturnType<typeof createComposerController>;
  queuedWork: ReturnType<typeof createQueuedWorkController>;
  inputQueue: ReturnType<typeof createInputQueue>;
  turn: Promise<{ kind: "interrupted" } | { kind: "complete"; value: string }>;
  conversation: () => VesicleMessage[];
  messages: () => Message[];
  submitted: FreshSubmission[];
  providerAborted: () => boolean;
  setBusy: (value: boolean) => void;
  handleInterruption: (sessionId: string | undefined) => Promise<boolean>;
  dispose: () => void;
};

async function buildHarness(root: string, sessionId: string): Promise<Harness> {
  const session = await createSessionStore(root, sessionId);
  await session.append({ role: "user", content: "durable input" });
  await session.append({ role: "assistant", content: "durable reply" });

  const [status, setStatus] = createSignal("");
  let busy = false;
  let conversation: VesicleMessage[] = [];
  let messages: Message[] = [];
  let providerAborted = false;
  const submitted: FreshSubmission[] = [];
  const inputQueue = createInputQueue();
  const turnCancellation = new TurnCancellation();

  let queuedWork!: ReturnType<typeof createQueuedWorkController>;
  let composer!: ReturnType<typeof createComposerController>;
  let dispose!: () => void;

  createRoot((disposeRoot) => {
    dispose = disposeRoot;
    queuedWork = createQueuedWorkController({
      rootDir: root,
      inputQueue,
      canDrain: () => !busy,
      agentCards: () => [],
      setConversation: (value) => {
        conversation = typeof value === "function" ? value(conversation) : value;
        return conversation;
      },
      setMessages: (value) => {
        messages = typeof value === "function" ? value(messages) : value;
        return messages;
      },
      setStatus: (value) => value,
      recordActivity: () => undefined,
      recordPromptHistory: () => undefined,
      submitPrompt: async (value, images = [], elements = []) => {
        submitted.push({ value, images, elements });
      },
      executeLocalCommand: async () => undefined,
      reportError: () => undefined,
    });
    composer = createComposerController({
      rootDir: root,
      commands: () => [],
      activeEngine: () => "etl",
      terminalWidth: () => 80,
      providerRegistry: () => null,
      activeProvider: () => "test",
      ensureProviderRegistry: async () => { throw new Error("not used"); },
      applyProviderSelection: async () => { throw new Error("not used"); },
      persistProviderSwitch: async () => undefined,
      agentCards: () => [],
      sessionId: () => sessionId,
      refreshArtifacts: async () => [],
      listSessions: async () => [],
      listWorkspaceTargets: async () => [],
      busy: () => busy,
      activeModelCapabilities: () => ({ vision: true }),
      status,
      setStatus,
      setMessages: () => undefined,
      recordActivity: () => undefined,
      reportError: () => undefined,
      inputQueue,
      submitCommand: () => true,
      submitPrompt: async () => undefined,
      abortTurn: () => {
        const aborted = turnCancellation.abort();
        if (aborted) queuedWork.markInterruptRequested();
        return aborted;
      },
      openRewind: async () => undefined,
    });
  });

  const router = createInputRouter({
    renderer: {} as InputRoutingOptions["renderer"],
    setStatus,
    rewindPicker: () => null,
    handleRewindKey: () => false,
    branchPicker: () => null,
    handleBranchKey: () => false,
    modelPicker: () => null,
    handleModelPickerKey: () => false,
    qualityPicker: () => null,
    handleQualityPickerKey: () => false,
    qualityRewriteConfirm: () => null,
    handleRewriteConfirmKey: () => false,
    sessionPicker: () => null,
    handleSessionPickerKey: () => false,
    skillPicker: () => null,
    handleSkillPickerKey: () => false,
    yoloConfirmStage: () => null,
    handleYoloKey: () => false,
    activePermissionRequest: () => undefined,
    pendingUserQuestion: () => null,
    handleQuestionKey: () => false,
    activeGateRequest: () => null,
    handleGateKey: () => false,
    pasteClipboardImage: async () => undefined,
    handleComposerKey: composer.handleKey,
    handlePromptEscape: composer.handleEscape,
    handleDecisionPaste: () => false,
    insertComposerPaste: () => undefined,
  });

  // The active cancellable provider turn. It stays pending until prompt-level
  // Esc aborts it through TurnCancellation.
  const turn = turnCancellation.run((signal) => new Promise<string>((_resolve, reject) => {
    signal.addEventListener("abort", () => {
      providerAborted = true;
      reject(new DOMException("Aborted", "AbortError"));
    }, { once: true });
  }));

  return {
    router,
    composer,
    queuedWork,
    inputQueue,
    turn,
    conversation: () => conversation,
    messages: () => messages,
    submitted,
    providerAborted: () => providerAborted,
    setBusy: (value) => { busy = value; },
    handleInterruption: (sessionIdOrUndefined) => queuedWork.handleInterruption(sessionIdOrUndefined),
    dispose,
  };
}

function typeText(router: ReturnType<typeof createInputRouter>, text: string): void {
  for (const char of text) router.handleKey({ name: char, sequence: char });
}

test("Esc queues the exact FIFO head for fresh submission after durable rebuild", async () => {
  const root = await mkdtemp(join(tmpdir(), "vesicle-esc-takeover-"));
  try {
    const harness = await buildHarness(root, "session");
    try {
      // active cancellable turn
      harness.queuedWork.prepareTurn();
      harness.setBusy(true);

      // type queued message through composer key routing
      typeText(harness.router, "follow up");

      // paste an image so the queued head carries ordered elements and an
      // attachment whose metadata must be cloned into the fresh submission
      await harness.composer.pasteClipboardImage();

      // Enter key queues it
      harness.router.handleKey({ name: "enter" });
      expect(harness.inputQueue.items()).toHaveLength(1);
      expect(harness.inputQueue.peekNext()!.kind).toBe("message");

      // Escape key reaches prompt-level routing
      harness.router.handleKey({ name: "escape" });

      // AbortController signal becomes aborted
      expect(harness.providerAborted()).toBe(true);
      expect(await harness.turn).toEqual({ kind: "interrupted" });

      // durable interrupted snapshot is loaded; provider conversation and
      // display transcript match durable records before the queue is released
      expect(await harness.handleInterruption("session")).toBe(true);
      expect(harness.conversation().map((message) => message.content)).toEqual(["durable input", "durable reply"]);
      expect(harness.messages().map((message) => message.content)).toEqual(["durable input", "durable reply"]);
      expect(harness.inputQueue.items()).toHaveLength(1);

      // busy clears / readiness barrier opens
      harness.setBusy(false);
      await Promise.resolve();
      expect(harness.queuedWork.drainIfReady()).toBe(true);
      await Promise.resolve();
      await Promise.resolve();

      // captured FIFO head is removed once and fresh submit receives the queued
      // value, elements, and images exactly once
      expect(harness.inputQueue.items()).toEqual([]);
      expect(harness.submitted).toHaveLength(1);
      expect(harness.submitted[0]!.value).toContain("follow up");
      expect(harness.submitted[0]!.elements).toHaveLength(1);
      expect(harness.submitted[0]!.images).toHaveLength(1);
      // No duplicate user record: the fresh submission owns its own durable
      // record and the interrupted projection must not append the queued text.
      expect(harness.conversation().map((message) => message.content)).toEqual(["durable input", "durable reply"]);
    } finally {
      harness.dispose();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("recalling the captured head during cleanup cancels the Esc takeover", async () => {
  const root = await mkdtemp(join(tmpdir(), "vesicle-esc-takeover-recall-"));
  try {
    const harness = await buildHarness(root, "session");
    try {
      harness.queuedWork.prepareTurn();
      harness.setBusy(true);

      typeText(harness.router, "recall me");
      harness.router.handleKey({ name: "enter" });
      expect(harness.inputQueue.items()).toHaveLength(1);

      // Escape captures the head, then Up recalls it out of the queue
      harness.router.handleKey({ name: "escape" });
      expect(harness.providerAborted()).toBe(true);
      expect(await harness.turn).toEqual({ kind: "interrupted" });

      harness.router.handleKey({ name: "up" });
      expect(harness.inputQueue.items()).toEqual([]);

      // The captured head no longer exists; the takeover must fail closed and
      // stay blocked instead of substituting another queued item.
      expect(await harness.handleInterruption("session")).toBe(false);
      harness.setBusy(false);
      await Promise.resolve();
      expect(harness.queuedWork.drainIfReady()).toBe(false);
      expect(harness.submitted).toEqual([]);
    } finally {
      harness.dispose();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
