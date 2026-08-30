import { describe, expect, test } from "bun:test";
import { createRoot, createSignal } from "solid-js";
import { createComposerController } from "../../../src/tui/composer-controller";
import { setComposerValue } from "../../../src/tui/composer";
import { createInputQueue } from "../../../src/tui/input-queue";
import type { Message } from "../../../src/tui/types";
import { busyComposerPlaceholder, escInterruptHint, queuedInputPreviewRows } from "../../../src/tui/views/BottomSurface";

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
        commands: () => [],
        activeEngine: () => "etl",
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
        listWorkspaceTargets: async () => [],
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
    expect(queuedInputPreviewRows(queue.items(), 40, 3, false)).toEqual([
      "Queued 4 · Up edits last",
      "1. one",
      "... +3 more queued",
    ]);
    expect(queuedInputPreviewRows(queue.items(), 40, 0, false)).toEqual([]);
  });

  test("peekNext clones the head without consuming it and preserves FIFO", () => {
    const queue = createInputQueue();
    const image = {
      id: "image-1",
      path: ".vesicle/attachments/image-1.png",
      sha256: "b".repeat(64),
      mediaType: "image/png" as const,
      bytes: 4,
      source: "clipboard" as const,
    };
    queue.enqueueMessage({
      value: "first [Image #1]",
      elements: [{ type: "image" as const, attachmentId: image.id, placeholder: "[Image #1]", start: 6, end: 16 }],
      images: [image],
    });
    queue.enqueueMessage({ value: "second", elements: [], images: [] });

    const head = queue.peekNext();
    expect(head).toMatchObject({ kind: "message", value: "first [Image #1]" });
    // peek returns a clone: mutating the returned snapshot must not leak in.
    if (head?.kind === "message") {
      head.elements[0]!.placeholder = "changed";
      head.images[0]!.path = "changed";
    }
    expect(queue.peekNext()).toMatchObject({
      value: "first [Image #1]",
      elements: [{ placeholder: "[Image #1]" }],
      images: [{ path: ".vesicle/attachments/image-1.png" }],
    });
    // peek does not consume: FIFO order and later takeNext are unchanged.
    expect(queue.items().map((item) => item.kind === "message" ? item.value : item.raw)).toEqual(["first [Image #1]", "second"]);
    expect(queue.takeNext()).toMatchObject({ value: "first [Image #1]" });
    expect(queue.peekNext()).toMatchObject({ value: "second" });
    expect(queue.takeNext()).toMatchObject({ value: "second" });
    expect(queue.peekNext()).toBeUndefined();
  });

  test("projects busy Esc interrupt hint states within the 80-column budget", () => {
    const queue = createInputQueue();
    queue.enqueueMessage({ value: "one", elements: [], images: [] });
    // idle: no interrupt hint anywhere
    expect(escInterruptHint(false, 1)).toBeUndefined();
    expect(queuedInputPreviewRows(queue.items(), 40, 3, false)[0]).toBe("Queued 1 · Up edits last");
    // busy: the hint appears in the non-empty queue header, not the placeholder
    expect(escInterruptHint(true, 1)).toBe("Esc interrupt & send next");
    expect(queuedInputPreviewRows(queue.items(), 60, 3, true)[0]).toBe("Queued 1 · Esc interrupt & send next · Up edits last");
    expect(busyComposerPlaceholder(1)).toBe("Type input · Enter queue");
    // busy + empty queue: the hint moves into the placeholder
    expect(escInterruptHint(true, 0)).toBe("Esc interrupt");
    expect(busyComposerPlaceholder(0)).toBe("Type input · Enter queue · Esc interrupt");
    // 80-column content budget: composer input width is terminal width - 4.
    const composerWidth = 80 - 4;
    expect(busyComposerPlaceholder(0).length).toBeLessThanOrEqual(composerWidth);
    expect(busyComposerPlaceholder(1).length).toBeLessThanOrEqual(composerWidth);
    expect(escInterruptHint(true, 1)!.length).toBeLessThanOrEqual(composerWidth);
    const header = queuedInputPreviewRows(queue.items(), composerWidth, 3, true)[0]!;
    expect(header.length).toBeLessThanOrEqual(composerWidth);
    // the mixed preview (header + preview rows) also stays within its inner width
    for (const row of queuedInputPreviewRows(queue.items(), composerWidth, 3, true)) {
      expect(row.length).toBeLessThanOrEqual(composerWidth);
    }
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
