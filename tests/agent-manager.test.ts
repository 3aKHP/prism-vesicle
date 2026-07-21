import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { describe, expect, test } from "bun:test";
import { AgentManager } from "../src/core/agents/manager";
import { AgentStore, legacyAgentHandle } from "../src/core/agents/store";
import type { AgentRunContext, AgentSpec } from "../src/core/agents/types";
import { createSessionStore, loadSessionSnapshot } from "../src/core/session/store";

describe("SubAgent manager", () => {
  test("runs children concurrently up to the configured slot count", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "vesicle-agent-manager-"));
    let active = 0;
    let peak = 0;
    const releases: Array<() => void> = [];
    try {
      const manager = new AgentManager(new AgentStore(rootDir), async ({ runId }) => {
        active += 1;
        peak = Math.max(peak, active);
        await new Promise<void>((resolve) => releases.push(resolve));
        active -= 1;
        return { content: runId };
      }, { maxConcurrent: 2 });

      const agents = await Promise.all([manager.spawn(spec("a")), manager.spawn(spec("b")), manager.spawn(spec("c"))]);
      await eventually(() => expect(peak).toBe(2));
      releases.shift()?.();
      await eventually(() => expect(releases.length).toBe(2));
      releases.splice(0).forEach((release) => {
        release();
      });
      const results = await Promise.all(agents.map((agent) => agent.completion));
      expect(results.every((result) => result.status === "completed")).toBe(true);
      expect(peak).toBe(2);
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  test("allocates short profile handles atomically and continues ordinals after restart", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "vesicle-agent-handles-"));
    try {
      const store = new AgentStore(rootDir);
      const firstManager = new AgentManager(store, async () => ({ content: "done" }));
      const firstWave = await Promise.all([
        firstManager.spawn({ ...spec("one"), profileId: "explore" }),
        firstManager.spawn({ ...spec("two"), profileId: "explore" }),
        firstManager.spawn({ ...spec("plan"), profileId: "plan" }),
      ]);
      expect(firstWave.map((agent) => agent.handle)).toEqual(["explore-1", "explore-2", "plan-1"]);
      await Promise.all(firstWave.map((agent) => agent.completion));

      const resumedManager = new AgentManager(store, async () => ({ content: "done" }));
      const next = await resumedManager.spawn({ ...spec("three"), profileId: "explore" });
      expect(next.handle).toBe("explore-3");
      expect(next.runId).toMatch(/^run_[0-9a-f-]{36}$/);
      await next.completion;
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  test("loads legacy UUID metadata through a stable compatibility handle", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "vesicle-agent-legacy-id-"));
    try {
      const directory = join(rootDir, ".vesicle", "subagents");
      await mkdir(directory, { recursive: true });
      const legacyId = "agent_550e8400-e29b-41d4-a716-446655440000";
      await writeFile(join(directory, `${legacyId}.json`), JSON.stringify({
        agentId: legacyId,
        profileId: "explore",
        description: "Legacy exploration",
        prompt: "Explore.",
        mode: "background",
        parentSessionId: "parent",
        parentToolCallId: "call-legacy",
        status: "completed",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:01.000Z",
        result: "done",
      }), "utf8");
      const inboxDirectory = join(directory, "inbox");
      await mkdir(inboxDirectory, { recursive: true });
      const inboxPath = join(inboxDirectory, `${createHash("sha256").update("parent").digest("hex")}.jsonl`);
      await writeFile(inboxPath, `${JSON.stringify({
        type: "enqueued",
        ts: "2026-01-01T00:00:01.000Z",
        entry: {
          inboxId: "inbox-legacy",
          parentSessionId: "parent",
          agentId: legacyId,
          profileId: "explore",
          description: "Legacy exploration",
          status: "completed",
          content: "done",
          createdAt: "2026-01-01T00:00:01.000Z",
          state: "pending",
        },
      })}\n`, "utf8");

      const store = new AgentStore(rootDir);
      const legacy = await store.load(legacyId);
      expect(legacy).toMatchObject({ runId: legacyId, handle: "explore-550e8400" });
      expect(await store.resolveReference("parent", "explore-550e8400")).toMatchObject({ runId: legacyId });
      expect(await store.listInbox("parent")).toEqual([expect.objectContaining({
        runId: legacyId,
        handle: "explore-550e8400",
      })]);
      expect(legacyAgentHandle("explore", "run_550e8400-e29b-41d4-a716-446655440000")).toBe("explore-550e8400");
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  test("crash recovery closes foreground tool calls and only enqueues background failures", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "vesicle-agent-recovery-"));
    try {
      const parent = await createSessionStore(rootDir, "parent");
      await parent.append({ role: "system", content: "parent" });
      await parent.append({
        role: "assistant",
        content: "Delegating.",
        metadata: {
          toolCalls: [{ id: "call-foreground", name: "spawn_agent", arguments: "{}" }],
        },
      });
      const store = new AgentStore(rootDir);
      const now = new Date().toISOString();
      await store.save({
        ...spec("foreground-recovery"),
        runId: "run_foreground",
        handle: "general-1",
        parentToolCallId: "call-foreground",
        status: "running",
        createdAt: now,
        updatedAt: now,
      });
      await store.save({
        ...spec("background-recovery", "background"),
        runId: "run_background",
        handle: "general-2",
        parentToolCallId: "call-background",
        status: "created",
        createdAt: now,
        updatedAt: now,
      });

      const recovered = await store.recoverInterrupted();
      expect(recovered).toHaveLength(2);
      const snapshot = await loadSessionSnapshot(rootDir, "parent", { synthesizeDanglingToolResults: false });
      expect(snapshot.messages.at(-1)).toMatchObject({
        role: "tool",
        toolCallId: "call-foreground",
        toolOk: false,
        kind: "subagent-result",
      });
      const recoveredTool = JSON.parse(snapshot.messages.at(-1)?.content ?? "{}") as { result?: string };
      expect(JSON.parse(recoveredTool.result ?? "{}")).toMatchObject({
        agent_id: "general-1",
        status: "failed",
        mode: "foreground",
      });
      expect(await store.listInbox("parent", "pending")).toEqual([
        expect.objectContaining({ runId: "run_background", status: "failed" }),
      ]);
      expect(await store.recoverInterrupted()).toHaveLength(0);
      const afterRetry = await loadSessionSnapshot(rootDir, "parent", { synthesizeDanglingToolResults: false });
      expect(afterRetry.messages.filter((message) => message.role === "tool" && message.toolCallId === "call-foreground")).toHaveLength(1);
      expect((await store.listInbox("parent")).filter((entry) => entry.runId === "run_background")).toHaveLength(1);
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  test("crash recovery reconciles terminal metadata with missing parent outputs", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "vesicle-agent-terminal-recovery-"));
    try {
      const parent = await createSessionStore(rootDir, "parent");
      await parent.append({ role: "system", content: "parent" });
      await parent.append({
        role: "assistant",
        content: "Delegating.",
        metadata: {
          toolCalls: [
            { id: "call-completed-foreground", name: "spawn_agent", arguments: "{}" },
            { id: "call-completed-background", name: "spawn_agent", arguments: "{}" },
          ],
        },
      });
      const store = new AgentStore(rootDir);
      const now = new Date().toISOString();
      await store.save({
        ...spec("completed-foreground"),
        runId: "run_completed_foreground",
        handle: "general-1",
        parentToolCallId: "call-completed-foreground",
        status: "completed",
        result: "foreground result",
        createdAt: now,
        updatedAt: now,
      });
      await store.save({
        ...spec("completed-background", "background"),
        runId: "run_completed_background",
        handle: "general-2",
        parentToolCallId: "call-completed-background",
        status: "completed",
        result: "background result",
        createdAt: now,
        updatedAt: now,
      });

      expect(await store.recoverInterrupted()).toHaveLength(2);
      const snapshot = await loadSessionSnapshot(rootDir, "parent", { synthesizeDanglingToolResults: false });
      const foregroundResults = snapshot.messages.filter((message) => message.role === "tool" && message.toolCallId === "call-completed-foreground");
      expect(foregroundResults).toHaveLength(1);
      expect(foregroundResults[0]?.toolOk).toBe(true);
      expect(JSON.parse(foregroundResults[0]?.content ?? "{}")).toMatchObject({ ok: true });
      expect(await store.listInbox("parent", "pending")).toEqual([
        expect.objectContaining({ runId: "run_completed_background", content: "background result" }),
      ]);
      expect(await store.recoverInterrupted()).toHaveLength(0);
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  test("persists background completion to the parent inbox", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "vesicle-agent-inbox-"));
    try {
      const store = new AgentStore(rootDir);
      const manager = new AgentManager(store, async () => ({ content: "evidence" }));
      const child = await manager.spawn(spec("background", "background"));
      expect((await child.completion).status).toBe("completed");
      const pending = await store.listInbox("parent", "pending");
      expect(pending).toHaveLength(1);
      expect(pending[0]).toMatchObject({ runId: child.runId, handle: "general-1", content: "evidence", state: "pending" });
      await store.markInbox("parent", [pending[0]!.inboxId], "delivered");
      expect(await store.listInbox("parent", "pending")).toHaveLength(0);
      expect(await store.listInbox("parent", "delivered")).toHaveLength(1);
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  test("persists the child session link before the child reaches a terminal state", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "vesicle-agent-child-session-"));
    let release: () => void = () => undefined;
    let registered: () => void = () => undefined;
    const childRegistered = new Promise<void>((resolve) => { registered = resolve; });
    try {
      const store = new AgentStore(rootDir);
      const manager = new AgentManager(store, async (context) => {
        await context.registerChildSession("child-session-id");
        registered();
        await new Promise<void>((resolve) => { release = resolve; });
        return { content: "done", childSessionId: "child-session-id" };
      });
      const child = await manager.spawn(spec("linked-child"));
      await childRegistered;
      expect(await store.load(child.runId)).toMatchObject({
        status: "running",
        childSessionId: "child-session-id",
      });
      release();
      expect(await child.completion).toMatchObject({ status: "completed", childSessionId: "child-session-id" });
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  test("interrupts an active child and records cancellation", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "vesicle-agent-cancel-"));
    try {
      const manager = new AgentManager(new AgentStore(rootDir), waitForAbort);
      const child = await manager.spawn(spec("cancel"));
      await eventually(() => expect(manager.listActive()[0]?.status).toBe("running"));
      expect(await manager.interrupt(child.handle, "parent")).toBe(true);
      expect(await child.completion).toMatchObject({ status: "cancelled" });
      expect((await manager.wait(child.handle, "parent"))?.status).toBe("cancelled");
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  test("rejects message and interrupt controls after terminal persistence", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "vesicle-agent-terminal-control-"));
    let lateMessage: boolean | undefined;
    let lateInterrupt: Promise<boolean> | undefined;
    try {
      let manager: AgentManager;
      manager = new AgentManager(new AgentStore(rootDir), async () => ({ content: "done" }), {
        onEvent: (event) => {
          if (event.type !== "agent_completed") return;
          lateMessage = manager.sendMessage(event.result.handle, "too late", event.result.parentSessionId);
          lateInterrupt = manager.interrupt(event.result.handle, event.result.parentSessionId);
        },
      });
      const child = await manager.spawn(spec("terminal-control"));
      expect(await child.completion).toMatchObject({ status: "completed" });
      expect(lateMessage).toBe(false);
      expect(await lateInterrupt).toBe(false);
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  test("does not enqueue a cancelled background child for parent continuation", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "vesicle-agent-cancel-background-"));
    try {
      const store = new AgentStore(rootDir);
      const manager = new AgentManager(store, waitForAbort);
      const child = await manager.spawn(spec("cancel-background", "background"));
      await eventually(() => expect(manager.listActive()[0]?.status).toBe("running"));
      expect(await manager.interrupt(child.handle, "parent")).toBe(true);
      expect(await child.completion).toMatchObject({ status: "cancelled" });
      expect(await store.load(child.runId)).toMatchObject({ status: "cancelled" });
      expect(await store.listInbox("parent")).toHaveLength(0);
      expect((await manager.wait(child.handle, "parent"))?.status).toBe("cancelled");
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  test("scopes duplicate short handles to their parent session", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "vesicle-agent-handle-scope-"));
    try {
      const manager = new AgentManager(new AgentStore(rootDir), waitForAbort);
      const first = await manager.spawn({ ...spec("first"), profileId: "explore", parentSessionId: "parent-a" });
      const second = await manager.spawn({ ...spec("second"), profileId: "explore", parentSessionId: "parent-b" });
      expect(first.handle).toBe("explore-1");
      expect(second.handle).toBe("explore-1");
      await eventually(() => expect(manager.listActive()).toHaveLength(2));
      expect(await manager.interrupt("explore-1", "parent-b")).toBe(true);
      expect(await second.completion).toMatchObject({ status: "cancelled" });
      expect(manager.listActive("parent-a")).toHaveLength(1);
      expect(await manager.interrupt("explore-1", "parent-a")).toBe(true);
      expect(await first.completion).toMatchObject({ status: "cancelled" });
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  test("interrupts a queued child without releasing another child's slot", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "vesicle-agent-cancel-queued-"));
    let releaseFirst: () => void = () => undefined;
    let firstStarted: () => void = () => undefined;
    const started = new Promise<void>((resolve) => { firstStarted = resolve; });
    try {
      const manager = new AgentManager(new AgentStore(rootDir), async ({ spec: childSpec }) => {
        if (childSpec.description === "first") {
          firstStarted();
          await new Promise<void>((resolve) => { releaseFirst = resolve; });
        }
        return { content: childSpec.description };
      }, { maxConcurrent: 1 });
      const first = await manager.spawn(spec("first"));
      await started;
      const queued = await manager.spawn(spec("queued"));
      await eventually(() => expect(manager.listActive().find((agent) => agent.runId === queued.runId)?.status).toBe("created"));
      expect(await manager.interrupt(queued.handle, "parent")).toBe(true);
      expect(await queued.completion).toMatchObject({ status: "cancelled" });
      expect(manager.listActive().find((agent) => agent.runId === first.runId)?.status).toBe("running");
      releaseFirst();
      expect(await first.completion).toMatchObject({ status: "completed" });
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  test("parent turn cancellation propagates to foreground but not background children", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "vesicle-agent-parent-cancel-"));
    try {
      const manager = new AgentManager(new AgentStore(rootDir), waitForAbort);
      const foregroundParent = new AbortController();
      const backgroundParent = new AbortController();
      const baseInvocation = {
        rootDir,
        parentEngine: "etl" as const,
        parentToolDefinitions: [],
        parentSystemPrompt: "parent",
        parentMessages: [],
      };
      const foreground = await manager.spawn(spec("foreground"), { ...baseInvocation, parentSignal: foregroundParent.signal });
      const background = await manager.spawn(spec("background", "background"), { ...baseInvocation, parentSignal: backgroundParent.signal });
      await eventually(() => expect(manager.listActive()).toHaveLength(2));
      foregroundParent.abort();
      backgroundParent.abort();
      expect(await foreground.completion).toMatchObject({ status: "cancelled" });
      expect(manager.listActive().some((agent) => agent.runId === background.runId)).toBe(true);
      await manager.interrupt(background.handle, "parent");
      expect(await background.completion).toMatchObject({ status: "cancelled" });
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  test("rejects conflicting paths claimed by parallel writers", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "vesicle-agent-write-conflict-"));
    let releaseFirst: () => void = () => undefined;
    let firstClaimed = false;
    try {
      const manager = new AgentManager(new AgentStore(rootDir), async (context) => {
        await context.claimMutation(["novels/chapter-01.md"]);
        if (!firstClaimed) {
          firstClaimed = true;
          await new Promise<void>((resolve) => { releaseFirst = resolve; });
        }
        return { content: "written" };
      }, { maxConcurrent: 2 });
      const first = await manager.spawn(spec("writer-a"));
      await eventually(() => expect(firstClaimed).toBe(true));
      const second = await manager.spawn(spec("writer-b"));
      const conflict = await second.completion;
      expect(conflict.status).toBe("failed");
      expect(conflict.content.includes("write conflict")).toBe(true);
      expect(conflict.content.includes("general-1")).toBe(true);
      expect(conflict.content.includes("run_")).toBe(false);
      releaseFirst();
      expect(await first.completion).toMatchObject({ status: "completed" });
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  test("rejects ancestor and descendant mutations while a background child owns a directory", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "vesicle-agent-parent-write-conflict-"));
    let releaseChild: () => void = () => undefined;
    let childClaimed: () => void = () => undefined;
    const claimed = new Promise<void>((resolve) => { childClaimed = resolve; });
    try {
      const manager = new AgentManager(new AgentStore(rootDir), async (context) => {
        await context.claimMutation(["novels/volume-01"]);
        childClaimed();
        await new Promise<void>((resolve) => { releaseChild = resolve; });
        return { content: "written" };
      });
      const child = await manager.spawn(spec("background-writer", "background"));
      await claimed;
      await expect(manager.claimHostMutation("parent-call", ["novels/volume-01/chapter-01.md"]))
        .rejects.toThrow("write conflict");
      await expect(manager.claimHostMutation("parent-call", ["novels"]))
        .rejects.toThrow("write conflict");
      releaseChild();
      expect(await child.completion).toMatchObject({ status: "completed" });
      await expect(manager.claimHostMutation("parent-call", ["novels/volume-01/chapter-01.md"]))
        .resolves.toBeUndefined();
      manager.releaseHostMutations("parent-call");
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });
});

function spec(description: string, mode: AgentSpec["mode"] = "foreground"): AgentSpec {
  return {
    profileId: "general",
    description,
    prompt: description,
    mode,
    parentSessionId: "parent",
    parentToolCallId: `call-${description}`,
  };
}

async function waitForAbort({ signal }: AgentRunContext): Promise<never> {
  return new Promise((_, reject) => {
    if (signal.aborted) return reject(signal.reason);
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  });
}

async function eventually(assertion: () => void): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      assertion();
      return;
    } catch {
      await Bun.sleep(5);
    }
  }
  assertion();
}
