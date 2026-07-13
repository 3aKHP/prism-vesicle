import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, test } from "bun:test";
import { createSessionStore, listSessions, loadSessionMessages, loadSessionSnapshot } from "../src/core/session/store";

describe("session resume", () => {
  test("restores the safe asset fingerprint from the initial system record", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "vesicle-session-assets-"));
    const store = await createSessionStore(rootDir);
    const assets = {
      sha256: "a".repeat(64),
      files: [{ path: "assets/prompts/engines/etl.md", sha256: "b".repeat(64), source: "user" as const }],
    };
    await store.append({ role: "system", content: "prompt", metadata: { assets } });
    await store.append({ role: "user", content: "hello" });

    const snapshot = await loadSessionSnapshot(rootDir, store.sessionId);
    expect(snapshot.assets).toEqual(assets);
  });

  test("restores durable image attachment references without base64", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "vesicle-session-images-"));
    const store = await createSessionStore(rootDir);
    const image = {
      id: "img_test",
      path: ".vesicle/attachments/test.png",
      mediaType: "image/png" as const,
      bytes: 3,
      sha256: "0".repeat(64),
      source: "clipboard" as const,
      filename: "capture.png",
    };
    await store.append({ role: "system", content: "prompt" });
    await store.append({
      role: "user",
      content: "inspect [Image #1]",
      metadata: { images: [{ ...image, data: "must-not-survive" }] },
    });

    const messages = await loadSessionMessages(rootDir, store.sessionId);
    expect(messages[0]).toMatchObject({ role: "user", images: [image] });
    expect(messages[0].images?.[0].data).toBeUndefined();
  });

  test("serializes appends from multiple stores for the same session", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "vesicle-session-concurrent-"));
    const sessionId = "2026-01-01T00-00-00-000Z-concurrent";
    const first = await createSessionStore(rootDir, sessionId);
    const second = await createSessionStore(rootDir, sessionId);
    const system = await first.append({ role: "system", content: "prompt" });

    const [user, checkpoint] = await Promise.all([
      first.append({ role: "user", content: "parent turn" }),
      second.append({ role: "system", content: "", metadata: { kind: "file-history-snapshot" } }),
    ]);

    expect(user.parentUuid).toBe(system.uuid);
    expect(checkpoint.parentUuid).toBe(user.uuid);
    const snapshot = await loadSessionSnapshot(rootDir, sessionId);
    expect(snapshot.records.map((record) => record.uuid)).toEqual([system.uuid, user.uuid, checkpoint.uuid]);
  });

  test("append-only session records fork from an explicit parent and resume the newest branch", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "vesicle-session-branch-"));
    const sessionId = "2026-01-01T00-00-00-000Z-branching";
    const original = await createSessionStore(rootDir, sessionId);
    await original.append({ role: "system", content: "prompt" });
    await original.append({ role: "user", content: "first prompt" });
    const firstAnswer = await original.append({ role: "assistant", content: "first answer" });
    const oldPrompt = await original.append({ role: "user", content: "old second prompt" });
    const oldAnswer = await original.append({ role: "assistant", content: "old second answer" });

    const fork = await createSessionStore(rootDir, sessionId, { parentUuid: firstAnswer.uuid });
    const revisedPrompt = await fork.append({ role: "user", content: "revised second prompt" });
    await fork.append({ role: "assistant", content: "revised second answer" });

    expect(oldPrompt.parentUuid).toBe(firstAnswer.uuid);
    expect(revisedPrompt.parentUuid).toBe(firstAnswer.uuid);

    const active = await loadSessionSnapshot(rootDir, sessionId);
    expect(active.messages.map((message) => message.content)).toEqual([
      "first prompt",
      "first answer",
      "revised second prompt",
      "revised second answer",
    ]);

    const oldBranch = await loadSessionSnapshot(rootDir, sessionId, { headUuid: oldAnswer.uuid });
    expect(oldBranch.messages.map((message) => message.content)).toEqual([
      "first prompt",
      "first answer",
      "old second prompt",
      "old second answer",
    ]);
  });

  test("legacy linear JSONL records receive deterministic implicit parents", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "vesicle-session-legacy-"));
    const sessionId = "2026-01-01T00-00-00-000Z-legacy";
    const sessionDir = join(rootDir, ".vesicle", "sessions");
    await mkdir(sessionDir, { recursive: true });
    const records = [
      { ts: "2026-01-01T00:00:00.000Z", sessionId, role: "system", content: "prompt" },
      { ts: "2026-01-01T00:00:01.000Z", sessionId, role: "user", content: "legacy prompt" },
      { ts: "2026-01-01T00:00:02.000Z", sessionId, role: "assistant", content: "legacy answer" },
    ];
    await writeFile(join(sessionDir, `${sessionId}.jsonl`), records.map((record) => JSON.stringify(record)).join("\n") + "\n", "utf8");

    const snapshot = await loadSessionSnapshot(rootDir, sessionId);
    expect(snapshot.records.map((record) => record.uuid)).toEqual([
      `${sessionId}:legacy:0`,
      `${sessionId}:legacy:1`,
      `${sessionId}:legacy:2`,
    ]);
    expect(snapshot.records[1]?.parentUuid).toBe(`${sessionId}:legacy:0`);
    expect(snapshot.messages.map((message) => message.content)).toEqual(["legacy prompt", "legacy answer"]);
  });

  test("listSessions returns summaries newest-first with previews", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "vesicle-session-"));
    const sessionDir = join(rootDir, ".vesicle", "sessions");
    await mkdir(sessionDir, { recursive: true });
    await writeSessionFixture(sessionDir, "2026-01-01T00-00-00-000Z-aaaaaaaa", [
      { ts: "2026-01-01T00:00:00.000Z", role: "system", content: "prompt" },
      { ts: "2026-01-01T00:00:01.000Z", role: "user", content: "first session question" },
      { ts: "2026-01-01T00:00:02.000Z", role: "assistant", content: "answer" },
    ]);
    await writeSessionFixture(sessionDir, "2026-02-01T00-00-00-000Z-bbbbbbbb", [
      { ts: "2026-02-01T00:00:00.000Z", role: "system", content: "prompt" },
      { ts: "2026-02-01T00:00:01.000Z", role: "user", content: "second session, a different question" },
    ]);

    const summaries = await listSessions(rootDir);
    expect(summaries).toHaveLength(2);
    expect(summaries[0].sessionId).toContain("bbbbbbbb");
    expect(summaries[1].sessionId).toContain("aaaaaaaa");
    expect(summaries[0].preview).toContain("second session");
    expect(summaries[0].recordCount).toBe(2);
  });

  test("listSessions returns empty array when sessions dir does not exist", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "vesicle-empty-"));
    const summaries = await listSessions(rootDir);
    expect(summaries).toEqual([]);
  });

  test("listSessions hides SubAgent transcripts from the primary resume picker", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "vesicle-session-subagent-"));
    const primary = await createSessionStore(rootDir, "primary");
    await primary.append({ role: "system", content: "primary" });
    await primary.append({ role: "user", content: "main task" });
    const child = await createSessionStore(rootDir, "child");
    await child.append({ role: "system", content: "child", metadata: { kind: "subagent-session", parentSessionId: "primary" } });
    await child.append({ role: "user", content: "delegated task" });

    expect((await listSessions(rootDir)).map((session) => session.sessionId)).toEqual(["primary"]);
    expect((await listSessions(rootDir, { includeSubagents: true })).map((session) => session.sessionId).sort()).toEqual(["child", "primary"]);
  });

  test("loadSessionMessages reconstructs user/assistant/tool turns and skips system records", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "vesicle-reload-"));
    const store = await createSessionStore(rootDir, "2026-03-01T00-00-00-000Z-cccccccc");

    await store.append({ role: "system", content: "the composed prompt — should be skipped on resume" });
    await store.append({ role: "user", content: "draft a blueprint" });
    await store.append({
      role: "assistant",
      content: "here is the blueprint",
      metadata: {
        engine: "etl",
        model: "test-model",
        reasoningContent: "I should pause before proceeding.",
        thinkingBlocks: [{ type: "reasoning", reasoningContent: "I should pause before proceeding." }],
        usage: { contextInputTokens: 1300, inputTokens: 1200, outputTokens: 300, totalTokens: 1500, cacheReadInputTokens: 500, effectiveTokens: 1000 },
        toolCalls: [{ id: "call-1", name: "request_confirmation", arguments: "{}" }],
      },
    });
    await store.append({
      role: "tool",
      content: '{"ok":true,"result":"Confirmed"}',
      metadata: { toolCallId: "call-1" },
    });
    await store.append({ role: "user", content: "[gate] confirm" });
    await store.append({ role: "assistant", content: "advancing to phase 1" });
    await store.append({
      role: "system",
      content: "validation passed",
      metadata: { kind: "validation", ok: true },
    });

    const messages = await loadSessionMessages(rootDir, "2026-03-01T00-00-00-000Z-cccccccc");

    expect(messages.map((m) => m.role)).toEqual([
      "user",
      "assistant",
      "tool",
      "user",
      "assistant",
    ]);
    expect(messages[1].toolCalls?.[0]?.id).toBe("call-1");
    expect(messages[1].engine).toBe("etl");
    expect(messages[1].model).toBe("test-model");
    expect(messages[1].usage).toEqual({
      contextInputTokens: 1300,
      inputTokens: 1200,
      outputTokens: 300,
      totalTokens: 1500,
      cacheReadInputTokens: 500,
      effectiveTokens: 1000,
    });
    // The second assistant carries no engine/model metadata → left absent.
    expect(messages[4].engine).toBeUndefined();
    expect(messages[1].reasoningContent).toBe("I should pause before proceeding.");
    expect(messages[1].thinkingBlocks).toEqual([{ type: "reasoning", reasoningContent: "I should pause before proceeding." }]);
    expect(messages[2].toolCallId).toBe("call-1");
    // The composed system prompt must not leak into the resumed message list.
    expect(messages.some((m) => m.content.includes("composed prompt"))).toBe(false);
  });

  test("loadSessionMessages on a non-existent session throws", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "vesicle-missing-"));
    await expect(loadSessionMessages(rootDir, "does-not-exist")).rejects.toThrow();
  });

  test("restores foreground and background SubAgent usage metadata", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "vesicle-session-agent-usage-"));
    const store = await createSessionStore(rootDir, "agent-usage");
    await store.append({ role: "system", content: "prompt" });
    await store.append({ role: "user", content: "delegate work" });
    await store.append({
      role: "tool",
      content: "foreground result",
      metadata: {
        kind: "subagent-result",
        toolCallId: "call-agent",
        usage: { inputTokens: 100, outputTokens: 20 },
      },
    });
    await store.append({
      role: "user",
      content: "<subagent-results>background</subagent-results>",
      metadata: {
        kind: "subagent-results",
        usage: { inputTokens: 200, outputTokens: 30 },
      },
    });

    const messages = await loadSessionMessages(rootDir, "agent-usage");
    expect(messages[1]).toMatchObject({
      role: "tool",
      kind: "subagent-result",
      usage: { inputTokens: 100, outputTokens: 20 },
    });
    expect(messages[2]).toMatchObject({
      role: "user",
      kind: "subagent-results",
      usage: { inputTokens: 200, outputTokens: 30 },
    });
  });

  test("loadSessionMessages filters malformed thinking blocks", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "vesicle-thinking-blocks-"));
    const store = await createSessionStore(rootDir, "2026-03-02T00-00-00-000Z-blocks");

    await store.append({ role: "system", content: "prompt" });
    await store.append({
      role: "assistant",
      content: "answer",
      metadata: {
        thinkingBlocks: [
          { type: "reasoning", reasoningContent: "valid" },
          { type: "reasoning", reasoningContent: 42 },
          { type: "unknown", value: "ignored" },
        ],
      },
    });

    const messages = await loadSessionMessages(rootDir, "2026-03-02T00-00-00-000Z-blocks");

    expect(messages[0].thinkingBlocks).toEqual([{ type: "reasoning", reasoningContent: "valid" }]);
  });

  test("loadSessionMessages synthesizes tool results for an unresolved gate (CR B1)", async () => {
    // A session that paused at a gate ends with an assistant message
    // carrying a request_confirmation tool call but no tool result (the
    // user never resolved the gate). Resume must synthesise a placeholder
    // tool result so the provider does not reject the dangling tool_calls.
    const rootDir = await mkdtemp(join(tmpdir(), "vesicle-dangling-"));
    const store = await createSessionStore(rootDir, "2026-04-01T00-00-00-000Z-dddddddd");

    await store.append({ role: "system", content: "prompt" });
    await store.append({ role: "user", content: "draft a blueprint" });
    await store.append({
      role: "assistant",
      content: "here is the blueprint",
      metadata: {
        toolCalls: [{ id: "call-gate", name: "request_confirmation", arguments: "{}" }],
      },
    });
    // No tool result record — this is the gate-paused state.

    const messages = await loadSessionMessages(rootDir, "2026-04-01T00-00-00-000Z-dddddddd");

    // user, assistant(gate), tool(synthetic)
    expect(messages.map((m) => m.role)).toEqual(["user", "assistant", "tool"]);
    expect(messages[2].toolCallId).toBe("call-gate");
    // The synthetic result must signal unresolved, not success.
    expect(messages[2].content).toContain("not resolved");
  });

  test("loadSessionSnapshot preserves an unresolved gate for interactive resume", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "vesicle-pending-gate-"));
    const store = await createSessionStore(rootDir, "2026-04-01T00-00-00-000Z-ffffffff");

    await store.append({ role: "system", content: "prompt" });
    await store.append({ role: "user", content: "draft a blueprint" });
    await store.append({
      role: "assistant",
      content: "here is the blueprint",
      metadata: {
        toolCalls: [{
          id: "call-gate",
          name: "request_confirmation",
          arguments: JSON.stringify({ gate: "blueprint-confirmation", summary: "Concept: A" }),
        }],
      },
    });

    const summaries = await listSessions(rootDir);
    expect(summaries[0].pendingGate?.gate).toBe("blueprint-confirmation");

    const snapshot = await loadSessionSnapshot(rootDir, "2026-04-01T00-00-00-000Z-ffffffff");
    expect(snapshot.pendingGate?.toolCallId).toBe("call-gate");
    expect(snapshot.pendingGate?.gate.summary).toBe("Concept: A");
    expect(snapshot.messages.map((m) => m.role)).toEqual(["user", "assistant"]);
  });

  test("loadSessionSnapshot preserves an unresolved engine switch for interactive resume", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "vesicle-pending-engine-"));
    const store = await createSessionStore(rootDir, "2026-04-01T00-00-00-000Z-engine");

    await store.append({ role: "system", content: "prompt", metadata: { engine: "etl" } });
    await store.append({ role: "user", content: "handoff" });
    await store.append({
      role: "assistant",
      content: "Runtime should continue.",
      metadata: {
        toolCalls: [
          {
            id: "call-engine",
            name: "request_engine_switch",
            arguments: JSON.stringify({
              targetEngine: "runtime",
              reason: "Runtime owns turn simulation.",
              handoffSummary: "Cards are ready.",
            }),
          },
        ],
      },
    });

    const summaries = await listSessions(rootDir);
    expect(summaries[0].pendingEngineSwitch?.targetEngine).toBe("runtime");

    const snapshot = await loadSessionSnapshot(rootDir, "2026-04-01T00-00-00-000Z-engine");
    expect(snapshot.pendingEngineSwitch?.toolCallId).toBe("call-engine");
    expect(snapshot.pendingEngineSwitch?.request.handoffSummary).toBe("Cards are ready.");
    expect(snapshot.messages.map((m) => m.role)).toEqual(["user", "assistant"]);
  });

  test("loadSessionSnapshot preserves engine handoff packets as user-role context", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "vesicle-engine-handoff-"));
    const store = await createSessionStore(rootDir, "2026-04-01T00-00-00-000Z-handoff");

    await store.append({ role: "system", content: "prompt", metadata: { engine: "etl" } });
    await store.append({ role: "user", content: "start" });
    await store.append({ role: "assistant", content: "ready" });
    await store.append({
      role: "system",
      content: "Engine switched to runtime.",
      metadata: {
        kind: "engine-switch",
        engine: "runtime",
      },
    });
    await store.append({
      role: "user",
      content: "[engine_handoff]\nSource: manual\n[/engine_handoff]",
      metadata: {
        kind: "engine-handoff",
        engine: "runtime",
      },
    });

    const snapshot = await loadSessionSnapshot(rootDir, "2026-04-01T00-00-00-000Z-handoff");
    expect(snapshot.engine).toBe("runtime");
    expect(snapshot.messages.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
    expect(snapshot.messages.at(-1)).toMatchObject({
      role: "user",
      kind: "engine-handoff",
      content: "[engine_handoff]\nSource: manual\n[/engine_handoff]",
    });
  });

  test("loadSessionSnapshot preserves an unresolved user question for interactive resume", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "vesicle-pending-question-"));
    const store = await createSessionStore(rootDir, "2026-04-01T00-00-00-000Z-question");

    await store.append({ role: "system", content: "prompt", metadata: { engine: "etl" } });
    await store.append({ role: "user", content: "ask" });
    await store.append({
      role: "assistant",
      content: "Choose one.",
      metadata: {
        toolCalls: [
          {
            id: "call-question",
            name: "ask_user_question",
            arguments: JSON.stringify({
              header: "Scope",
              question: "Which scope should I use?",
              options: [
                { label: "Narrow", description: "Minimum change." },
                { label: "Broad", description: "Include cleanup." },
              ],
            }),
          },
        ],
      },
    });

    const summaries = await listSessions(rootDir);
    expect(summaries[0].pendingUserQuestion?.header).toBe("Scope");

    const snapshot = await loadSessionSnapshot(rootDir, "2026-04-01T00-00-00-000Z-question");
    expect(snapshot.pendingUserQuestion?.toolCallId).toBe("call-question");
    expect(snapshot.pendingUserQuestion?.question.options[1].label).toBe("Broad");
    expect(snapshot.pendingUserQuestion?.question.options.map((option) => option.label)).toEqual(["Narrow", "Broad", "Skip", "Answer freely"]);
    expect(snapshot.messages.map((m) => m.role)).toEqual(["user", "assistant"]);
  });

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

  test("loadSessionSnapshot restores the latest provider/model selection", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "vesicle-provider-session-"));
    const store = await createSessionStore(rootDir, "2026-05-01T00-00-00-000Z-provider");

    await store.append({
      role: "system",
      content: "prompt",
      metadata: { providerId: "deepseek", model: "deepseek-v4-flash" },
    });
    await store.append({
      role: "user",
      content: "first",
      metadata: { providerId: "deepseek", model: "deepseek-v4-flash" },
    });
    await store.append({
      role: "user",
      content: "second",
      metadata: { providerId: "local", model: "qwen3" },
    });

    const snapshot = await loadSessionSnapshot(rootDir, "2026-05-01T00-00-00-000Z-provider");

    expect(snapshot.providerSelection).toEqual({ provider: "local", model: "qwen3" });
  });

  test("loadSessionSnapshot restores the latest engine selection", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "vesicle-engine-session-"));
    const store = await createSessionStore(rootDir, "2026-05-01T00-00-00-000Z-engine");

    await store.append({
      role: "system",
      content: "prompt",
      metadata: { engine: "etl" },
    });
    await store.append({
      role: "system",
      content: "Engine switched to runtime.",
      metadata: { kind: "engine-switch", engine: "runtime" },
    });
    await store.append({
      role: "user",
      content: "continue",
      metadata: { engine: "weaver-orch" },
    });

    const snapshot = await loadSessionSnapshot(rootDir, "2026-05-01T00-00-00-000Z-engine");

    expect(snapshot.engine).toBe("weaver-orch");
  });

  test("loadSessionSnapshot ignores unknown engine metadata", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "vesicle-engine-invalid-session-"));
    const store = await createSessionStore(rootDir, "2026-05-01T00-00-00-000Z-engine-invalid");

    await store.append({
      role: "system",
      content: "prompt",
      metadata: { engine: "not-real" },
    });

    const snapshot = await loadSessionSnapshot(rootDir, "2026-05-01T00-00-00-000Z-engine-invalid");

    expect(snapshot.engine).toBeUndefined();
  });

  test("loadSessionSnapshot restores the latest thinking tier", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "vesicle-thinking-session-"));
    const store = await createSessionStore(rootDir, "2026-05-01T00-00-00-000Z-thinking");

    await store.append({ role: "system", content: "prompt" });
    await store.append({
      role: "system",
      content: "Thinking effort switched to low.",
      metadata: { kind: "thinking-switch", reasoningTier: "low" },
    });
    await store.append({
      role: "user",
      content: "second",
      metadata: { reasoningTier: "max" },
    });

    const snapshot = await loadSessionSnapshot(rootDir, "2026-05-01T00-00-00-000Z-thinking");

    expect(snapshot.reasoningTier).toBe("max");
  });

  test("loadSessionSnapshot restores cleared thinking tier as provider default", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "vesicle-thinking-clear-session-"));
    const store = await createSessionStore(rootDir, "2026-05-01T00-00-00-000Z-thinking-clear");

    await store.append({ role: "system", content: "prompt" });
    await store.append({
      role: "system",
      content: "Thinking effort switched to max.",
      metadata: { kind: "thinking-switch", reasoningTier: "max" },
    });
    await store.append({
      role: "system",
      content: "Thinking effort reset to provider default.",
      metadata: { kind: "thinking-switch", reasoningTier: null },
    });

    const snapshot = await loadSessionSnapshot(rootDir, "2026-05-01T00-00-00-000Z-thinking-clear");

    expect(snapshot.reasoningTier).toBeUndefined();
  });

  test("loadSessionSnapshot restores the latest reasoning display mode", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "vesicle-reasoning-display-session-"));
    const store = await createSessionStore(rootDir, "2026-05-01T00-00-00-000Z-reasoning-display");

    await store.append({ role: "system", content: "prompt" });
    await store.append({
      role: "system",
      content: "Reasoning display switched to hidden.",
      metadata: { kind: "reasoning-switch", reasoningDisplayMode: "hidden" },
    });
    await store.append({
      role: "system",
      content: "Reasoning display switched to expanded.",
      metadata: { kind: "reasoning-switch", reasoningDisplayMode: "expanded" },
    });

    const snapshot = await loadSessionSnapshot(rootDir, "2026-05-01T00-00-00-000Z-reasoning-display");

    expect(snapshot.reasoningDisplayMode).toBe("expanded");
  });

  test("loadSessionMessages does not synthesise results when tool results already exist", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "vesicle-answered-"));
    const store = await createSessionStore(rootDir, "2026-05-01T00-00-00-000Z-eeeeeeee");

    await store.append({ role: "system", content: "prompt" });
    await store.append({ role: "user", content: "write a file" });
    await store.append({
      role: "assistant",
      content: "",
      metadata: {
        toolCalls: [{ id: "call-write", name: "write_file", arguments: "{}" }],
      },
    });
    await store.append({
      role: "tool",
      content: '{"ok":true,"result":"Wrote workspace/x.md"}',
      metadata: { toolCallId: "call-write" },
    });

    const messages = await loadSessionMessages(rootDir, "2026-05-01T00-00-00-000Z-eeeeeeee");
    // No extra synthetic tool result should be appended.
    expect(messages.filter((m) => m.role === "tool")).toHaveLength(1);
  });
});

async function writeSessionFixture(
  sessionDir: string,
  sessionId: string,
  records: Array<{ ts: string; role: string; content: string }>,
): Promise<void> {
  const lines = records.map((record) => JSON.stringify({ ...record, sessionId })).join("\n");
  await writeFile(join(sessionDir, `${sessionId}.jsonl`), `${lines}\n`, "utf8");
}
