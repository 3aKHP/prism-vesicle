import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { resolvePermission, runPrompt } from "../../../src/core/agent-loop/run";
import { loadSessionSnapshot, loadSessionRecords, } from "../../../src/core/session/store";
import { executionPlanHash } from "../../../src/core/tools/shell";
import { listRewindPoints } from "../../../src/core/rewind/service";
import { getProcessManager } from "../../../src/core/process/manager";
import { configureTestProviderEnv, createPromptRoot, restoreAgentLoopTestState, } from "./fixtures/agent-loop";

beforeEach(configureTestProviderEnv);
afterEach(restoreAgentLoopTestState);

describe("agent loop: shell permission", () => {
  test.skipIf(process.platform === "win32")("pauses shell_exec for MOMENTUM and continues after exact allow-once approval", async () => {
    const rootDir = await createPromptRoot();
    let requests = 0;
    globalThis.fetch = (async () => {
      requests += 1;
      if (requests === 1) {
        return Response.json({
          id: "chat-permission-1",
          choices: [{ message: {
            content: "",
            tool_calls: [{
              id: "call-shell",
              type: "function",
              function: { name: "shell_exec", arguments: JSON.stringify({ command: "printf approved" }) },
            }],
          } }],
        });
      }
      return Response.json({ id: "chat-permission-2", choices: [{ message: { content: "done" } }] });
    }) as unknown as typeof fetch;

    const paused = await runPrompt({
      input: "run it",
      rootDir,
      permission: { mode: "MOMENTUM", shellExecEnabled: true },
    });
    expect(paused.kind).toBe("needs_permission");
    if (paused.kind !== "needs_permission") throw new Error("expected permission pause");
    expect(paused.request.executionPlan?.command).toBe("printf approved");
    expect(requests).toBe(1);

    const events: Array<{ type: string; name?: string; callId?: string; arguments?: string }> = [];
    const resumed = await resolvePermission({
      engine: "etl",
      rootDir,
      sessionId: paused.sessionId,
      messages: paused.messages,
      request: paused.request,
      remainingToolCalls: paused.remainingToolCalls,
      resolution: { decision: "allow_once", resolvedAt: new Date().toISOString() },
      permission: { mode: "MOMENTUM", shellExecEnabled: true },
      onEvent: (event) => events.push(event as { type: string }),
    });
    expect(resumed.kind).toBe("complete");
    expect(requests).toBe(2);
    // The approved path emits the gated call's tool_call before its result so
    // the transcript `●` card pairs with the footnote like a normal round (#268).
    const callIndex = events.findIndex((event) => event.type === "tool_call");
    const resultIndex = events.findIndex((event) => event.type === "tool_result");
    expect(callIndex).toBeGreaterThanOrEqual(0);
    expect(events[callIndex]).toMatchObject({
      name: "shell_exec",
      callId: "call-shell",
      arguments: JSON.stringify({ command: "printf approved" }),
    });
    expect(resultIndex).toBeGreaterThan(callIndex);
    const records = await loadSessionRecords(rootDir, paused.sessionId);
    expect(records.some((record) => record.metadata?.kind === "permission-request")).toBe(true);
    expect(records.some((record) => record.metadata?.kind === "permission-resolution")).toBe(true);
    expect(records.some((record) => record.metadata?.kind === "process-started")).toBe(true);
    expect(records.some((record) => (record.metadata?.processEvent as { kind?: string } | undefined)?.kind === "process_exec")).toBe(true);
  });

  test.skipIf(process.platform === "win32")("does not execute a resumed shell permission after the capability is disabled", async () => {
    const rootDir = await createPromptRoot();
    globalThis.fetch = (async () => Response.json({
      id: "chat-permission-disabled",
      choices: [{ message: { content: "", tool_calls: [{
        id: "call-shell-disabled",
        type: "function",
        function: { name: "shell_exec", arguments: JSON.stringify({ command: "touch workspace/should-not-exist" }) },
      }] } }],
    })) as unknown as typeof fetch;

    const paused = await runPrompt({
      input: "run it",
      rootDir,
      permission: { mode: "MOMENTUM", shellExecEnabled: true },
    });
    expect(paused.kind).toBe("needs_permission");
    if (paused.kind !== "needs_permission") throw new Error("expected permission pause");

    let followUpRequests = 0;
    globalThis.fetch = (async () => {
      followUpRequests += 1;
      return Response.json({ id: "chat-permission-disabled-result", choices: [{ message: { content: "not run" } }] });
    }) as unknown as typeof fetch;
    const events: Array<{ type: string; name?: string; callId?: string }> = [];
    const resumed = await resolvePermission({
      engine: "etl",
      rootDir,
      sessionId: paused.sessionId,
      messages: paused.messages,
      request: paused.request,
      remainingToolCalls: paused.remainingToolCalls,
      resolution: { decision: "allow_once", resolvedAt: new Date().toISOString() },
      permission: { mode: "MOMENTUM", shellExecEnabled: false },
      onEvent: (event) => events.push(event as { type: string }),
    });
    expect(resumed.kind).toBe("complete");
    expect(followUpRequests).toBe(1);
    expect(await Bun.file(join(rootDir, "workspace", "should-not-exist")).exists()).toBe(false);
    // Even the capability-gone branch emits the call first: the transcript
    // shows what was asked before the not-executed result (#268).
    expect(events.find((event) => event.type === "tool_call")).toMatchObject({
      name: "shell_exec",
      callId: "call-shell-disabled",
    });
    expect(events.some((event) => event.type === "tool_result")).toBe(true);
    const records = await loadSessionRecords(rootDir, paused.sessionId);
    expect(records.find((record) => record.metadata?.toolCallId === "call-shell-disabled" && record.role === "tool")?.content)
      .toContain("no longer in the current Engine's effective tool surface");
  });

  test.skipIf(process.platform === "win32")("rejects a persisted shell plan that no longer matches its approval hash", async () => {
    const rootDir = await createPromptRoot();
    globalThis.fetch = (async () => Response.json({
      id: "chat-permission-tamper",
      choices: [{ message: { content: "", tool_calls: [{
        id: "call-shell-tamper",
        type: "function",
        function: { name: "shell_exec", arguments: JSON.stringify({ command: "touch workspace/should-not-exist" }) },
      }] } }],
    })) as unknown as typeof fetch;
    const paused = await runPrompt({
      input: "run it",
      rootDir,
      permission: { mode: "MOMENTUM", shellExecEnabled: true },
    });
    if (paused.kind !== "needs_permission" || !paused.request.executionPlan) throw new Error("expected shell permission pause");
    const tampered = {
      ...paused.request,
      executionPlan: { ...paused.request.executionPlan, executablePath: "/tmp/not-approved-shell" },
    };

    await expect(resolvePermission({
      engine: "etl",
      rootDir,
      sessionId: paused.sessionId,
      messages: paused.messages,
      request: tampered,
      remainingToolCalls: paused.remainingToolCalls,
      resolution: { decision: "allow_once", resolvedAt: new Date().toISOString() },
      permission: { mode: "MOMENTUM", shellExecEnabled: true },
    })).rejects.toThrow("stored shell execution plan does not match");
    expect(await Bun.file(join(rootDir, "workspace", "should-not-exist")).exists()).toBe(false);
  });

  test.skipIf(process.platform === "win32")("restores an old environment-policy approval but only permits rejection", async () => {
    const rootDir = await createPromptRoot();
    globalThis.fetch = (async () => Response.json({
      id: "chat-old-env-policy",
      choices: [{ message: { content: "", tool_calls: [{
        id: "call-old-env-policy",
        type: "function",
        function: { name: "shell_exec", arguments: JSON.stringify({ command: "touch workspace/should-not-exist" }) },
      }] } }],
    })) as unknown as typeof fetch;
    const paused = await runPrompt({
      input: "run it",
      rootDir,
      permission: { mode: "MOMENTUM", shellExecEnabled: true },
    });
    if (paused.kind !== "needs_permission" || !paused.request.executionPlan) throw new Error("expected shell permission pause");

    // Model the on-disk session from before the environment-policy upgrade,
    // including its valid old hash, rather than an inconsistent tampered plan.
    const executionPlan = { ...paused.request.executionPlan, envPolicyVersion: 1 };
    const oldRequest = { ...paused.request, executionPlan, planHash: executionPlanHash(executionPlan) };
    const records = await loadSessionRecords(rootDir, paused.sessionId);
    await writeFile(paused.sessionPath, records.map((record) => JSON.stringify(
      record.metadata?.kind === "permission-request"
        ? { ...record, metadata: { ...record.metadata, request: oldRequest } }
        : record,
    )).join("\n") + "\n");
    const restored = await loadSessionSnapshot(rootDir, paused.sessionId);
    expect(restored.pendingPermission).toEqual(oldRequest);
    if (!restored.pendingPermission) throw new Error("expected restored permission");

    let followUpRequests = 0;
    globalThis.fetch = (async () => {
      followUpRequests += 1;
      return Response.json({ id: "chat-old-env-rejected", choices: [{ message: { content: "not run" } }] });
    }) as unknown as typeof fetch;
    const options = {
      engine: "etl" as const,
      rootDir,
      sessionId: paused.sessionId,
      messages: restored.messages,
      request: restored.pendingPermission,
      remainingToolCalls: paused.remainingToolCalls,
      permission: { mode: "MOMENTUM" as const, shellExecEnabled: true },
    };
    await expect(resolvePermission({
      ...options,
      resolution: { decision: "allow_once", resolvedAt: new Date().toISOString() },
    })).rejects.toThrow("approved shell execution plan changed");
    expect(followUpRequests).toBe(0);
    expect((await loadSessionRecords(rootDir, paused.sessionId)).some((record) => record.metadata?.kind === "permission-resolution")).toBe(false);

    const rejected = await resolvePermission({
      ...options,
      resolution: { decision: "reject", resolvedAt: new Date().toISOString() },
    });
    expect(rejected.kind).toBe("complete");
    expect(followUpRequests).toBe(1);
    expect(await Bun.file(join(rootDir, "workspace", "should-not-exist")).exists()).toBe(false);
    expect((await loadSessionRecords(rootDir, paused.sessionId)).some((record) => record.metadata?.kind === "process-started")).toBe(false);
  });

  test.skipIf(process.platform === "win32")("YOLO auto-runs shell_exec while MANUAL pauses read tools", async () => {
    const yoloRoot = await createPromptRoot();
    let yoloRequests = 0;
    globalThis.fetch = (async () => {
      yoloRequests += 1;
      if (yoloRequests === 1) return Response.json({
        id: "chat-yolo-1",
        choices: [{ message: { content: "", tool_calls: [{
          id: "call-yolo",
          type: "function",
          function: { name: "shell_exec", arguments: JSON.stringify({ command: "printf yolo" }) },
        }] } }],
      });
      return Response.json({ id: "chat-yolo-2", choices: [{ message: { content: "done" } }] });
    }) as unknown as typeof fetch;
    const yolo = await runPrompt({
      input: "run",
      rootDir: yoloRoot,
      permission: { mode: "YOLO", shellExecEnabled: true },
    });
    expect(yolo.kind).toBe("complete");
    expect((await listRewindPoints(yoloRoot, yolo.sessionId))[0]?.checkpointTainted).toBe(true);

    const manualRoot = await createPromptRoot();
    await writeFile(join(manualRoot, "source_materials", "note.txt"), "note", "utf8");
    globalThis.fetch = (async () => Response.json({
      id: "chat-manual",
      choices: [{ message: { content: "", tool_calls: [{
        id: "call-read",
        type: "function",
        function: { name: "read_file", arguments: JSON.stringify({ path: "source_materials/note.txt" }) },
      }] } }],
    })) as unknown as typeof fetch;
    const manual = await runPrompt({ input: "read", rootDir: manualRoot, permission: { mode: "MANUAL" } });
    expect(manual.kind).toBe("needs_permission");
    if (manual.kind === "needs_permission") expect(manual.request.permissionClass).toBe("observe");
  });

  test.skipIf(process.platform === "win32")("YOLO cannot execute shell_exec when the capability is disabled", async () => {
    const rootDir = await createPromptRoot();
    let requests = 0;
    globalThis.fetch = (async () => {
      requests += 1;
      if (requests === 1) return Response.json({
        id: "chat-yolo-disabled-1",
        choices: [{ message: { content: "", tool_calls: [{
          id: "call-yolo-disabled",
          type: "function",
          function: {
            name: "shell_exec",
            arguments: JSON.stringify({ command: "touch workspace/should-not-exist" }),
          },
        }] } }],
      });
      return Response.json({ id: "chat-yolo-disabled-2", choices: [{ message: { content: "not run" } }] });
    }) as unknown as typeof fetch;

    const result = await runPrompt({
      input: "run",
      rootDir,
      permission: { mode: "YOLO", shellExecEnabled: false },
    });

    expect(result.kind).toBe("complete");
    expect(requests).toBe(2);
    expect(await Bun.file(join(rootDir, "workspace", "should-not-exist")).exists()).toBe(false);
    const records = await loadSessionRecords(rootDir, result.sessionId);
    expect(records.find((record) => record.metadata?.toolCallId === "call-yolo-disabled" && record.role === "tool")?.content)
      .toContain("not in the current Engine's effective tool surface");
    expect(records.some((record) => record.metadata?.kind === "process-started")).toBe(false);
  });

  test("background shell returns immediately and notifies the next provider turn", async () => {
    const rootDir = await createPromptRoot();
    const manager = getProcessManager(rootDir);
    let requests = 0;
    globalThis.fetch = (async () => {
      requests += 1;
      if (requests === 1) return Response.json({
        id: "chat-background-1",
        choices: [{ message: { content: "", tool_calls: [{
          id: "call-background",
          type: "function",
          function: {
            name: "shell_exec",
            arguments: JSON.stringify({
              command: process.platform === "win32"
                ? "Start-Sleep -Milliseconds 100; [Console]::Out.Write('ready')"
                : "sleep 0.1; printf ready",
              runInBackground: true,
            }),
          },
        }] } }],
      });
      return Response.json({ id: "chat-background-2", choices: [{ message: { content: "background started" } }] });
    }) as unknown as typeof fetch;

    const first = await runPrompt({
      input: "start it",
      rootDir,
      permission: { mode: "YOLO", shellExecEnabled: true },
    });
    if (first.kind !== "complete") throw new Error("expected complete");
    const task = (await manager.list(first.sessionId))[0];
    if (!task) throw new Error("expected background process");
    const completed = await manager.wait(task.taskId, { timeoutMs: 5_000 });
    expect(completed.status).toBe("completed");

    let continuationBody: any;
    globalThis.fetch = (async (_input: unknown, init: RequestInit & { body?: unknown }) => {
      continuationBody = JSON.parse(String(init.body));
      return Response.json({ id: "chat-background-3", choices: [{ message: { content: "saw completion" } }] });
    }) as unknown as typeof fetch;
    const second = await runPrompt({
      input: "continue",
      rootDir,
      sessionId: first.sessionId,
      messages: [...first.messages, { role: "user", content: "continue" }],
      permission: { mode: "YOLO", shellExecEnabled: true },
    });
    expect(second.kind).toBe("complete");
    // The completion rides the wire as a user message whose envelope text
    // carries the host provenance, and persists as a system-role host packet
    // stamped with the active execution identity (issue #284).
    const envelope = continuationBody.messages.filter((message: any) => message.role === "user")
      .find((message: any) => String(message.content).startsWith("<background-shell-results>"));
    expect(envelope).toBeTruthy();
    expect(String(envelope.content)).toContain(`callId="call-background"`);
    const records = await loadSessionRecords(rootDir, first.sessionId);
    const packet = records.find((record) => record.metadata?.kind === "background-process-results");
    expect(packet?.role).toBe("system");
    expect(packet?.metadata?.taskIds).toEqual([task.taskId]);
    expect(typeof packet?.metadata?.logicalTurnId).toBe("string");
    expect(packet?.content).toBe(String(envelope.content));
  });

  test("returns malformed shell arguments as a tool failure without pausing or aborting the turn", async () => {
    const rootDir = await createPromptRoot();
    let requests = 0;
    globalThis.fetch = (async () => {
      requests += 1;
      if (requests === 1) return Response.json({
        id: "chat-shell-malformed",
        choices: [{ message: { content: "", tool_calls: [{
          id: "call-shell-malformed",
          type: "function",
          function: { name: "shell_exec", arguments: "{not-json" },
        }] } }],
      });
      return Response.json({ id: "chat-shell-corrected", choices: [{ message: { content: "corrected" } }] });
    }) as unknown as typeof fetch;

    const result = await runPrompt({
      input: "run it",
      rootDir,
      permission: { mode: "MOMENTUM", shellExecEnabled: true },
    });
    expect(result.kind).toBe("complete");
    expect(requests).toBe(2);
    const records = await loadSessionRecords(rootDir, result.sessionId);
    expect(records.find((record) => record.metadata?.toolCallId === "call-shell-malformed" && record.role === "tool")?.content)
      .toContain("arguments must be valid JSON");
  });

});
