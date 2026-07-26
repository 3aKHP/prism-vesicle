import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { runPrompt } from "../../../src/core/agent-loop/run";
import { AutoCompactBlockedError } from "../../../src/core/compact/auto-compact";
import { COMPACT_CHECKPOINT_KIND, loadSessionRecords } from "../../../src/core/session/store";

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
    // contextWindow 600, reserve 100 -> softTrigger = floor(min(300, 500)) = 300,
    // hardCeiling = 500. Two long turns estimate ~410 tokens -> soft trigger.
    await configure(provider("      - id: m\n        limits:\n          contextWindow: 600\n          autoCompact:\n            enabled: true\n            threshold: 0.5\n            reserveOutputTokens: 100"));
    stubReplies();
    const first = await runPrompt({ input: long(1), rootDir: rootDir!, messages: [{ role: "user", content: long(1) }] });
    if (first.kind !== "complete") throw new Error(`expected complete, got ${first.kind}`);
    // Second turn stays below the soft trigger (one turn ~205 tokens < 300).
    const second = await runPrompt({ input: long(2), rootDir: rootDir!, sessionId: first.sessionId, messages: [{ role: "user", content: long(2) }] });
    if (second.kind !== "complete") throw new Error(`expected complete, got ${second.kind}`);
    const recordsBefore = await loadSessionRecords(rootDir!, first.sessionId);
    expect(recordsBefore.some((record) => record.metadata?.kind === COMPACT_CHECKPOINT_KIND)).toBe(false);

    // Third turn: two long turns now estimate above the soft trigger, so the
    // pre-turn check compacts the old head before persisting this input.
    const third = await runPrompt({ input: "next prompt", rootDir: rootDir!, sessionId: first.sessionId, messages: [{ role: "user", content: "next prompt" }] });
    if (third.kind !== "complete") throw new Error(`expected complete, got ${third.kind}`);

    const records = await loadSessionRecords(rootDir!, first.sessionId);
    const checkpointIndex = records.findIndex((record) => record.metadata?.kind === COMPACT_CHECKPOINT_KIND);
    expect(checkpointIndex).toBeGreaterThan(0);
    const newUser = records.findIndex((record, index) => index > checkpointIndex && record.role === "user" && record.content === "next prompt");
    expect(newUser).toBeGreaterThan(checkpointIndex);
  });

  test("a hard-ceiling failure blocks the request without persisting the new input", async () => {
    // contextWindow 300, reserve 100 -> softTrigger = floor(min(270, 200)) = 200,
    // hardCeiling = 200. One long turn (~205 tokens) + incoming input > 200 ->
    // hard ceiling; a single complete turn with one round cannot be safely
    // evicted, so the mandatory compact fails and the request is blocked.
    await configure(provider("      - id: m\n        limits:\n          contextWindow: 300\n          autoCompact:\n            enabled: true\n            threshold: 0.9\n            reserveOutputTokens: 100"));
    stubReplies();
    const first = await runPrompt({ input: long(1), rootDir: rootDir!, messages: [{ role: "user", content: long(1) }] });
    if (first.kind !== "complete") throw new Error(`expected complete, got ${first.kind}`);
    const recordsBefore = await loadSessionRecords(rootDir!, first.sessionId);

    await expect(runPrompt({ input: "blocked prompt", rootDir: rootDir!, sessionId: first.sessionId, messages: [{ role: "user", content: "blocked prompt" }] })).rejects.toBeInstanceOf(AutoCompactBlockedError);

    const recordsAfter = await loadSessionRecords(rootDir!, first.sessionId);
    expect(recordsAfter.length).toBe(recordsBefore.length);
    expect(recordsAfter.some((record) => record.content === "blocked prompt")).toBe(false);
    expect(recordsAfter.some((record) => record.metadata?.kind === COMPACT_CHECKPOINT_KIND)).toBe(false);
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
