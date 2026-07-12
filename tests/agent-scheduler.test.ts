import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { AgentContinuationScheduler } from "../src/core/agents/scheduler";
import { AgentStore } from "../src/core/agents/store";
import type { AgentMetadata, AgentTerminalResult } from "../src/core/agents/types";

describe("SubAgent continuation scheduler", () => {
  test("coalesces pending child results into one parent delivery", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "vesicle-agent-scheduler-"));
    try {
      const store = new AgentStore(rootDir);
      await enqueue(store, "agent-a", "first");
      await enqueue(store, "agent-b", "second");
      const deliveries: string[] = [];
      const scheduler = new AgentContinuationScheduler(store, async (_parent, entries, packet) => {
        expect(entries).toHaveLength(2);
        deliveries.push(packet);
      }, { debounceMs: 0 });
      await Promise.all([scheduler.notify("parent"), scheduler.notify("parent")]);
      expect(deliveries).toHaveLength(1);
      expect(deliveries[0]).toContain("agent-a");
      expect(deliveries[0]).toContain("second");
      expect(await store.listInbox("parent", "acknowledged")).toHaveLength(2);
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  test("defers delivery while the parent is busy", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "vesicle-agent-scheduler-busy-"));
    try {
      const store = new AgentStore(rootDir);
      await enqueue(store, "agent-a", "result");
      let idle = false;
      let delivered = 0;
      const scheduler = new AgentContinuationScheduler(store, async () => { delivered += 1; }, {
        debounceMs: 0,
        isParentIdle: () => idle,
      });
      await scheduler.notify("parent");
      expect(delivered).toBe(0);
      idle = true;
      await scheduler.notify("parent");
      expect(delivered).toBe(1);
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  test("drains a result that arrives while an earlier batch is being delivered", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "vesicle-agent-scheduler-rerun-"));
    try {
      const store = new AgentStore(rootDir);
      await enqueue(store, "agent-a", "first");
      let releaseFirst: () => void = () => undefined;
      let firstStarted: () => void = () => undefined;
      const started = new Promise<void>((resolve) => { firstStarted = resolve; });
      const deliveries: string[][] = [];
      const scheduler = new AgentContinuationScheduler(store, async (_parent, entries) => {
        deliveries.push(entries.map((entry) => entry.handle));
        if (deliveries.length === 1) {
          firstStarted();
          await new Promise<void>((resolve) => { releaseFirst = resolve; });
        }
      }, { debounceMs: 0 });

      const firstDelivery = scheduler.notify("parent");
      await started;
      await enqueue(store, "agent-b", "second");
      const overlappingNotification = scheduler.notify("parent");
      releaseFirst();
      await Promise.all([firstDelivery, overlappingNotification]);

      expect(deliveries).toEqual([["agent-a"], ["agent-b"]]);
      expect(await store.listInbox("parent", "acknowledged")).toHaveLength(2);
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  test("acknowledges legacy cancelled inbox entries without waking the parent", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "vesicle-agent-scheduler-cancelled-"));
    try {
      const store = new AgentStore(rootDir);
      await enqueue(store, "agent-cancelled", "SubAgent was cancelled.", "cancelled");
      let delivered = 0;
      const scheduler = new AgentContinuationScheduler(store, async () => { delivered += 1; }, { debounceMs: 0 });

      await scheduler.notify("parent");

      expect(delivered).toBe(0);
      expect(await store.listInbox("parent", "pending")).toHaveLength(0);
      expect(await store.listInbox("parent", "acknowledged")).toHaveLength(1);
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });
});

async function enqueue(
  store: AgentStore,
  agentId: string,
  content: string,
  status: AgentTerminalResult["status"] = "completed",
): Promise<void> {
  const now = new Date().toISOString();
  const metadata: AgentMetadata = {
    runId: agentId,
    handle: agentId,
    profileId: "general",
    description: agentId,
    prompt: agentId,
    mode: "background",
    parentSessionId: "parent",
    parentToolCallId: `call-${agentId}`,
    status,
    createdAt: now,
    updatedAt: now,
  };
  const result: AgentTerminalResult = {
    runId: agentId,
    handle: agentId,
    parentSessionId: "parent",
    profileId: "general",
    description: agentId,
    mode: "background",
    status,
    content,
  };
  await store.enqueue(metadata, result);
}
