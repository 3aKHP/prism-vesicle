import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { createRoot, createSignal } from "solid-js";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

// PNG magic header is enough for ingestImageBytes' media-type detection.
const pngBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);

mock.module("../../../src/tui/clipboard", () => ({
  readImageFromClipboard: async () => pngBytes,
}));

import { createComposerController } from "../../../src/tui/composer-controller";
import { createInputQueue } from "../../../src/tui/input-queue";
import type { Message } from "../../../src/tui/types";

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "vesicle-composer-ctrl-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function buildController() {
  const [status, setStatus] = createSignal("");
  const [, setMessages] = createSignal<Message[]>([]);
  const controller = createComposerController({
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
    sessionId: () => "session-test",
    refreshArtifacts: async () => [],
    listSessions: async () => [],
    listWorkspaceTargets: async () => [],
    busy: () => false,
    activeModelCapabilities: () => ({ vision: true }),
    status,
    setStatus,
    setMessages,
    recordActivity: () => undefined,
    reportError: () => undefined,
    inputQueue: createInputQueue(),
    submitCommand: () => true,
    submitPrompt: async () => undefined,
    abortTurn: () => false,
    openRewind: async () => undefined,
  });
  return { controller, status };
}

// createRoot only disposes synchronously-created state; capture dispose and
// await the async paste work outside the root callback so the temp directory
// is not removed mid-flight by afterEach.
function withController<T>(fn: (built: ReturnType<typeof buildController>) => Promise<T>): Promise<T> {
  let dispose!: () => void;
  const built = createRoot((d) => {
    dispose = d;
    return buildController();
  });
  return fn(built).finally(() => dispose());
}

describe("composer controller: busy Esc interrupt preserves the draft", () => {
  test("busy Esc interrupts without clearing text, cursor, elements, or image attachments", async () => {
    let dispose!: () => void;
    let abortCount = 0;
    const built = createRoot((disposeRoot) => {
      dispose = disposeRoot;
      const [status, setStatus] = createSignal("");
      const [, setMessages] = createSignal<Message[]>([]);
      const controller = createComposerController({
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
        sessionId: () => "session-test",
        refreshArtifacts: async () => [],
        listSessions: async () => [],
        listWorkspaceTargets: async () => [],
        busy: () => true,
        activeModelCapabilities: () => ({ vision: true }),
        status,
        setStatus,
        setMessages,
        recordActivity: () => undefined,
        reportError: () => undefined,
        inputQueue: createInputQueue(),
        submitCommand: () => true,
        submitPrompt: async () => undefined,
        abortTurn: () => { abortCount += 1; return true; },
        openRewind: async () => undefined,
      });
      return { controller };
    });
    try {
      const { controller } = built;
      await controller.pasteClipboardImage();
      const elementsBefore = controller.inputElements().map((element) => ({ ...element }));
      const imagesBefore = controller.inputImages().map((image) => ({ ...image }));
      for (const char of "draft") controller.handleKey({ name: char, sequence: char });
      const valueBefore = controller.inputValue();
      const cursorBefore = controller.inputCursor();
      expect(valueBefore).toContain("draft");

      controller.handleEscape();

      expect(abortCount).toBe(1);
      expect(controller.inputValue()).toBe(valueBefore);
      expect(controller.inputCursor()).toBe(cursorBefore);
      expect(controller.inputElements()).toEqual(elementsBefore);
      expect(controller.inputImages()).toEqual(imagesBefore);
      // nothing was queued or submitted by the busy Esc path
      expect(controller.queuedInputs()).toEqual([]);
    } finally {
      dispose();
    }
  });
});

describe("composer controller: clipboard image paste status numbering (#134)", () => {
  test("pasting at the start of an existing placeholder reports the new image as #1", async () => {
    await withController(async ({ controller, status }) => {
      // First paste lands at the end: [Image #1]<space>, cursor after the space.
      await controller.pasteClipboardImage();
      expect(status()).toBe("attached Image #1");
      expect(controller.inputElements()).toHaveLength(1);

      // Move the cursor to the very start of the existing placeholder (the
      // position Left-arrow lands on from inside the element).
      const element = controller.inputElements()[0]!;
      controller.applyState({
        value: controller.inputValue(),
        cursor: element.start,
        elements: controller.inputElements(),
      });

      // Paste again at that boundary: the existing image shifts right, so the
      // new image becomes #1 even though both share one content-hash id.
      await controller.pasteClipboardImage();
      expect(status()).toBe("attached Image #1");

      const elements = controller.inputElements();
      expect(elements).toHaveLength(2);
      expect(elements[0].placeholder).toBe("[Image #1]");
      expect(elements[1].placeholder).toBe("[Image #2]");
    });
  });

  test("pasting after an existing image reports the new image as #2", async () => {
    await withController(async ({ controller, status }) => {
      await controller.pasteClipboardImage();
      expect(status()).toBe("attached Image #1");

      // Cursor is already after the first image; paste again at the end.
      await controller.pasteClipboardImage();
      expect(status()).toBe("attached Image #2");

      const elements = controller.inputElements();
      expect(elements).toHaveLength(2);
      expect(elements[0].placeholder).toBe("[Image #1]");
      expect(elements[1].placeholder).toBe("[Image #2]");
    });
  });
});
