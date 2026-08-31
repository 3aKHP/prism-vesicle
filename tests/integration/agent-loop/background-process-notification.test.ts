import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { materializeBackgroundProcessNotifications } from "../../../src/core/agent-loop/provider-round";
import { ProcessManager, type BackgroundProcessState } from "../../../src/core/process/manager";
import { createSessionStore, loadSessionMessages, loadSessionRecords } from "../../../src/core/session/store";
import type { VesicleMessage } from "../../../src/providers/shared/types";

// The fixture shells out through an explicit POSIX /bin/sh; probe that the
// interpreter actually spawns rather than merely existing on disk.
const posixShSpawnable = (() => {
  try {
    return Bun.spawnSync(["/bin/sh", "-c", "true"]).exitCode === 0;
  } catch {
    return false;
  }
})();

// The completion packet is a provenance boundary (issue #284): it persists as a
// system-role host record, projects back into a provider-visible user message,
// and the `notified` flip happens only once the record is durable — so a crash
// between the two can never double-deliver.
describe.skipIf(!posixShSpawnable)("materializeBackgroundProcessNotifications", () => {
  test("persists a system host packet matching the pushed message, then flips notified", async () => {
    const root = await mkdtemp(join(tmpdir(), "vesicle-bg-notify-"));
    try {
      const { manager, session, task } = await primeTerminalTask(root);

      const messages: VesicleMessage[] = [];
      await materializeBackgroundProcessNotifications({ rootDir: root, messages, processManager: manager, session });

      const records = await loadSessionRecords(root, session.sessionId);
      const packet = records.filter((record) => record.metadata?.kind === "background-process-results");
      expect(packet).toHaveLength(1);
      expect(packet[0]!.role).toBe("system");
      expect(packet[0]!.metadata?.taskIds).toEqual([task.taskId]);
      expect(messages).toHaveLength(1);
      expect(messages[0]).toMatchObject({ role: "user", content: packet[0]!.content });
      expect((await manager.get(task.taskId))?.notified).toBe(true);

      const resumed = await loadSessionMessages(root, session.sessionId);
      expect(resumed).toHaveLength(1);
      expect(resumed[0]).toMatchObject({ role: "user", kind: "background-process-results", content: packet[0]!.content });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("replaying the crash window does not double-deliver a projected record", async () => {
    const root = await mkdtemp(join(tmpdir(), "vesicle-bg-replay-"));
    try {
      const { manager, session, task } = await primeTerminalTask(root);
      await materializeBackgroundProcessNotifications({ rootDir: root, messages: [], processManager: manager, session });

      // Simulate a crash between the record append and the `notified` flip by
      // resetting the flag on disk and reloading through a fresh manager.
      const taskPath = join(root, ".vesicle", "processes", `${task.taskId}.json`);
      const state = JSON.parse(await readFile(taskPath, "utf8")) as BackgroundProcessState;
      await writeFile(taskPath, `${JSON.stringify({ ...state, notified: false }, null, 2)}\n`, "utf8");
      const replayManager = new ProcessManager(root);

      const replayMessages: VesicleMessage[] = [];
      await materializeBackgroundProcessNotifications({ rootDir: root, messages: replayMessages, processManager: replayManager, session });

      const records = await loadSessionRecords(root, session.sessionId);
      expect(records.filter((record) => record.metadata?.kind === "background-process-results")).toHaveLength(1);
      expect(replayMessages).toHaveLength(0);
      expect((await replayManager.get(task.taskId))?.notified).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("a legacy user-role delivery record still suppresses re-append", async () => {
    const root = await mkdtemp(join(tmpdir(), "vesicle-bg-legacy-"));
    try {
      const { manager, session, task } = await primeTerminalTask(root);
      await session.append({
        role: "user",
        content: "Background shell updates:\n\n[background_shell]\ntaskId: legacy\n[/background_shell]",
        metadata: { kind: "background-process-results", taskIds: [task.taskId] },
      });

      const messages: VesicleMessage[] = [];
      await materializeBackgroundProcessNotifications({ rootDir: root, messages, processManager: manager, session });

      const records = await loadSessionRecords(root, session.sessionId);
      const packet = records.filter((record) => record.metadata?.kind === "background-process-results");
      expect(packet).toHaveLength(1);
      expect(packet[0]!.role).toBe("user");
      expect(messages).toHaveLength(0);
      expect((await manager.get(task.taskId))?.notified).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

async function primeTerminalTask(root: string): Promise<{ manager: ProcessManager; session: Awaited<ReturnType<typeof createSessionStore>>; task: BackgroundProcessState }> {
  const session = await createSessionStore(root, "bg-notify-session");
  const manager = new ProcessManager(root);
  const task = await manager.start({
    command: "printf done",
    cwd: ".",
    shell: "posix-sh",
    executablePath: "/bin/sh",
    runtimePolicyVersion: 1,
    timeoutMs: 5_000,
    envPolicyVersion: 1,
    runInBackground: true,
  }, { parentSessionId: session.sessionId, parentToolCallId: "call-bg" });
  await manager.wait(task.taskId, { timeoutMs: 5_000 });
  return { manager, session, task };
}
