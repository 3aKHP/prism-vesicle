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
      messages: () => messages,
      setMessages: (value: unknown[] | ((current: unknown[]) => unknown[])) => {
        messages = typeof value === "function" ? value(messages) : value;
        return messages;
      },
      providerConfigReady: () => true,
      permissionSettingsReady: () => true,
      pausedAgentDeliveries: new Set<string>(),
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
