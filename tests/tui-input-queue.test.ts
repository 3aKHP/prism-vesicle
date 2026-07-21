import { describe, expect, test } from "bun:test";
import { createRoot, createSignal } from "solid-js";
import { createComposerController } from "../src/tui/composer-controller";
import { setComposerValue } from "../src/tui/composer";
import { createInputQueue } from "../src/tui/input-queue";
import type { Message } from "../src/tui/types";
import { queuedInputPreviewRows } from "../src/tui/views/BottomSurface";

describe("TUI input queue", () => {
  test("preserves FIFO order and snapshots attachment state", () => {
    const queue = createInputQueue();
    const image = {
      id: "image-1",
      path: ".vesicle/attachments/image-1.png",
      sha256: "a".repeat(64),
      mediaType: "image/png" as const,
      bytes: 4,
      source: "clipboard" as const,
    };
    const first = {
      value: "first [Image #1]",
      elements: [{ type: "image" as const, attachmentId: image.id, placeholder: "[Image #1]", start: 6, end: 16 }],
      images: [image],
    };

    queue.enqueueMessage(first);
    queue.enqueueMessage({ value: "second", elements: [], images: [] });
    first.elements[0]!.placeholder = "changed";
    first.images[0]!.path = "changed";

    expect(queue.takeNext()).toMatchObject({
      value: "first [Image #1]",
      elements: [{ placeholder: "[Image #1]" }],
      images: [{ path: ".vesicle/attachments/image-1.png" }],
    });
    expect(queue.takeNext()).toMatchObject({ kind: "message", value: "second" });
    expect(queue.takeNext()).toBeUndefined();
  });

  test("queues ordinary busy input, delegates commands, and recalls the latest queued input", () => {
    createRoot((dispose) => {
      const [busy] = createSignal(true);
      const [status, setStatus] = createSignal("");
      const [messages, setMessages] = createSignal<Message[]>([]);
      const submitted: string[] = [];
      const commands: string[] = [];
      const inputQueue = createInputQueue();
      const controller = createComposerController({
        rootDir: process.cwd(),
        terminalWidth: () => 80,
        providerRegistry: () => null,
        activeProvider: () => "test",
        ensureProviderRegistry: async () => { throw new Error("not used"); },
        applyProviderSelection: async () => { throw new Error("not used"); },
        persistProviderSwitch: async () => undefined,
        agentCards: () => [],
        sessionId: () => "session-test",
        refreshArtifacts: async () => [],
        listSessions: async () => [],
        busy,
        activeModelCapabilities: () => ({ vision: true }),
        status,
        setStatus,
        setMessages,
        recordActivity: () => undefined,
        reportError: () => undefined,
        inputQueue,
        submitCommand: (value) => { commands.push(value); return true; },
        submitPrompt: async (value) => { submitted.push(value); },
        abortTurn: () => false,
        openRewind: async () => undefined,
      });

      controller.applyState(setComposerValue("first follow-up"));
      controller.handleKey({ name: "enter" });
      controller.applyState(setComposerValue("second follow-up"));
      controller.handleKey({ name: "enter" });

      expect(controller.queuedInputs().map((item) => item.kind === "message" ? item.value : item.raw)).toEqual(["first follow-up", "second follow-up"]);
      expect(controller.inputValue()).toBe("");
      expect(submitted).toEqual([]);
      expect(status()).toBe("message queued (2)");

      controller.applyState(setComposerValue("/help"));
      controller.handleKey({ name: "enter" });
      expect(controller.inputValue()).toBe("");
      expect(controller.queuedInputs()).toHaveLength(2);
      expect(commands).toEqual(["/help"]);

      controller.applyState(setComposerValue(""));
      controller.handleKey({ name: "up" });
      expect(controller.inputValue()).toBe("second follow-up");
      expect(controller.queuedInputs().map((item) => item.kind === "message" ? item.value : item.raw)).toEqual(["first follow-up"]);
      expect(messages()).toEqual([]);
      dispose();
    });
  });

  test("keeps mixed queue previews bounded and ordered from the next input", () => {
    const queue = createInputQueue();
    queue.enqueueMessage({ value: "one", elements: [], images: [] });
    queue.enqueueCommand({ raw: "/model alpha", commandName: "model", args: "alpha", boundary: "agent-loop" });
    queue.enqueueMessage({ value: "three", elements: [], images: [] });
    queue.enqueueMessage({ value: "four", elements: [], images: [] });
    expect(queuedInputPreviewRows(queue.items(), 40, 3)).toEqual([
      "Queued 4 · Up edits last",
      "1. one",
      "... +3 more queued",
    ]);
    expect(queuedInputPreviewRows(queue.items(), 40, 0)).toEqual([]);
  });

  test("drains only the leading tool-boundary commands from command FIFO", () => {
    const queue = createInputQueue();
    queue.enqueueMessage({ value: "steer", elements: [], images: [] });
    queue.enqueueCommand({ raw: "/artifact", commandName: "artifact", args: "", boundary: "tool-round" });
    queue.enqueueCommand({ raw: "/model alpha", commandName: "model", args: "alpha", boundary: "agent-loop" });
    queue.enqueueCommand({ raw: "/validate 1", commandName: "validate", args: "1", boundary: "tool-round" });

    expect(queue.takeToolBoundaryCommands().map((command) => command.raw)).toEqual(["/artifact"]);
    expect(queue.items().map((item) => item.kind === "message" ? item.value : item.raw)).toEqual(["steer", "/model alpha", "/validate 1"]);
  });
});
