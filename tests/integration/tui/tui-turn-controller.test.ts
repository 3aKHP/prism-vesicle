import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import { AgentDeliveryDeferred } from "../../../src/core/agents/scheduler";
import type { AgentInboxEntry } from "../../../src/core/agents/types";
import { createSessionStore } from "../../../src/core/session/store";
import type { VesicleMessage } from "../../../src/providers/shared/types";
import { createTurnController } from "../../../src/tui/turn-controller";
import { createInputQueue } from "../../../src/tui/input-queue";
import { createQueuedWorkController } from "../../../src/tui/queued-work-controller";

test("interrupted SubAgent delivery rebuilds durable conversation before releasing queued input", async () => {
  const root = await mkdtemp(join(tmpdir(), "vesicle-tui-agent-delivery-"));
  try {
    const session = await createSessionStore(root, "parent");
    await session.append({ role: "user", content: "start" });
    const packet = "<subagent-results>finished</subagent-results>";
    await session.append({
      role: "user",
      content: packet,
      metadata: { kind: "subagent-results", inboxIds: ["inbox-1"] },
    });
    const entry: AgentInboxEntry = {
      inboxId: "inbox-1",
      parentSessionId: "parent",
      runId: "run-1",
      handle: "explore-1",
      profileId: "explore",
      description: "Inspect queue behavior",
      status: "completed",
      content: "finished",
      createdAt: "2026-07-21T00:00:00.000Z",
      state: "delivered",
    };
    let busy = false;
    let conversation: VesicleMessage[] = [{ role: "user", content: "start" }];
    let messages: unknown[] = [];
    let agentCards: unknown[] = [];
    const pausedAgentDeliveries = new Set<string>();
    const inputQueue = createInputQueue();
    inputQueue.enqueueMessage({ value: "continue", elements: [], images: [] });
    const queuedWork = createQueuedWorkController({
      rootDir: root,
      inputQueue,
      canDrain: () => false,
      agentCards: () => agentCards as any,
      setConversation: (value: VesicleMessage[] | ((current: VesicleMessage[]) => VesicleMessage[])) => {
        conversation = typeof value === "function" ? value(conversation) : value;
        return conversation;
      },
      setMessages: (value: any) => {
        messages = typeof value === "function" ? value(messages) : value;
        return messages;
      },
      setStatus: (value) => typeof value === "function" ? value("") : value,
      recordActivity: () => undefined,
      recordPromptHistory: () => undefined,
      submitPrompt: async () => undefined,
      executeLocalCommand: async () => undefined,
      reportError: () => undefined,
    });
    const controller = createTurnController({
      rootDir: root,
      busy: () => busy,
      setBusy: (value: boolean | ((current: boolean) => boolean)) => {
        busy = typeof value === "function" ? value(busy) : value;
        return busy;
      },
      queuedWork,
      sessionId: () => "parent",
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
      agentCards: () => agentCards,
      setAgentCards: (value: unknown[] | ((current: unknown[]) => unknown[])) => {
        agentCards = typeof value === "function" ? value(agentCards) : value;
        return agentCards;
      },
      pendingGate: () => null,
      pendingEngineSwitch: () => null,
      pendingUserQuestion: () => null,
      pendingPermission: () => null,
      pendingQualityDecision: () => null,
      pendingChildPermission: () => null,
      pausedAgentDeliveries,
      runCancellable: async () => {
        queuedWork.markInterruptRequested();
        return { kind: "interrupted" as const };
      },
      beginUsageTurn: () => undefined,
      recordActivity: () => undefined,
      setStatus: (value: string) => value,
      setStreamingAssistant: (value: string) => value,
      setStreamingReasoning: (value: string) => value,
      setLastDisplayedToolAssistantContent: (value: string | null) => value,
    } as any);

    await expect(controller.deliverAgentResults("parent", [entry], packet)).rejects.toBeInstanceOf(AgentDeliveryDeferred);

    expect(conversation.map((message) => message.content)).toEqual(["start", packet]);
    expect(inputQueue.items()).toHaveLength(1);
    expect(pausedAgentDeliveries.has("parent")).toBe(true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
