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
