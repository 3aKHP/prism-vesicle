import { mkdtemp, } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, test } from "bun:test";
import { createSessionStore, FAILED_TURN_KIND, loadSessionMessages, } from "../../../src/core/session/store";

describe("session: message history", () => {
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

  // A provider failure leaves the user prompt persisted with no assistant reply
  // (#98). The host appends a failed-turn marker so projection can drop that
  // prompt from provider-visible history; otherwise resume + a new send would
  // emit consecutive same-role user messages, which Anthropic Messages rejects
  // (#102).
  test("drops a failed user turn from resumed provider history so resend cannot double up users", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "vesicle-failed-turn-"));
    const store = await createSessionStore(rootDir, "failed-turn");
    await store.append({ role: "system", content: "prompt" });
    await store.append({ role: "user", content: "earlier prompt" });
    await store.append({ role: "assistant", content: "earlier reply" });
    await store.append({ role: "user", content: "refactor this" });
    await store.append({ role: "system", content: "", metadata: { kind: FAILED_TURN_KIND } });

    const messages = await loadSessionMessages(rootDir, "failed-turn");
    expect(messages.map((m) => m.content)).toEqual(["earlier prompt", "earlier reply"]);
  });

  test("keeps the resent user + assistant after a failed turn marker", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "vesicle-failed-resend-"));
    const store = await createSessionStore(rootDir, "failed-resend");
    await store.append({ role: "system", content: "prompt" });
    await store.append({ role: "user", content: "refactor this" });
    await store.append({ role: "system", content: "", metadata: { kind: FAILED_TURN_KIND } });
    await store.append({ role: "user", content: "refactor this" });
    await store.append({ role: "assistant", content: "done" });

    const messages = await loadSessionMessages(rootDir, "failed-resend");
    expect(messages.map((m) => m.role)).toEqual(["user", "assistant"]);
    expect(messages[0]!.content).toBe("refactor this");
  });

  test("preserves durable compact-summary context across a failed turn marker", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "vesicle-failed-summary-"));
    const store = await createSessionStore(rootDir, "failed-summary");
    await store.append({ role: "system", content: "prompt" });
    await store.append({ role: "user", content: "[conversation summary]\n earlier work", metadata: { kind: "compact-summary" } });
    await store.append({ role: "user", content: "refactor this" });
    await store.append({ role: "system", content: "", metadata: { kind: FAILED_TURN_KIND } });

    const messages = await loadSessionMessages(rootDir, "failed-summary");
    expect(messages.map((m) => m.content)).toEqual(["[conversation summary]\n earlier work"]);
  });

  // A quality-rewrite round appends a user-role `quality-rewrite-feedback` after
  // the rejected assistant reply; if the rewrite round then fails, that feedback
  // is the failed round's input and must be dropped too — otherwise resume + a
  // new send yields [..., user:feedback, user:new] and Anthropic Messages
  // rejects the consecutive same-role pair (the #102 fix's quality-rewrite hole
  // surfaced by independent CR).
  test("drops a trailing quality-rewrite feedback when the rewrite round fails", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "vesicle-failed-rewrite-"));
    const store = await createSessionStore(rootDir, "failed-rewrite");
    await store.append({ role: "system", content: "prompt" });
    await store.append({ role: "user", content: "write a scene" });
    await store.append({ role: "assistant", content: "a draft scene" });
    await store.append({ role: "user", content: "[rewrite feedback]", metadata: { kind: "quality-rewrite-feedback" } });
    await store.append({ role: "system", content: "", metadata: { kind: FAILED_TURN_KIND } });

    const messages = await loadSessionMessages(rootDir, "failed-rewrite");
    expect(messages.map((m) => m.role)).toEqual(["user", "assistant"]);
    expect(messages[1]!.content).toBe("a draft scene");
  });

});
