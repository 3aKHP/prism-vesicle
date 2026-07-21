import { mkdtemp, } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, test } from "bun:test";
import { createSessionStore, loadSessionSnapshot } from "../../../src/core/session/store";

describe("session: process recovery", () => {
  test("restores pending permissions and never replays an indeterminate started process", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "vesicle-session-permission-"));
    const store = await createSessionStore(rootDir, "permission-resume");
    await store.append({ role: "system", content: "system", metadata: { permissionMode: "MOMENTUM" } });
    await store.append({ role: "user", content: "run" });
    const call = { id: "call-shell", name: "shell_exec", arguments: JSON.stringify({ command: "printf hi" }) };
    await store.append({ role: "assistant", content: "", metadata: { toolCalls: [call] } });
    const request = {
      id: "permission-shell",
      sessionId: "permission-resume",
      toolCallId: call.id,
      toolName: call.name,
      arguments: call.arguments,
      permissionClass: "arbitrary_exec",
      mode: "MOMENTUM",
      createdAt: new Date().toISOString(),
      executionPlan: { command: "printf hi", cwd: ".", shell: "posix-sh", timeoutMs: 120000, envPolicyVersion: 1 },
      planHash: "hash",
    };
    await store.append({ role: "system", content: "permission", metadata: { kind: "permission-request", request } });

    const pending = await loadSessionSnapshot(rootDir, store.sessionId, { synthesizeDanglingToolResults: false });
    expect(pending.pendingPermission?.id).toBe(request.id);
    expect(pending.permissionMode).toBe("MOMENTUM");

    await store.append({ role: "system", content: "allowed", metadata: { kind: "permission-resolution", requestId: request.id } });
    await store.append({ role: "system", content: "started", metadata: { kind: "process-started", requestId: request.id, toolCallId: call.id } });
    const recovered = await loadSessionSnapshot(rootDir, store.sessionId, { synthesizeDanglingToolResults: false });
    expect(recovered.pendingPermission).toBeUndefined();
    expect(recovered.messages.at(-1)).toMatchObject({
      role: "tool",
      toolCallId: call.id,
      toolOk: false,
      kind: "process-indeterminate",
    });
    expect(recovered.messages.at(-1)?.content).toContain("not replayed");
  });

  test("restores the terminal state of a completed background shell", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "vesicle-session-background-process-"));
    const store = await createSessionStore(rootDir, "background-process-resume");
    await store.append({ role: "system", content: "system" });
    await store.append({ role: "user", content: "run in background" });
    const call = { id: "call-background", name: "shell_exec", arguments: JSON.stringify({ command: "printf done", runInBackground: true }) };
    await store.append({ role: "assistant", content: "", metadata: { toolCalls: [call] } });
    await store.append({
      role: "tool",
      content: JSON.stringify({ ok: true, result: "started" }),
      metadata: {
        toolCallId: call.id,
        ok: true,
        processEvent: {
          kind: "process_exec",
          taskId: "shell-1",
          executionMode: "background",
          status: "running",
          command: "printf done",
          cwd: ".",
          shell: "posix-sh",
          durationMs: 0,
          timedOut: false,
          aborted: false,
          stdoutBytes: 0,
          stderrBytes: 0,
          stdoutTruncated: false,
          stderrTruncated: false,
        },
      },
    });
    await store.append({
      role: "system",
      content: "completed",
      metadata: {
        kind: "background-process-completed",
        parentToolCallId: call.id,
        processEvent: {
          kind: "process_exec",
          taskId: "shell-1",
          executionMode: "background",
          status: "completed",
          command: "printf done",
          cwd: ".",
          shell: "posix-sh",
          exitCode: 0,
          durationMs: 10,
          timedOut: false,
          aborted: false,
          stdoutBytes: 4,
          stderrBytes: 0,
          stdoutTruncated: false,
          stderrTruncated: false,
          stdoutTail: "done",
          stderrTail: "",
        },
      },
    });

    const snapshot = await loadSessionSnapshot(rootDir, store.sessionId, { synthesizeDanglingToolResults: false });
    expect(snapshot.messages.find((message) => message.toolCallId === call.id)?.toolProcessEvent)
      .toMatchObject({ taskId: "shell-1", status: "completed", stdoutTail: "done" });
  });

  test("does not replay a permission-approved tool when Vesicle stopped before its durable result", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "vesicle-session-permission-resolution-"));
    const store = await createSessionStore(rootDir, "permission-resolution-resume");
    await store.append({ role: "system", content: "system" });
    await store.append({ role: "user", content: "write" });
    const call = { id: "call-write", name: "write_file", arguments: JSON.stringify({ path: "workspace/a.md", content: "a" }) };
    await store.append({ role: "assistant", content: "", metadata: { toolCalls: [call] } });
    const request = {
      id: "permission-write",
      sessionId: store.sessionId,
      toolCallId: call.id,
      toolName: call.name,
      arguments: call.arguments,
      permissionClass: "mutate",
      mode: "MANUAL",
      createdAt: new Date().toISOString(),
    };
    await store.append({ role: "system", content: "permission", metadata: { kind: "permission-request", request } });
    await store.append({ role: "system", content: "allowed", metadata: {
      kind: "permission-resolution",
      requestId: request.id,
      toolCallId: call.id,
      decision: "allow_once",
    } });

    const recovered = await loadSessionSnapshot(rootDir, store.sessionId, { synthesizeDanglingToolResults: false });
    expect(recovered.pendingPermission).toBeUndefined();
    expect(recovered.messages.at(-1)).toMatchObject({
      role: "tool",
      toolCallId: call.id,
      toolOk: false,
      kind: "tool-interrupted",
    });
    expect(recovered.messages.at(-1)?.content).toContain("not replayed");
  });

  test("preserves only the active permission request after a multi-tool crash", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "vesicle-session-permission-multiple-"));
    const store = await createSessionStore(rootDir, "permission-multiple-resume");
    await store.append({ role: "system", content: "system" });
    await store.append({ role: "user", content: "write twice" });
    const active = { id: "call-active", name: "write_file", arguments: "{}" };
    const sibling = { id: "call-sibling", name: "delete_file", arguments: "{}" };
    await store.append({ role: "assistant", content: "", metadata: { toolCalls: [active, sibling] } });
    const request = {
      id: "permission-active",
      sessionId: store.sessionId,
      toolCallId: active.id,
      toolName: active.name,
      arguments: active.arguments,
      permissionClass: "mutate",
      mode: "MANUAL",
      createdAt: new Date().toISOString(),
    };
    await store.append({ role: "system", content: "permission", metadata: { kind: "permission-request", request } });

    const recovered = await loadSessionSnapshot(rootDir, store.sessionId, { synthesizeDanglingToolResults: false });
    expect(recovered.pendingPermission?.toolCallId).toBe(active.id);
    expect(recovered.messages.some((message) => message.toolCallId === active.id)).toBe(false);
    expect(recovered.messages.find((message) => message.toolCallId === sibling.id)).toMatchObject({
      toolOk: false,
      kind: "tool-interrupted",
    });
  });

});
