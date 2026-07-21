import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import { AgentDeliveryDeferred } from "../src/core/agents/scheduler";
import type { AgentInboxEntry } from "../src/core/agents/types";
import { createSessionStore } from "../src/core/session/store";
import type { VesicleMessage } from "../src/providers/shared/types";
import { createTurnController } from "../src/tui/turn-controller";

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
    let queuedReady = false;
    let queuedAfterInterrupt = false;
    let conversation: VesicleMessage[] = [{ role: "user", content: "start" }];
    let messages: unknown[] = [];
    let agentCards: unknown[] = [];
    const pausedAgentDeliveries = new Set<string>();
    const controller = createTurnController({
      rootDir: root,
      busy: () => busy,
      setBusy: (value: boolean | ((current: boolean) => boolean)) => {
        busy = typeof value === "function" ? value(busy) : value;
        return busy;
      },
      setQueuedInputReady: (value: boolean | ((current: boolean) => boolean)) => {
        queuedReady = typeof value === "function" ? value(queuedReady) : value;
        return queuedReady;
      },
      queuedSendAfterInterrupt: () => queuedAfterInterrupt,
      setQueuedSendAfterInterrupt: (value: boolean | ((current: boolean) => boolean)) => {
        queuedAfterInterrupt = typeof value === "function" ? value(queuedAfterInterrupt) : value;
        return queuedAfterInterrupt;
      },
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
        queuedAfterInterrupt = true;
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
    expect(queuedReady).toBe(true);
    expect(queuedAfterInterrupt).toBe(false);
    expect(pausedAgentDeliveries.has("parent")).toBe(true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
