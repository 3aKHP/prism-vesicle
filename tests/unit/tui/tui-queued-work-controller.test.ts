import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { createRoot, createSignal } from "solid-js";
import { createSessionStore } from "../../../src/core/session/store";
import type { VesicleMessage } from "../../../src/providers/shared/types";
import { createInputQueue } from "../../../src/tui/input-queue";
import { createQueuedWorkController } from "../../../src/tui/queued-work-controller";
import type { Message } from "../../../src/tui/types";

describe("TUI queued work controller", () => {
  test("waits for the host readiness barrier before draining agent-loop commands", async () => {
    const inputQueue = createInputQueue();
    inputQueue.enqueueCommand({ raw: "/model alpha", commandName: "model", args: "alpha", boundary: "agent-loop" });
    const [canDrain, setCanDrain] = createSignal(false);
    const executed: string[] = [];
    let dispose: () => void = () => undefined;
    const controller = createRoot((rootDispose) => {
      dispose = rootDispose;
      return createQueuedWorkController({
        rootDir: process.cwd(),
        inputQueue,
        canDrain,
        agentCards: () => [],
        setConversation: (value) => value as VesicleMessage[],
        setMessages: (value) => value as Message[],
        setStatus: (value) => value,
        recordActivity: () => undefined,
        recordPromptHistory: () => undefined,
        submitPrompt: async () => undefined,
        executeLocalCommand: async (raw) => { executed.push(raw); },
        reportError: (error) => { throw error; },
      });
    });

    controller.release();
    expect(executed).toEqual([]);
    expect(inputQueue.items()).toHaveLength(1);

    setCanDrain(true);
    expect(controller.drainIfReady()).toBe(true);
    await Promise.resolve();
    expect(executed).toEqual(["/model alpha"]);
    expect(inputQueue.items()).toEqual([]);
    dispose();
  });

  test("rebuilds durable conversation before releasing an interrupted queue", async () => {
    const root = await mkdtemp(join(tmpdir(), "vesicle-queued-work-"));
    try {
      const session = await createSessionStore(root, "parent");
      await session.append({ role: "user", content: "durable input" });
      const inputQueue = createInputQueue();
      inputQueue.enqueueMessage({ value: "follow up", elements: [], images: [] });
      let conversation: VesicleMessage[] = [];
      let messages: Message[] = [];
      const controller = createQueuedWorkController({
        rootDir: root,
        inputQueue,
        canDrain: () => false,
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
        submitPrompt: async () => undefined,
        executeLocalCommand: async () => undefined,
        reportError: (error) => { throw error; },
      });

      controller.markInterruptRequested();
      expect(await controller.handleInterruption("parent")).toBe(true);
      expect(conversation.map((message) => message.content)).toEqual(["durable input"]);
      expect(messages.map((message) => message.content)).toEqual(["durable input"]);
      expect(inputQueue.items()).toHaveLength(1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("releases queued work for draining after rebuilding an interrupted session", async () => {
    const root = await mkdtemp(join(tmpdir(), "vesicle-queued-work-drain-"));
    try {
      const session = await createSessionStore(root, "parent");
      await session.append({ role: "user", content: "durable input" });
      const inputQueue = createInputQueue();
      inputQueue.enqueueMessage({ value: "follow up", elements: [], images: [] });
      let conversation: VesicleMessage[] = [];
      let messages: Message[] = [];
      const submitted: string[] = [];
      let dispose: () => void = () => undefined;
      const controller = createRoot((rootDispose) => {
        dispose = rootDispose;
        return createQueuedWorkController({
          rootDir: root,
          inputQueue,
          canDrain: () => true,
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
          submitPrompt: async (value) => { submitted.push(value); },
          executeLocalCommand: async () => undefined,
          reportError: (error) => { throw error; },
        });
      });

      controller.markInterruptRequested();
      expect(await controller.handleInterruption("parent")).toBe(true);
      expect(conversation.map((message) => message.content)).toEqual(["durable input"]);
      expect(messages.map((message) => message.content)).toEqual(["durable input"]);
      expect(controller.drainIfReady()).toBe(true);
      expect(submitted).toEqual(["follow up"]);
      expect(inputQueue.items()).toEqual([]);
      dispose();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("promotes only the captured FIFO head and never retroactively promotes later input", async () => {
    const root = await mkdtemp(join(tmpdir(), "vesicle-queued-work-capture-"));
    try {
      const session = await createSessionStore(root, "parent");
      await session.append({ role: "user", content: "durable" });
      const inputQueue = createInputQueue();
      inputQueue.enqueueMessage({ value: "head", elements: [], images: [] });
      inputQueue.enqueueMessage({ value: "later", elements: [], images: [] });
      const submitted: string[] = [];
      let dispose: () => void = () => undefined;
      const controller = createRoot((rootDispose) => {
        dispose = rootDispose;
        return createQueuedWorkController({
          rootDir: root,
          inputQueue,
          canDrain: () => true,
          agentCards: () => [],
          setConversation: (value) => value as VesicleMessage[],
          setMessages: (value) => value as Message[],
          setStatus: (value) => value,
          recordActivity: () => undefined,
          recordPromptHistory: () => undefined,
          submitPrompt: async (value) => { submitted.push(value); },
          executeLocalCommand: async () => undefined,
          reportError: (error) => { throw error; },
        });
      });

      controller.markInterruptRequested(); // captures "head" (id 1)
      // An item queued after Esc is not retroactively promoted by that Esc.
      inputQueue.enqueueMessage({ value: "third", elements: [], images: [] });
      expect(await controller.handleInterruption("parent")).toBe(true);
      expect(controller.drainIfReady()).toBe(true);
      await Promise.resolve();
      await Promise.resolve();
      expect(submitted).toEqual(["head"]);
      expect(inputQueue.items().map((item) => item.kind === "message" ? item.value : item.raw)).toEqual(["later", "third"]);
      dispose();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("a changed head during recovery cancels the takeover without substituting another item", async () => {
    const root = await mkdtemp(join(tmpdir(), "vesicle-queued-work-subst-"));
    try {
      const session = await createSessionStore(root, "parent");
      await session.append({ role: "user", content: "durable" });
      const inputQueue = createInputQueue();
      inputQueue.enqueueMessage({ value: "original head", elements: [], images: [] });
      inputQueue.enqueueCommand({ raw: "/model alpha", commandName: "model", args: "alpha", boundary: "agent-loop" });
      const submitted: string[] = [];
      const executed: string[] = [];
      let dispose: () => void = () => undefined;
      const controller = createRoot((rootDispose) => {
        dispose = rootDispose;
        return createQueuedWorkController({
          rootDir: root,
          inputQueue,
          canDrain: () => true,
          agentCards: () => [],
          setConversation: (value) => value as VesicleMessage[],
          setMessages: (value) => value as Message[],
          setStatus: (value) => value,
          recordActivity: () => undefined,
          recordPromptHistory: () => undefined,
          submitPrompt: async (value) => { submitted.push(value); },
          executeLocalCommand: async (raw) => { executed.push(raw); },
          reportError: (error) => { throw error; },
        });
      });

      controller.markInterruptRequested(); // captures "original head"
      // The captured head is consumed naturally before recovery completes; the
      // /model command is now the head but must not be promoted by the old Esc.
      expect(inputQueue.takeMessages()).toHaveLength(1);
      expect(await controller.handleInterruption("parent")).toBe(false);
      expect(controller.drainIfReady()).toBe(false);
      expect(submitted).toEqual([]);
      expect(executed).toEqual([]);
      expect(inputQueue.items().map((item) => item.kind === "message" ? item.value : item.raw)).toEqual(["/model alpha"]);
      dispose();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("an absent session id fails closed without releasing or dequeuing", async () => {
    const inputQueue = createInputQueue();
    inputQueue.enqueueMessage({ value: "head", elements: [], images: [] });
    const submitted: string[] = [];
    let dispose: () => void = () => undefined;
    const controller = createRoot((rootDispose) => {
      dispose = rootDispose;
      return createQueuedWorkController({
        rootDir: process.cwd(),
        inputQueue,
        canDrain: () => true,
        agentCards: () => [],
        setConversation: (value) => value as VesicleMessage[],
        setMessages: (value) => value as Message[],
        setStatus: (value) => value,
        recordActivity: () => undefined,
        recordPromptHistory: () => undefined,
        submitPrompt: async (value) => { submitted.push(value); },
        executeLocalCommand: async () => undefined,
        reportError: (error) => { throw error; },
      });
    });

    controller.markInterruptRequested();
    expect(await controller.handleInterruption(undefined)).toBe(false);
    expect(controller.drainIfReady()).toBe(false);
    expect(submitted).toEqual([]);
    expect(inputQueue.items()).toHaveLength(1);
    dispose();
  });

  test("restores a queued prompt when submission fails", async () => {
    const inputQueue = createInputQueue();
    inputQueue.enqueueMessage({ value: "retry me", elements: [], images: [] });
    const failures: unknown[] = [];
    let dispose: () => void = () => undefined;
    const controller = createRoot((rootDispose) => {
      dispose = rootDispose;
      return createQueuedWorkController({
        rootDir: process.cwd(),
        inputQueue,
        canDrain: () => true,
        agentCards: () => [],
        setConversation: (value) => value as VesicleMessage[],
        setMessages: (value) => value as Message[],
        setStatus: (value) => value,
        recordActivity: () => undefined,
        recordPromptHistory: () => undefined,
        submitPrompt: async () => { throw new Error("provider unavailable"); },
        executeLocalCommand: async () => undefined,
        reportError: (error) => { failures.push(error); },
      });
    });

    controller.release();
    expect(controller.drainIfReady()).toBe(true);
    await Promise.resolve();
    await Promise.resolve();
    expect(inputQueue.items().map((item) => item.kind === "message" ? item.value : item.raw)).toEqual(["retry me"]);
    expect(failures).toHaveLength(1);
    expect(controller.drainIfReady()).toBe(false);
    dispose();
  });
});
