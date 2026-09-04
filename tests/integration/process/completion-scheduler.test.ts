import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { ProcessCompletionScheduler, ProcessDeliveryDeferred } from "../../../src/core/process/completion-scheduler";
import { ProcessManager } from "../../../src/core/process/manager";
import { renderBackgroundProcessNotifications } from "../../../src/core/agent-loop/background-process";

// The fixture shells out through an explicit POSIX /bin/sh; probe that the
// interpreter actually spawns rather than merely existing on disk.
const posixShSpawnable = (() => {
  try {
    return Bun.spawnSync(["/bin/sh", "-c", "true"]).exitCode === 0;
  } catch {
    return false;
  }
})();

// The completion scheduler mirrors the SubAgent continuation scheduler's
// debounce/idle/rerun skeleton over the ProcessManager's durable `notified`
// inbox (issue #284): one delivery per batch, no delivery while busy, no
// stranding when a task settles during an in-flight delivery, and never a
// `notified` flip from the scheduler itself.
// Progress updates schedule a 250 ms debounced persist whose unref'd timer can
// outlive the test body; let it fire before the root is removed so the
// fire-and-forget persist chain never races `rm -rf`.
async function settleManager(): Promise<void> {
  await Bun.sleep(400);
}

describe.skipIf(!posixShSpawnable)("process completion scheduler", () => {
  test("coalesces terminal tasks into one packet delivery", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "vesicle-process-scheduler-"));
    try {
      const manager = new ProcessManager(rootDir);
      const first = await startTask(manager, "parent");
      const second = await startTask(manager, "parent");
      await manager.wait(first.taskId, { timeoutMs: 5_000 });
      await manager.wait(second.taskId, { timeoutMs: 5_000 });

      const deliveries: string[] = [];
      const scheduler = new ProcessCompletionScheduler(manager, async (_parent, tasks, packet) => {
        expect(tasks).toHaveLength(2);
        deliveries.push(packet);
        // Delivery owns the flip: the real turn controller marks the batch
        // notified after its turn succeeds, which is what keeps the rerun edge
        // below from re-delivering the same batch.
        await manager.markNotified(tasks.map((task) => task.taskId));
      }, { renderPacket: renderBackgroundProcessNotifications, debounceMs: 0 });
      await Promise.all([scheduler.notify("parent"), scheduler.notify("parent")]);

      expect(deliveries).toHaveLength(1);
      expect(deliveries[0]).toContain(`id="${first.taskId}"`);
      expect(deliveries[0]).toContain(`id="${second.taskId}"`);
      // The flip came from the delivery contract, so the batch is fully drained.
      expect(await manager.collectNotifications("parent")).toHaveLength(0);
      expect((await manager.get(first.taskId))?.notified).toBe(true);
    } finally {
      await settleManager();
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  test("defers delivery while the parent is busy and keeps tasks drainable", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "vesicle-process-scheduler-busy-"));
    try {
      const manager = new ProcessManager(rootDir);
      const task = await startTask(manager, "parent");
      await manager.wait(task.taskId, { timeoutMs: 5_000 });
      let idle = false;
      let delivered = 0;
      const scheduler = new ProcessCompletionScheduler(manager, async () => { delivered += 1; }, {
        renderPacket: renderBackgroundProcessNotifications,
        debounceMs: 0,
        isParentIdle: () => idle,
      });
      await scheduler.notify("parent");
      expect(delivered).toBe(0);
      expect((await manager.get(task.taskId))?.notified).toBe(false);
      idle = true;
      await scheduler.notify("parent");
      expect(delivered).toBe(1);
    } finally {
      await settleManager();
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  test("drains a task that settles while an earlier batch is being delivered", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "vesicle-process-scheduler-rerun-"));
    try {
      const manager = new ProcessManager(rootDir);
      const first = await startTask(manager, "parent");
      await manager.wait(first.taskId, { timeoutMs: 5_000 });
      let releaseFirst: () => void = () => undefined;
      let firstStarted: () => void = () => undefined;
      const started = new Promise<void>((resolve) => { firstStarted = resolve; });
      const deliveries: string[][] = [];
      const scheduler = new ProcessCompletionScheduler(manager, async (_parent, tasks) => {
        deliveries.push(tasks.map((task) => task.taskId));
        if (deliveries.length === 1) {
          firstStarted();
          await new Promise<void>((resolve) => { releaseFirst = resolve; });
        }
        await manager.markNotified(tasks.map((task) => task.taskId));
      }, { renderPacket: renderBackgroundProcessNotifications, debounceMs: 0 });

      const firstDelivery = scheduler.notify("parent");
      await started;
      const second = await startTask(manager, "parent");
      await manager.wait(second.taskId, { timeoutMs: 5_000 });
      const overlappingNotification = scheduler.notify("parent");
      releaseFirst();
      await Promise.all([firstDelivery, overlappingNotification]);

      expect(deliveries).toEqual([[first.taskId], [second.taskId]]);
    } finally {
      await settleManager();
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  test("swallows deferred deliveries and rejects other delivery errors", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "vesicle-process-scheduler-errors-"));
    try {
      const manager = new ProcessManager(rootDir);
      const deferredTask = await startTask(manager, "deferred-parent");
      await manager.wait(deferredTask.taskId, { timeoutMs: 5_000 });
      const deferring = new ProcessCompletionScheduler(manager, async () => {
        throw new ProcessDeliveryDeferred();
      }, { renderPacket: renderBackgroundProcessNotifications, debounceMs: 0 });
      await expect(deferring.notify("deferred-parent")).resolves.toBeUndefined();
      expect((await manager.get(deferredTask.taskId))?.notified).toBe(false);

      const failingTask = await startTask(manager, "failing-parent");
      await manager.wait(failingTask.taskId, { timeoutMs: 5_000 });
      const failing = new ProcessCompletionScheduler(manager, async () => {
        throw new Error("provider unavailable");
      }, { renderPacket: renderBackgroundProcessNotifications, debounceMs: 0 });
      await expect(failing.notify("failing-parent")).rejects.toThrow("provider unavailable");
      expect((await manager.get(failingTask.taskId))?.notified).toBe(false);
    } finally {
      await settleManager();
      await rm(rootDir, { recursive: true, force: true });
    }
  });
});

function startTask(manager: ProcessManager, parentSessionId: string) {
  return manager.start({
    command: "printf done",
    cwd: ".",
    shell: "posix-sh",
    executablePath: "/bin/sh",
    runtimePolicyVersion: 1,
    timeoutMs: 5_000,
    envPolicyVersion: 1,
    runInBackground: true,
  }, { parentSessionId, parentToolCallId: "call-scheduler-test" });
}
