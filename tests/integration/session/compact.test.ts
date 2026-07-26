import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  ERROR_PENDING_INTERACTION,
  compactConversation,
} from "../../../src/core/compact/service";
import { COMPACT_CHECKPOINT_KIND, createSessionStore, loadSessionRecords, loadSessionSnapshot } from "../../../src/core/session/store";

const originalFetch = globalThis.fetch;
const originalEnv = { ...process.env };
let configDir: string | undefined;

describe("conversation compact", () => {
  beforeEach(async () => {
    configDir = await mkdtemp(join(tmpdir(), "vesicle-compact-provider-"));
    const configPath = join(configDir, "providers.yaml");
    await writeFile(configPath, [
      "default:",
      "  provider: test",
      "  model: test-model",
      "providers:",
      "  test:",
      "    protocol: openai-chat-compatible",
      "    baseUrl: https://provider.test/v1",
      "    apiKeyEnv: TEST_PROVIDER_API_KEY",
      "    models:",
      "      - test-model",
      "",
    ].join("\n"), "utf8");
    await writeFile(join(configDir, ".env"), "TEST_PROVIDER_API_KEY=test-key\n", "utf8");
    process.env.VESICLE_PROVIDERS_FILE = configPath;
  });

  afterEach(async () => {
    globalThis.fetch = originalFetch;
    process.env = { ...originalEnv };
    if (configDir) await rm(configDir, { recursive: true, force: true });
  });

  test("summarizes the evicted prefix and retains the newest complete turn verbatim", async () => {
    const rootDir = await createPromptRoot();
    const store = await createSessionStore(rootDir, "compact-session");
    await store.append({ role: "system", content: "base\n\netl", metadata: { engine: "etl" } });
    await store.append({ role: "user", content: "first" });
    await store.append({ role: "assistant", content: "answer one" });
    await store.append({ role: "user", content: "second" });
    await store.append({ role: "assistant", content: "answer two" });

    let requestBody: { messages?: Array<{ content?: string }>; tools?: unknown } = {};
    globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
      requestBody = JSON.parse(String(init?.body));
      return Response.json({
        id: "compact",
        choices: [{ message: { content: "<analysis>draft</analysis><summary>Whole session summary.</summary>" } }],
      });
    }) as typeof fetch;

    const result = await compactConversation({
      rootDir,
      sessionId: store.sessionId,
      engine: "etl",
      instructions: "keep file names",
    });

    expect(result.summary).toBe("Whole session summary.");
    // Only the first turn (2 conversational records) was evicted; the newest
    // turn is retained verbatim after the summary.
    expect(result.messagesSummarized).toBe(2);
    expect(result.snapshot.messages.map((message) => message.content)).toEqual([
      "[conversation summary]\nWhole session summary.",
      "second",
      "answer two",
    ]);
    expect(result.snapshot.messages[0]!.kind).toBe("compact-summary");
    expect(result.snapshot.messages[1]!.role).toBe("user");
    // The summary request covers only the evicted prefix, and the merged
    // instructions reach the prompt. No tools are exposed to the summary call.
    expect(requestBody.messages?.at(-1)?.content).toContain("Additional summary instructions:\nkeep file names");
    expect(requestBody.tools).toBeUndefined();

    const records = await loadSessionRecords(rootDir, store.sessionId);
    expect(records.at(-1)?.metadata?.kind).toBe(COMPACT_CHECKPOINT_KIND);
    // The original append-only transcript is intact above the checkpoint.
    expect(records.filter((record) => record.role === "user").map((record) => record.content)).toEqual(["first", "second"]);
  });

  test("surfaces transport retries for the compact provider call (#101)", async () => {
    const rootDir = await createPromptRoot();
    const store = await createSessionStore(rootDir, "compact-retry");
    await store.append({ role: "system", content: "base\n\netl", metadata: { engine: "etl" } });
    await store.append({ role: "user", content: "first" });
    await store.append({ role: "assistant", content: "answer one" });
    await store.append({ role: "user", content: "second" });
    await store.append({ role: "assistant", content: "answer two" });

    const retries: Array<{ attempt: number; status?: number }> = [];
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      if (calls === 1) return new Response('{"error":{"message":"rate limited"}}', { status: 429 });
      return Response.json({
        id: "compact",
        choices: [{ message: { content: "<summary>Whole session summary.</summary>" } }],
      });
    }) as unknown as typeof fetch;

    const result = await compactConversation({
      rootDir,
      sessionId: store.sessionId,
      engine: "etl",
      onRetry: (info) => retries.push({ attempt: info.attempt, status: info.status }),
    });

    expect(result.summary).toBe("Whole session summary.");
    expect(retries).toHaveLength(1);
    expect(retries[0]!.attempt).toBe(1);
    expect(retries[0]!.status).toBe(429);
  });

  test("refuses to compact while an interactive request is pending", async () => {
    const rootDir = await createPromptRoot();
    const store = await createSessionStore(rootDir, "compact-pending");
    await store.append({ role: "system", content: "base\n\netl", metadata: { engine: "etl" } });
    await store.append({ role: "user", content: "draft" });
    await store.append({
      role: "assistant",
      content: "confirm?",
      metadata: {
        toolCalls: [{
          id: "call-gate",
          name: "request_confirmation",
          arguments: JSON.stringify({ gate: "blueprint-confirmation", summary: "Concept: A" }),
        }],
      },
    });

    await expect(compactConversation({
      rootDir,
      sessionId: store.sessionId,
      engine: "etl",
    })).rejects.toThrow(ERROR_PENDING_INTERACTION);
  });

  test("a failed summary leaves the prior head active with no checkpoint installed", async () => {
    const rootDir = await createPromptRoot();
    const store = await createSessionStore(rootDir, "compact-fail");
    await store.append({ role: "system", content: "base\n\netl", metadata: { engine: "etl" } });
    await store.append({ role: "user", content: "first" });
    await store.append({ role: "assistant", content: "answer one" });
    await store.append({ role: "user", content: "second" });
    await store.append({ role: "assistant", content: "answer two" });

    const recordsBefore = await loadSessionRecords(rootDir, store.sessionId);
    globalThis.fetch = (async () => new Response('{"error":{"message":"boom"}}', { status: 500 })) as unknown as typeof fetch;

    await expect(compactConversation({ rootDir, sessionId: store.sessionId, engine: "etl" })).rejects.toThrow();

    const recordsAfter = await loadSessionRecords(rootDir, store.sessionId);
    // No checkpoint appended; the append-only transcript is byte-identical.
    expect(recordsAfter.length).toBe(recordsBefore.length);
    expect(recordsAfter.some((record) => record.metadata?.kind === COMPACT_CHECKPOINT_KIND)).toBe(false);
  });

  test("repeated compaction merges the previous summary and keeps the retained tail verbatim", async () => {
    const rootDir = await createPromptRoot();
    const store = await createSessionStore(rootDir, "compact-repeat");
    await store.append({ role: "system", content: "base\n\netl", metadata: { engine: "etl" } });
    await store.append({ role: "user", content: "turn one" });
    await store.append({ role: "assistant", content: "reply one" });
    await store.append({ role: "user", content: "turn two" });
    await store.append({ role: "assistant", content: "reply two" });
    await store.append({ role: "user", content: "turn three" });
    await store.append({ role: "assistant", content: "reply three" });

    const summaryEvicted: string[] = [];
    const summaryPrompts: string[] = [];
    globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { messages?: Array<{ content?: string }> };
      const messages = body.messages ?? [];
      // The adapter prepends the system prompt, so the evicted content is
      // messages[0 .. -2]; the final message is the summary prompt.
      summaryEvicted.push(messages.slice(0, -1).map((message) => message.content).join(" | "));
      summaryPrompts.push(messages.at(-1)?.content ?? "");
      return Response.json({ id: "compact", choices: [{ message: { content: "<summary>Merged summary.</summary>" } }] });
    }) as typeof fetch;

    const first = await compactConversation({ rootDir, sessionId: store.sessionId, engine: "etl" });
    // First compact evicts turn one and turn two; retains turn three.
    expect(first.snapshot.messages.map((message) => message.content)).toEqual([
      "[conversation summary]\nMerged summary.",
      "turn three",
      "reply three",
    ]);

    // Add two new turns and compact again: the older post-checkpoint turn is
    // evicted and its summary merges with the prior summary; the newest turn is
    // retained verbatim and never reaches the summary request.
    const session = await createSessionStore(rootDir, store.sessionId);
    await session.append({ role: "user", content: "turn four" });
    await session.append({ role: "assistant", content: "reply four" });
    await session.append({ role: "user", content: "turn five" });
    await session.append({ role: "assistant", content: "reply five" });

    const second = await compactConversation({ rootDir, sessionId: store.sessionId, engine: "etl" });
    expect(second.snapshot.messages.map((message) => message.content)).toEqual([
      "[conversation summary]\nMerged summary.",
      "turn five",
      "reply five",
    ]);
    // The second summary request saw turn four's content (newly evicted) but
    // NOT turn five (still retained); the prompt merges the previous summary.
    expect(summaryEvicted[1]).toContain("turn four");
    expect(summaryEvicted[1]).not.toContain("turn five");
    expect(summaryPrompts[1]).toContain("Previous summary:");
  });

  test("a retained tool round keeps its tool-call/result pairing and reasoning intact", async () => {
    const rootDir = await createPromptRoot();
    const store = await createSessionStore(rootDir, "compact-tools");
    await store.append({ role: "system", content: "base\n\netl", metadata: { engine: "etl" } });
    await store.append({ role: "user", content: "old turn" });
    await store.append({ role: "assistant", content: "old reply" });
    await store.append({ role: "user", content: "do a thing" });
    await store.append({
      role: "assistant",
      content: "",
      metadata: {
        reasoningContent: "planning the call",
        thinkingBlocks: [{ type: "reasoning", reasoningContent: "planning the call" }],
        toolCalls: [{ id: "call-keep", name: "write_file", arguments: "{}" }],
      },
    });
    await store.append({ role: "tool", content: '{"ok":true,"result":"wrote"}', metadata: { toolCallId: "call-keep" } });

    globalThis.fetch = (async () => Response.json({
      id: "compact",
      choices: [{ message: { content: "<summary>Kept tail summary.</summary>" } }],
    })) as unknown as typeof fetch;

    const result = await compactConversation({ rootDir, sessionId: store.sessionId, engine: "etl" });
    const messages = result.snapshot.messages;
    // The retained assistant + tool result survive with their pairing and the
    // reasoning block, so all three adapters see a valid request shape.
    const assistant = messages.find((message) => message.role === "assistant");
    const tool = messages.find((message) => message.role === "tool");
    expect(assistant?.toolCalls?.[0]?.id).toBe("call-keep");
    expect(tool?.toolCallId).toBe("call-keep");
    expect(assistant?.thinkingBlocks).toEqual([{ type: "reasoning", reasoningContent: "planning the call" }]);
  });

  test("resume from a checkpoint head reproduces the replacement and replays a later turn", async () => {
    const rootDir = await createPromptRoot();
    const store = await createSessionStore(rootDir, "compact-resume");
    await store.append({ role: "system", content: "base\n\netl", metadata: { engine: "etl" } });
    await store.append({ role: "user", content: "first" });
    await store.append({ role: "assistant", content: "answer one" });
    await store.append({ role: "user", content: "second" });
    await store.append({ role: "assistant", content: "answer two" });

    globalThis.fetch = (async () => Response.json({
      id: "compact",
      choices: [{ message: { content: "<summary>Resume summary.</summary>" } }],
    })) as unknown as typeof fetch;

    const compacted = await compactConversation({ rootDir, sessionId: store.sessionId, engine: "etl" });
    // Append a later turn after the checkpoint and reload from the file.
    const session = await createSessionStore(rootDir, store.sessionId);
    await session.append({ role: "user", content: "third" });
    await session.append({ role: "assistant", content: "answer three" });

    const resumed = await loadSessionSnapshot(rootDir, store.sessionId);
    expect(resumed.messages.map((message) => message.content)).toEqual([
      "[conversation summary]\nResume summary.",
      "second",
      "answer two",
      "third",
      "answer three",
    ]);
    expect(compacted.parentUuid).toBeDefined();
  });
});

async function createPromptRoot(): Promise<string> {
  const rootDir = await mkdtemp(join(tmpdir(), "vesicle-compact-"));
  const sharedDir = join(rootDir, "assets", "prompts", "shared");
  const enginePromptDir = join(rootDir, "assets", "prompts", "engines");
  const profileDir = join(rootDir, "assets", "engines");
  await mkdir(sharedDir, { recursive: true });
  await mkdir(enginePromptDir, { recursive: true });
  await mkdir(profileDir, { recursive: true });
  await writeFile(join(sharedDir, "vesicle-base.md"), "base", "utf8");
  await writeFile(join(enginePromptDir, "etl.md"), "etl", "utf8");
  await writeFile(join(profileDir, "etl.profile.yaml"), [
    "id: etl",
    "displayName: Test ETL",
    "protocolVersion: v9.0-state-space",
    "systemPrompt:",
    "  - assets/prompts/shared/vesicle-base.md",
    "  - assets/prompts/engines/etl.md",
    "defaultTools:",
    "  - read_file",
    "validators: []",
    "stopGates:",
    "  - blueprint-confirmation",
    "stateRoots:",
    "  - workspace",
    "",
  ].join("\n"), "utf8");
  return rootDir;
}
