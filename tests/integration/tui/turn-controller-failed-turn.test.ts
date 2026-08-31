import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import { createSessionStore, FAILED_TURN_KIND, loadSessionMessages } from "../../../src/core/session/store";
import type { VesicleMessage } from "../../../src/providers/shared/types";
import { createTurnController } from "../../../src/tui/turn-controller";

// A provider failure on a fresh user turn must append a `failed-turn` marker so
// projection can drop the dangling prompt (#102). This exercises the full
// turn-controller catch path against a real session JSONL — including a new
// session whose id is only assigned mid-runPrompt, which a stale captured id
// would miss.
test("turn failure appends a failed-turn marker to the session", async () => {
  const root = await mkdtemp(join(tmpdir(), "vesicle-tui-failed-turn-"));
  try {
    const store = await createSessionStore(root, "failed-turn-session");
    await store.append({ role: "system", content: "prompt", metadata: { engine: "etl" } });
    await store.append({ role: "user", content: "refactor this" });

    let busy = false;
    let conversation: VesicleMessage[] = [];
    let messages: unknown[] = [];
    const controller = createTurnController({
      rootDir: root,
      busy: () => busy,
      setBusy: (value: boolean | ((current: boolean) => boolean)) => {
        busy = typeof value === "function" ? value(busy) : value;
        return busy;
      },
      sessionId: () => store.sessionId,
      conversation: () => conversation,
      setConversation: (value: VesicleMessage[] | ((current: VesicleMessage[]) => VesicleMessage[])) => {
        conversation = typeof value === "function" ? value(conversation) : value;
        return conversation;
      },
      setMessages: (value: unknown[] | ((current: unknown[]) => unknown[])) => {
        messages = typeof value === "function" ? value(messages) : value;
        return messages;
      },
      providerConfigReady: () => true,
      permissionSettingsReady: () => true,
      pausedAgentDeliveries: new Set<string>(),
      markProcessNotified: async () => {},
      resetProcessNotified: async () => {},
      pausedProcessDeliveries: new Set<string>(),
      queuedWork: { prepareTurn: () => {}, block: () => {}, takePendingUserInputs: () => [], runToolBoundaryCommands: async () => {} },
      recordPromptHistory: () => undefined,
      setHistoryIndex: () => undefined,
      setSessionPicker: () => undefined,
      setLastDisplayedToolAssistantContent: () => undefined,
      setStatus: () => undefined,
      recordActivity: () => undefined,
      beginUsageTurn: () => undefined,
      setStreamingAssistant: () => undefined,
      setStreamingReasoning: () => undefined,
      nextSessionParent: () => null,
      setNextSessionParent: () => undefined,
      // Simulate the provider round throwing without ever running runPrompt, so
      // the pre-seeded session is the state the catch sees.
      runCancellable: async () => { throw new Error("provider HTTP 402"); },
    } as any);

    await controller.submitPrompt("refactor this", [], []);

    const raw = await readFile(join(root, ".vesicle", "sessions", `${store.sessionId}.jsonl`), "utf8");
    expect(raw.includes(`"kind":"${FAILED_TURN_KIND}"`)).toBe(true);

    // Projection drops the failed prompt, so resume sees no dangling user.
    const resumed = await loadSessionMessages(root, store.sessionId);
    expect(resumed.map((m) => m.role)).toEqual([]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// A first provider round that fails right after materializing a background
// shell completion leaves the system-role host packet as the trailing record;
// it projects as a user message, so the failed-turn marker must fire for it
// too or resume/resend pairs it with the next real prompt as consecutive user
// messages (issue #284).
test("turn failure after a background-results packet still marks the failed turn", async () => {
  const root = await mkdtemp(join(tmpdir(), "vesicle-tui-failed-bg-"));
  try {
    const store = await createSessionStore(root, "failed-turn-bg");
    await store.append({ role: "system", content: "prompt", metadata: { engine: "etl" } });
    await store.append({ role: "user", content: "run the build" });
    await store.append({
      role: "system",
      content: "<background-shell-results>\nHost notification.\n</background-shell-results>",
      metadata: { kind: "background-process-results", taskIds: ["shell-1"] },
    });

    const controller = createTurnController({
      rootDir: root,
      busy: () => false,
      setBusy: () => false,
      sessionId: () => store.sessionId,
      conversation: () => [],
      setConversation: () => [],
      setMessages: () => undefined,
      providerConfigReady: () => true,
      permissionSettingsReady: () => true,
      pausedAgentDeliveries: new Set<string>(),
      markProcessNotified: async () => {},
      resetProcessNotified: async () => {},
      pausedProcessDeliveries: new Set<string>(),
      queuedWork: { prepareTurn: () => {}, block: () => {}, takePendingUserInputs: () => [], runToolBoundaryCommands: async () => {} },
      recordPromptHistory: () => undefined,
      setHistoryIndex: () => undefined,
      setSessionPicker: () => undefined,
      setLastDisplayedToolAssistantContent: () => undefined,
      setStatus: () => undefined,
      recordActivity: () => undefined,
      beginUsageTurn: () => undefined,
      setStreamingAssistant: () => undefined,
      setStreamingReasoning: () => undefined,
      nextSessionParent: () => null,
      setNextSessionParent: () => undefined,
      runCancellable: async () => { throw new Error("provider HTTP 500"); },
    } as any);

    await controller.submitPrompt("run the build", [], []);

    const raw = await readFile(join(root, ".vesicle", "sessions", `${store.sessionId}.jsonl`), "utf8");
    expect(raw.includes(`"kind":"${FAILED_TURN_KIND}"`)).toBe(true);

    const resumed = await loadSessionMessages(root, store.sessionId);
    expect(resumed.map((m) => m.role)).toEqual([]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("mid-turn failure refreshes the in-memory conversation from durable history", async () => {
  const root = await mkdtemp(join(tmpdir(), "vesicle-tui-durable-refresh-"));
  try {
    const store = await createSessionStore(root, "durable-refresh-session");
    await store.append({ role: "system", content: "prompt", metadata: { engine: "etl" } });
    await store.append({ role: "user", content: "write files" });
    let conversation: VesicleMessage[] = [{ role: "user", content: "stale" }];
    let busy = false;
    const controller = createTurnController({
      rootDir: root,
      busy: () => busy,
      setBusy: (value: boolean | ((current: boolean) => boolean)) => {
        busy = typeof value === "function" ? value(busy) : value;
        return busy;
      },
      sessionId: () => store.sessionId,
      conversation: () => conversation,
      setConversation: (value: VesicleMessage[] | ((current: VesicleMessage[]) => VesicleMessage[])) => {
        conversation = typeof value === "function" ? value(conversation) : value;
        return conversation;
      },
      setMessages: () => undefined,
      providerConfigReady: () => true,
      permissionSettingsReady: () => true,
      pausedAgentDeliveries: new Set<string>(),
      markProcessNotified: async () => {},
      resetProcessNotified: async () => {},
      pausedProcessDeliveries: new Set<string>(),
      queuedWork: { prepareTurn: () => {}, block: () => {}, takePendingUserInputs: () => [], runToolBoundaryCommands: async () => {} },
      recordPromptHistory: () => undefined,
      setHistoryIndex: () => undefined,
      setSessionPicker: () => undefined,
      setLastDisplayedToolAssistantContent: () => undefined,
      setStatus: () => undefined,
      recordActivity: () => undefined,
      beginUsageTurn: () => undefined,
      setStreamingAssistant: () => undefined,
      setStreamingReasoning: () => undefined,
      nextSessionParent: () => null,
      setNextSessionParent: () => undefined,
      runCancellable: async () => {
        await store.append({
          role: "assistant",
          content: "",
          metadata: { toolCalls: [{ id: "bad", name: "write_file", arguments: "{}" }] },
        });
        await store.append({
          role: "tool",
          content: JSON.stringify({ ok: false, result: "invalid arguments" }),
          metadata: { toolCallId: "bad", name: "write_file", ok: false },
        });
        throw new Error("continuation failed");
      },
    } as any);

    await controller.submitPrompt("write files", [], []);

    expect(conversation.map((message) => message.role)).toEqual(["user", "assistant", "tool"]);
    expect(conversation.at(-1)).toMatchObject({ toolCallId: "bad", toolOk: false });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
