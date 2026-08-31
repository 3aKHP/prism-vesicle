import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import { materializeBackgroundProcessNotifications } from "../../../src/core/agent-loop/provider-round";
import { ProcessManager } from "../../../src/core/process/manager";
import { createSessionStore, loadSessionRecords, FAILED_TURN_KIND } from "../../../src/core/session/store";
import type { VesicleMessage } from "../../../src/providers/shared/types";
import { createTurnController } from "../../../src/tui/turn-controller";

// The fixture shells out through an explicit POSIX /bin/sh; probe that the
// interpreter actually spawns rather than merely existing on disk.
const posixShSpawnable = (() => {
  try {
    return Bun.spawnSync(["/bin/sh", "-c", "true"]).exitCode === 0;
  } catch {
    return false;
  }
})();

// The loop's boundary materialize flips `notified` before the provider
// request, so a failed or interrupted idle delivery must re-arm the batch
// itself: mark the failed turn, rebuild the in-memory conversation from the
// durable projection, and reset `notified` so the next provider boundary
// re-delivers the packet without a second durable record (independent CR
// finding on the first cut — the packet used to vanish from the live
// session's wire while the UI promised a retry).
test.skipIf(!posixShSpawnable)("a failed idle delivery re-arms the batch and retries with the next boundary", async () => {
  const root = await mkdtemp(join(tmpdir(), "vesicle-tui-bg-delivery-"));
  try {
    const store = await createSessionStore(root, "bg-delivery-session");
    await store.append({ role: "system", content: "prompt", metadata: { engine: "etl" } });
    await store.append({ role: "user", content: "run the build" });
    await store.append({ role: "assistant", content: "started in the background" });

    const manager = new ProcessManager(root);
    const started = await manager.start({
      command: "printf done",
      cwd: ".",
      shell: "posix-sh",
      executablePath: "/bin/sh",
      runtimePolicyVersion: 1,
      timeoutMs: 5_000,
      envPolicyVersion: 1,
      runInBackground: true,
    }, { parentSessionId: store.sessionId, parentToolCallId: "call-bg" });
    await manager.wait(started.taskId, { timeoutMs: 5_000 });
    const task = (await manager.get(started.taskId))!;
    const packet = "<background-shell-results>\nHost notification: re-deliver me.\n</background-shell-results>";

    let conversation: VesicleMessage[] = [];
    const controller = createTurnController({
      rootDir: root,
      busy: () => false,
      setBusy: () => false,
      sessionId: () => store.sessionId,
      conversation: () => conversation,
      setConversation: (value: VesicleMessage[] | ((current: VesicleMessage[]) => VesicleMessage[])) => {
        conversation = typeof value === "function" ? value(conversation) : value;
        return conversation;
      },
      setMessages: () => undefined,
      providerConfigReady: () => true,
      permissionSettingsReady: () => true,
      pendingGate: () => null,
      pendingEngineSwitch: () => null,
      pendingUserQuestion: () => null,
      pendingPermission: () => null,
      pendingQualityDecision: () => null,
      pendingChildPermission: () => null,
      pausedAgentDeliveries: new Set<string>(),
      markProcessNotified: (taskIds: string[]) => manager.markNotified(taskIds),
      resetProcessNotified: (taskIds: string[]) => manager.resetNotified(taskIds),
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
      // The delivery turn's first boundary made the packet durable and
      // flipped `notified` before the provider request failed.
      runCancellable: async () => {
        await store.append({ role: "system", content: packet, metadata: { kind: "background-process-results", taskIds: [task.taskId] } });
        await manager.markNotified([task.taskId]);
        throw new Error("provider HTTP 401");
      },
    } as any);

    await expect(controller.deliverBackgroundProcessResults(store.sessionId, [task], packet)).rejects.toThrow("provider HTTP 401");

    const sessionPath = join(root, ".vesicle", "sessions", `${store.sessionId}.jsonl`);
    const raw = await readFile(sessionPath, "utf8");
    expect(raw.includes(`"kind":"${FAILED_TURN_KIND}"`)).toBe(true);
    // The in-memory conversation was rebuilt from the durable projection,
    // which dropped the failed delivery's packet with the turn.
    expect(conversation.map((message) => message.role)).toEqual(["user", "assistant"]);
    expect((await manager.get(task.taskId))?.notified).toBe(false);

    // The re-armed batch rides the next turn's boundary: pushed onto the wire
    // through the projection-dropped path, without a second durable record.
    const messages: VesicleMessage[] = [];
    await materializeBackgroundProcessNotifications({ rootDir: root, messages, processManager: manager, session: store });
    expect(messages).toHaveLength(1);
    expect(String(messages[0]!.content).startsWith("<background-shell-results>")).toBe(true);
    expect(String(messages[0]!.content)).toContain(`id="${task.taskId}"`);
    const records = await loadSessionRecords(root, store.sessionId);
    expect(records.filter((record) => record.metadata?.kind === "background-process-results")).toHaveLength(1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
