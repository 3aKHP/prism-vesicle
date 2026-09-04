import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { runPrompt } from "../../../src/core/agent-loop/run";
import type { AgentLoopEvent } from "../../../src/core/agent-loop/types";
import { AutoCompactBlockedError } from "../../../src/core/compact/auto-compact";
import { COMPACT_CHECKPOINT_KIND, loadSessionRecords } from "../../../src/core/session/store";
import { getProcessManager } from "../../../src/core/process/manager";

// The fixture shells out through an explicit POSIX /bin/sh; probe that the
// interpreter actually spawns rather than merely existing on disk.
const posixShSpawnable = (() => {
  try {
    return Bun.spawnSync(["/bin/sh", "-c", "true"]).exitCode === 0;
  } catch {
    return false;
  }
})();

const originalFetch = globalThis.fetch;
const originalEnv = { ...process.env };
let configDir: string | undefined;
let rootDir: string | undefined;

async function configure(configYaml: string): Promise<void> {
  configDir = await mkdtemp(join(tmpdir(), "vesicle-preturn-cfg-"));
  await writeFile(join(configDir, "providers.yaml"), configYaml, "utf8");
  await writeFile(join(configDir, ".env"), "TEST_PROVIDER_API_KEY=test-key\n", "utf8");
  process.env.VESICLE_PROVIDERS_FILE = join(configDir, "providers.yaml");
  delete process.env.TEST_PROVIDER_API_KEY;
  process.env.VESICLE_HOST_ASSETS_DIR = join(tmpdir(), "vesicle-empty-host-assets");
  rootDir = await mkdtemp(join(tmpdir(), "vesicle-preturn-root-"));
  for (const dir of ["assets/prompts/shared", "assets/prompts/engines", "assets/engines", "workspace"]) {
    await mkdir(join(rootDir, dir), { recursive: true });
  }
  await writeFile(join(rootDir, "assets", "prompts", "shared", "vesicle-base.md"), "base", "utf8");
  await writeFile(join(rootDir, "assets", "prompts", "engines", "etl.md"), "etl", "utf8");
  await writeFile(join(rootDir, "assets", "engines", "etl.profile.yaml"), [
    "id: etl", "displayName: Test ETL", "protocolVersion: v9.0-state-space",
    "systemPrompt:", "  - assets/prompts/shared/vesicle-base.md", "  - assets/prompts/engines/etl.md",
    "defaultTools:", "  - read_file", "validators: []", "stopGates: []", "stateRoots:", "  - workspace", "",
  ].join("\n"), "utf8");
}

function provider(providerBlock: string): string {
  return [
    "default:", "  provider: test", "  model: m",
    "providers:", "  test:", "    protocol: openai-chat-compatible",
    "    baseUrl: https://provider.test/v1", "    apiKeyEnv: TEST_PROVIDER_API_KEY",
    "    models:", providerBlock, "",
  ].join("\n");
}

beforeEach(() => {
  globalThis.fetch = originalFetch;
  process.env = { ...originalEnv };
});

afterEach(async () => {
  globalThis.fetch = originalFetch;
  process.env = { ...originalEnv };
  const dirs = [configDir, rootDir];
  configDir = undefined;
  rootDir = undefined;
  await Promise.all(dirs.map((dir) => dir ? rm(dir, { recursive: true, force: true }) : Promise.resolve()));
});

function stubReplies(): void {
  globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { messages?: Array<{ content?: string }> };
    const last = body.messages?.at(-1)?.content ?? "";
    if (last.includes("TEXT ONLY")) {
      return Response.json({ id: "summary", choices: [{ message: { content: "<summary>Earlier turns covered the outline and refinement.</summary>" } }] });
    }
    return Response.json({ id: "reply", choices: [{ message: { content: "ok" } }] });
  }) as typeof fetch;
}

// ~820 bytes for two turns -> ~410 estimated tokens, comfortably above the
// soft trigger used below but below the hard ceiling.
const long = (n: number) => `turn ${n}: ` + "x".repeat(400);

describe("pre-turn auto-compaction", () => {
  test("compacts the existing head before the new user record is persisted", async () => {
    // The provider-visible tool schema is part of the estimate. The first turn
    // remains below the soft trigger; the second completed turn pushes the next
    // request over it. Budgets are calibrated against the real tool surface,
    // so schema-text changes re-touch these numbers.
    await configure(provider("      - id: m\n        limits:\n          contextWindow: 5500\n          autoCompact:\n            enabled: true\n            threshold: 0.8\n            reserveOutputTokens: 500"));
    stubReplies();
    const first = await runPrompt({ input: long(1), rootDir: rootDir!, messages: [{ role: "user", content: long(1) }] });
    if (first.kind !== "complete") throw new Error(`expected complete, got ${first.kind}`);
    // Second turn stays below the soft trigger (history + schema fit).
    const second = await runPrompt({ input: long(2), rootDir: rootDir!, sessionId: first.sessionId, messages: [{ role: "user", content: long(2) }] });
    if (second.kind !== "complete") throw new Error(`expected complete, got ${second.kind}`);
    const recordsBefore = await loadSessionRecords(rootDir!, first.sessionId);
    expect(recordsBefore.some((record) => record.metadata?.kind === COMPACT_CHECKPOINT_KIND)).toBe(false);

    // Third turn: two long turns now estimate above the soft trigger, so the
    // pre-turn check compacts the old head before persisting this input.
    const productionHistory = [
      { role: "user" as const, content: long(1) },
      { role: "assistant" as const, content: "ok" },
      { role: "user" as const, content: long(2) },
      { role: "assistant" as const, content: "ok" },
      { role: "user" as const, content: "next prompt" },
    ];
    const sentNormalHistories: string[][] = [];
    globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { messages?: Array<{ content?: string }> };
      const contents = body.messages?.map((message) => message.content ?? "") ?? [];
      if (contents.at(-1)?.includes("TEXT ONLY")) {
        return Response.json({ id: "summary", choices: [{ message: { content: "<summary>Earlier turns covered the outline and refinement.</summary>" } }] });
      }
      sentNormalHistories.push(contents);
      return Response.json({ id: "reply", choices: [{ message: { content: "ok" } }] });
    }) as typeof fetch;
    const third = await runPrompt({ input: "next prompt", rootDir: rootDir!, sessionId: first.sessionId, messages: productionHistory });
    if (third.kind !== "complete") throw new Error(`expected complete, got ${third.kind}`);

    const records = await loadSessionRecords(rootDir!, first.sessionId);
    const checkpointIndex = records.findIndex((record) => record.metadata?.kind === COMPACT_CHECKPOINT_KIND);
    expect(checkpointIndex).toBeGreaterThan(0);
    const newUser = records.findIndex((record, index) => index > checkpointIndex && record.role === "user" && record.content === "next prompt");
    expect(newUser).toBeGreaterThan(checkpointIndex);
    const postCompactRequest = sentNormalHistories.at(-1) ?? [];
    expect(postCompactRequest.some((content) => content.includes("[conversation summary]"))).toBe(true);
    expect(postCompactRequest).not.toContain(long(1));
    expect(postCompactRequest).toContain(long(2));
  });

  test("rejects an oversized replacement before installing its checkpoint", async () => {
    await configure(provider("      - id: m\n        limits:\n          contextWindow: 5500\n          autoCompact:\n            enabled: true\n            threshold: 0.8\n            reserveOutputTokens: 500"));
    stubReplies();
    const first = await runPrompt({ input: long(1), rootDir: rootDir!, messages: [{ role: "user", content: long(1) }] });
    if (first.kind !== "complete") throw new Error(`expected complete, got ${first.kind}`);
    const second = await runPrompt({ input: long(2), rootDir: rootDir!, sessionId: first.sessionId, messages: [{ role: "user", content: long(2) }] });
    if (second.kind !== "complete") throw new Error(`expected complete, got ${second.kind}`);
    const recordsBefore = await loadSessionRecords(rootDir!, first.sessionId);

    globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { messages?: Array<{ content?: string }> };
      if (body.messages?.at(-1)?.content?.includes("TEXT ONLY")) {
        return Response.json({ id: "summary", choices: [{ message: { content: `<summary>${"s".repeat(1200)}</summary>` } }] });
      }
      throw new Error("unsafe normal request was sent");
    }) as typeof fetch;

    await expect(runPrompt({
      input: `turn 3: ${"z".repeat(1000)}`,
      rootDir: rootDir!,
      sessionId: first.sessionId,
      messages: [{ role: "user", content: `turn 3: ${"z".repeat(1000)}` }],
    })).rejects.toBeInstanceOf(AutoCompactBlockedError);

    const recordsAfter = await loadSessionRecords(rootDir!, first.sessionId);
    expect(recordsAfter).toHaveLength(recordsBefore.length);
    expect(recordsAfter.some((record) => record.metadata?.kind === COMPACT_CHECKPOINT_KIND)).toBe(false);
    expect(recordsAfter.some((record) => record.content === `turn 3: ${"z".repeat(1000)}`)).toBe(false);
  });

  test("does not install a soft-trigger checkpoint when the summary enlarges the next request", async () => {
    await configure(provider("      - id: m\n        limits:\n          contextWindow: 5500\n          autoCompact:\n            enabled: true\n            threshold: 0.08\n            reserveOutputTokens: 500"));
    stubReplies();
    const first = await runPrompt({ input: long(1), rootDir: rootDir!, messages: [{ role: "user", content: long(1) }] });
    if (first.kind !== "complete") throw new Error(`expected complete, got ${first.kind}`);
    const second = await runPrompt({ input: long(2), rootDir: rootDir!, sessionId: first.sessionId, messages: [{ role: "user", content: long(2) }] });
    if (second.kind !== "complete") throw new Error(`expected complete, got ${second.kind}`);

    let normalCalls = 0;
    globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { messages?: Array<{ content?: string }> };
      if (body.messages?.at(-1)?.content?.includes("TEXT ONLY")) {
        return Response.json({ id: "summary", choices: [{ message: { content: `<summary>${"s".repeat(1000)}</summary>` } }] });
      }
      normalCalls += 1;
      return Response.json({ id: "reply", choices: [{ message: { content: "ok" } }] });
    }) as typeof fetch;

    const third = await runPrompt({
      input: "next prompt",
      rootDir: rootDir!,
      sessionId: first.sessionId,
      messages: [{ role: "user", content: "next prompt" }],
    });
    if (third.kind !== "complete") throw new Error(`expected complete, got ${third.kind}`);

    expect(normalCalls).toBe(1);
    const records = await loadSessionRecords(rootDir!, first.sessionId);
    expect(records.some((record) => record.metadata?.kind === COMPACT_CHECKPOINT_KIND)).toBe(false);
  });

  test("a hard-ceiling failure blocks the request without persisting the new input", async () => {
    // contextWindow 6000, reserve 300 -> hardCeiling = 5700. One medium turn is
    // sendable with the tool schema, but the medium history plus the oversized
    // incoming input exceeds the hard ceiling; a single complete turn with one
    // round cannot be safely evicted, so the mandatory compact fails and the
    // request is blocked. Wide margins keep this stable across small tool-schema
    // changes.
    await configure(provider("      - id: m\n        limits:\n          contextWindow: 6000\n          autoCompact:\n            enabled: true\n            threshold: 0.95\n            reserveOutputTokens: 300"));
    stubReplies();
    const medium = `turn one: ${"x".repeat(1400)}`;
    const first = await runPrompt({ input: medium, rootDir: rootDir!, messages: [{ role: "user", content: medium }] });
    if (first.kind !== "complete") throw new Error(`expected complete, got ${first.kind}`);
    const recordsBefore = await loadSessionRecords(rootDir!, first.sessionId);
    const blockedPrompt = `blocked: ${"y".repeat(3500)}`;

    await expect(runPrompt({ input: blockedPrompt, rootDir: rootDir!, sessionId: first.sessionId, messages: [{ role: "user", content: blockedPrompt }] })).rejects.toBeInstanceOf(AutoCompactBlockedError);

    const recordsAfter = await loadSessionRecords(rootDir!, first.sessionId);
    expect(recordsAfter.length).toBe(recordsBefore.length);
    expect(recordsAfter.some((record) => record.content === blockedPrompt)).toBe(false);
    expect(recordsAfter.some((record) => record.metadata?.kind === COMPACT_CHECKPOINT_KIND)).toBe(false);
  });

  test("propagates compaction cancellation without recording a failure or checkpoint", async () => {
    await configure(provider("      - id: m\n        limits:\n          contextWindow: 5500\n          autoCompact:\n            enabled: true\n            threshold: 0.8\n            reserveOutputTokens: 500"));
    stubReplies();
    const first = await runPrompt({ input: long(1), rootDir: rootDir!, messages: [{ role: "user", content: long(1) }] });
    if (first.kind !== "complete") throw new Error(`expected complete, got ${first.kind}`);
    const second = await runPrompt({ input: long(2), rootDir: rootDir!, sessionId: first.sessionId, messages: [{ role: "user", content: long(2) }] });
    if (second.kind !== "complete") throw new Error(`expected complete, got ${second.kind}`);
    const recordsBefore = await loadSessionRecords(rootDir!, first.sessionId);

    const controller = new AbortController();
    const events: AgentLoopEvent[] = [];
    globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
      if (init?.signal?.aborted) throw new DOMException("The operation was aborted.", "AbortError");
      return Response.json({ id: "unexpected", choices: [{ message: { content: "unexpected" } }] });
    }) as typeof fetch;

    await expect(runPrompt({
      input: "cancel this compact",
      rootDir: rootDir!,
      sessionId: first.sessionId,
      messages: [{ role: "user", content: "cancel this compact" }],
      signal: controller.signal,
      onEvent: (event) => {
        events.push(event);
        if (event.type === "compact_started") controller.abort();
      },
    })).rejects.toMatchObject({ name: "AbortError" });

    expect(events.some((event) => event.type === "compact_cancelled")).toBe(true);
    expect(events.some((event) => event.type === "compact_failed")).toBe(false);
    const recordsAfter = await loadSessionRecords(rootDir!, first.sessionId);
    expect(recordsAfter).toHaveLength(recordsBefore.length);
    expect(recordsAfter.some((record) => record.metadata?.kind === COMPACT_CHECKPOINT_KIND)).toBe(false);
  });

  test.skipIf(!posixShSpawnable)("materializes background output before the exact provider-send hard guard", async () => {
    await configure(provider("      - id: m\n        limits:\n          contextWindow: 5500\n          autoCompact:\n            enabled: true\n            threshold: 0.8\n            reserveOutputTokens: 500"));
    let normalCalls = 0;
    globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { messages?: Array<{ content?: string }> };
      if (body.messages?.at(-1)?.content?.includes("TEXT ONLY")) {
        return Response.json({ id: "summary", choices: [{ message: { content: "<summary>Prior turn.</summary>" } }] });
      }
      normalCalls += 1;
      return Response.json({ id: "reply", choices: [{ message: { content: normalCalls === 1 ? "ok" : "unsafe" } }] });
    }) as typeof fetch;

    const first = await runPrompt({ input: "setup", rootDir: rootDir!, messages: [{ role: "user", content: "setup" }] });
    if (first.kind !== "complete") throw new Error(`expected complete, got ${first.kind}`);
    const manager = getProcessManager(rootDir!);
    const task = await manager.start({
      command: "printf '%03000d' 0",
      cwd: ".",
      shell: "posix-sh",
      executablePath: "/bin/sh",
      runtimePolicyVersion: 1,
      timeoutMs: 5_000,
      envPolicyVersion: 1,
      runInBackground: true,
    }, { parentSessionId: first.sessionId, parentToolCallId: "background-test" });
    await manager.wait(task.taskId, { timeoutMs: 5_000 });

    await expect(runPrompt({
      input: "continue",
      rootDir: rootDir!,
      sessionId: first.sessionId,
      messages: [{ role: "user", content: "continue" }],
    })).rejects.toBeInstanceOf(AutoCompactBlockedError);

    expect(normalCalls).toBe(1);
    const records = await loadSessionRecords(rootDir!, first.sessionId);
    expect(records.some((record) => record.metadata?.kind === "background-process-results")).toBe(true);
    expect(records.some((record) => record.metadata?.kind === "compact-blocked")).toBe(true);
  });

  test("without autoCompact configured, the pre-turn check is skipped", async () => {
    await configure(provider("      - m"));
    stubReplies();
    const first = await runPrompt({ input: long(1), rootDir: rootDir!, messages: [{ role: "user", content: long(1) }] });
    if (first.kind !== "complete") throw new Error(`expected complete, got ${first.kind}`);
    const second = await runPrompt({ input: long(2), rootDir: rootDir!, sessionId: first.sessionId, messages: [{ role: "user", content: long(2) }] });
    if (second.kind !== "complete") throw new Error(`expected complete, got ${second.kind}`);
    const records = await loadSessionRecords(rootDir!, first.sessionId);
    expect(records.some((record) => record.metadata?.kind === COMPACT_CHECKPOINT_KIND)).toBe(false);
  });
});
