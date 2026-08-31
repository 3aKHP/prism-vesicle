import { readFile } from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { runPrompt } from "../../../src/core/agent-loop/run";
import { ProcessCompletionScheduler } from "../../../src/core/process/completion-scheduler";
import { getProcessManager, ProcessManager } from "../../../src/core/process/manager";
import { createSessionStore, loadSessionRecords } from "../../../src/core/session/store";
import { resolveProjectHarnessRuntime } from "../../../src/core/harness";
import { eventually } from "../../support/async/eventually";
import { configureTestProviderEnv, createPromptRoot, restoreAgentLoopTestState } from "./fixtures/agent-loop";

beforeEach(configureTestProviderEnv);
afterEach(restoreAgentLoopTestState);

// The idle half of issue #284: a background shell task that completes while
// the parent session sits between turns must wake the parent through a real
// continuation turn. The delivery mirrors the TUI turn controller's contract:
// the packet persists as a `background-process-results` system host packet,
// rides the wire as the envelope user message, and flips the tasks' `notified`
// flag only after the turn succeeded.
describe("agent loop: background idle wake", () => {
  test("delivers an idle background completion through an automatic continuation", async () => {
    const rootDir = await createPromptRoot();
    const manager = getProcessManager(rootDir);
    let requests = 0;
    let deliveryBody: any;
    globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
      requests += 1;
      if (requests === 1) return Response.json({
        id: "idle-start",
        choices: [{ message: { content: "", tool_calls: [{
          id: "call-idle-bg",
          type: "function",
          function: {
            name: "shell_exec",
            arguments: JSON.stringify({ command: process.platform === "win32" ? "Start-Sleep -Milliseconds 100; [Console]::Out.Write('ready')" : "sleep 0.1; printf ready", runInBackground: true }),
          },
        }] } }],
      });
      if (requests === 2) return Response.json({ id: "idle-free", choices: [{ message: { content: "Started; the turn ends here." } }] });
      deliveryBody = JSON.parse(String(init?.body));
      return Response.json({ id: "idle-delivery", choices: [{ message: { content: "Saw the completion." } }] });
    }) as unknown as typeof fetch;

    const first = await runPrompt({
      input: "start it",
      rootDir,
      permission: { mode: "YOLO", shellExecEnabled: true },
    });
    if (first.kind !== "complete") throw new Error(`expected complete, got ${first.kind}`);
    const task = (await manager.list(first.sessionId))[0];
    if (!task) throw new Error("expected a background task");
    const completed = await manager.wait(task.taskId, { timeoutMs: 5_000 });
    expect(completed.status).toBe("completed");

    let deliveries = 0;
    const scheduler = new ProcessCompletionScheduler(manager, async (parentSessionId, tasks, packet) => {
      deliveries += 1;
      const continuation = await runPrompt({
        input: packet,
        rootDir,
        sessionId: parentSessionId,
        messages: [...first.messages, { role: "user", content: packet }],
        inputMetadata: { kind: "background-process-results", taskIds: tasks.map((entry) => entry.taskId).sort() },
        inputRecordRole: "system",
      });
      if (continuation.kind !== "complete") throw new Error("expected complete continuation");
      await manager.markNotified(tasks.map((entry) => entry.taskId));
    }, { debounceMs: 0 });
    await scheduler.notify(first.sessionId);

    expect(deliveries).toBe(1);
    const envelope = deliveryBody.messages.filter((message: any) => message.role === "user").at(-1);
    expect(String(envelope.content).startsWith("<background-shell-results>")).toBe(true);
    expect(String(envelope.content)).toContain('callId="call-idle-bg"');
    const records = await loadSessionRecords(rootDir, first.sessionId);
    const packetRecord = records.filter((record) => record.metadata?.kind === "background-process-results");
    expect(packetRecord).toHaveLength(1);
    expect(packetRecord[0]!.role).toBe("system");
    expect(typeof packetRecord[0]!.metadata?.logicalTurnId).toBe("string");
    expect(packetRecord[0]!.content).toBe(String(envelope.content));
    expect((await manager.get(task.taskId))?.notified).toBe(true);
  });

  test("reuses a pre-persisted background delivery record without appending it twice", async () => {
    const rootDir = await createPromptRoot();
    const session = await createSessionStore(rootDir);
    const harness = await resolveProjectHarnessRuntime(rootDir);
    await session.append({
      role: "system",
      content: "parent",
      metadata: { harness: harness?.harness.identity },
    });
    const envelope = "<background-shell-results>\nHost notification.\n</background-shell-results>";
    const delivery = await session.append({
      role: "system",
      content: envelope,
      metadata: { kind: "background-process-results", taskIds: ["shell-1"] },
    });
    globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { messages?: Array<{ role?: string; content?: string }> };
      expect(body.messages?.at(-1)?.role).toBe("user");
      expect(body.messages?.at(-1)?.content).toBe(envelope);
      return Response.json({ id: "delivery-retry", choices: [{ message: { content: "integrated" } }] });
    }) as unknown as typeof fetch;

    const result = await runPrompt({
      input: envelope,
      rootDir,
      sessionId: session.sessionId,
      messages: [{ role: "user", content: envelope }],
      inputMetadata: { kind: "background-process-results", taskIds: ["shell-1"] },
      inputRecordRole: "system",
      prePersistedInputUuid: delivery.uuid,
    });
    expect(result.kind).toBe("complete");
    const raw = (await readFile(session.sessionPath, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    expect(raw.filter((record) => record.metadata?.kind === "background-process-results")).toHaveLength(1);
    expect(raw.at(-1)?.role).toBe("assistant");
  });

  // The app-level resume path: ProcessManager.subscribe replays every
  // disk-loaded task once initialization resolves, so a task that finished (or
  // was marked interrupted) while the host was down reaches the scheduler
  // through the same terminal-state listener the live completions use.
  test("a disk-loaded terminal task wakes the scheduler through the subscribe replay", async () => {
    const rootDir = await createPromptRoot();
    const bootManager = new ProcessManager(rootDir);
    const task = await bootManager.start({
      command: "printf resumed",
      cwd: ".",
      shell: "posix-sh",
      executablePath: "/bin/sh",
      runtimePolicyVersion: 1,
      timeoutMs: 5_000,
      envPolicyVersion: 1,
      runInBackground: true,
    }, { parentSessionId: "resumed-session", parentToolCallId: "call-resume" });
    await bootManager.wait(task.taskId, { timeoutMs: 5_000 });

    const replayManager = new ProcessManager(rootDir);
    let delivered = 0;
    const scheduler = new ProcessCompletionScheduler(replayManager, async () => { delivered += 1; }, { debounceMs: 0 });
    replayManager.subscribe((event) => {
      if (event.process.status !== "running" && !event.process.notified) {
        void scheduler.notify(event.process.parentSessionId).catch(() => undefined);
      }
    });

    await eventually(() => expect(delivered).toBe(1));
    expect((await replayManager.collectNotifications("resumed-session"))).toHaveLength(1);
  });
});
