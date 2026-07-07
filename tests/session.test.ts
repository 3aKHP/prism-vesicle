import { mkdtemp, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, test } from "bun:test";
import { createSessionStore, listSessions, loadSessionMessages, loadSessionSnapshot } from "../src/core/session/store";

describe("session resume", () => {
  test("listSessions returns summaries newest-first with previews", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "vesicle-session-"));

    const older = await createSessionStore(rootDir, "2026-01-01T00-00-00-000Z-aaaaaaaa");
    await older.append({ role: "system", content: "prompt" });
    await older.append({ role: "user", content: "first session question" });
    await older.append({ role: "assistant", content: "answer" });

    const newer = await createSessionStore(rootDir, "2026-02-01T00-00-00-000Z-bbbbbbbb");
    await newer.append({ role: "system", content: "prompt" });
    await newer.append({ role: "user", content: "second session, a different question" });

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

  test("loadSessionMessages reconstructs user/assistant/tool turns and skips system records", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "vesicle-reload-"));
    const store = await createSessionStore(rootDir, "2026-03-01T00-00-00-000Z-cccccccc");

    await store.append({ role: "system", content: "the composed prompt — should be skipped on resume" });
    await store.append({ role: "user", content: "draft a blueprint" });
    await store.append({
      role: "assistant",
      content: "here is the blueprint",
      metadata: {
        reasoningContent: "I should pause before proceeding.",
        thinkingBlocks: [{ type: "reasoning", reasoningContent: "I should pause before proceeding." }],
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

  test("loadSessionSnapshot restores the latest thinking tier", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "vesicle-thinking-session-"));
    const store = await createSessionStore(rootDir, "2026-05-01T00-00-00-000Z-thinking");

    await store.append({ role: "system", content: "prompt" });
    await store.append({
      role: "system",
      content: "Thinking tier switched to low.",
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
      content: "Thinking tier switched to max.",
      metadata: { kind: "thinking-switch", reasoningTier: "max" },
    });
    await store.append({
      role: "system",
      content: "Thinking tier reset to provider default.",
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
