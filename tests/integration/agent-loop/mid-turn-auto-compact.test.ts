import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { runPrompt } from "../../../src/core/agent-loop/run";
import type { AgentLoopEvent } from "../../../src/core/agent-loop/types";
import { COMPACT_CHECKPOINT_KIND, loadSessionRecords, loadSessionSnapshot } from "../../../src/core/session/store";

const originalFetch = globalThis.fetch;
const originalEnv = { ...process.env };
let configDir: string | undefined;
let rootDir: string | undefined;

async function configure(): Promise<void> {
  configDir = await mkdtemp(join(tmpdir(), "vesicle-midturn-cfg-"));
  // Tool schemas contribute most of the baseline estimate. The large read_file
  // result pushes the complete round above the 4k soft trigger.
  await writeFile(join(configDir, "providers.yaml"), [
    "default:", "  provider: test", "  model: m",
    "providers:", "  test:", "    protocol: openai-chat-compatible",
    "    baseUrl: https://provider.test/v1", "    apiKeyEnv: TEST_PROVIDER_API_KEY",
    "    models:", "      - id: m", "        limits:",
    "          contextWindow: 5000", "          autoCompact:",
    "            enabled: true", "            threshold: 0.8", "            reserveOutputTokens: 500",
    "", "",
  ].join("\n"), "utf8");
  await writeFile(join(configDir, ".env"), "TEST_PROVIDER_API_KEY=test-key\n", "utf8");
  process.env.VESICLE_PROVIDERS_FILE = join(configDir, "providers.yaml");
  delete process.env.TEST_PROVIDER_API_KEY;
  rootDir = await mkdtemp(join(tmpdir(), "vesicle-midturn-root-"));
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
  // A large source file whose read_file result pushes the mid-turn estimate over.
  await writeFile(join(rootDir, "workspace", "big.md"), "line\n".repeat(220), "utf8");
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

describe("mid-turn auto-compaction", () => {
  test("compacts only after a complete tool batch and keeps the tool round + final reply", async () => {
    await configure();
    let calls = 0;
    globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { messages?: Array<{ content?: string }> };
      const last = body.messages?.at(-1)?.content ?? "";
      if (last.includes("TEXT ONLY")) {
        return Response.json({ id: "summary", choices: [{ message: { content: "<summary>Earlier setup and the file read.</summary>" } }] });
      }
      calls += 1;
      if (calls === 2) {
        // runPrompt 2, iteration 0: ask the model to read the big file.
        return Response.json({
          id: "tool",
          choices: [{
            message: {
              content: "",
              tool_calls: [{ id: "call-read", type: "function", function: { name: "read_file", arguments: JSON.stringify({ path: "workspace/big.md" }) } }],
            },
          }],
        });
      }
      return Response.json({ id: "reply", choices: [{ message: { content: "done" } }] });
    }) as typeof fetch;

    // Turn 1: a short setup turn (pre-turn check below the threshold).
    const setup = `setup ${"x".repeat(400)}`;
    const first = await runPrompt({ input: setup, rootDir: rootDir!, messages: [{ role: "user", content: setup }] });
    if (first.kind !== "complete") throw new Error(`expected complete, got ${first.kind}`);
    const recordsAfterFirst = await loadSessionRecords(rootDir!, first.sessionId);
    expect(recordsAfterFirst.some((record) => record.metadata?.kind === COMPACT_CHECKPOINT_KIND)).toBe(false);

    // Turn 2: iteration 0 reads the big file (large result) -> the mid-turn soft
    // check after that complete batch compacts the old head before iteration 1.
    const second = await runPrompt({
      input: "read and continue",
      rootDir: rootDir!,
      sessionId: first.sessionId,
      messages: [
        { role: "user", content: setup },
        { role: "assistant", content: "done" },
        { role: "user", content: "read and continue" },
      ],
    });
    if (second.kind !== "complete") throw new Error(`expected complete, got ${second.kind}`);

    const records = await loadSessionRecords(rootDir!, first.sessionId);
    const checkpointIndex = records.findIndex((record) => record.metadata?.kind === COMPACT_CHECKPOINT_KIND);
    expect(checkpointIndex).toBeGreaterThan(0);
    // The checkpoint lands AFTER the tool batch (assistant tool call + tool result),
    // proving compaction waited for the complete batch.
    const toolResultIndex = records.findIndex((record) => record.role === "tool");
    expect(toolResultIndex).toBeGreaterThan(0);
    expect(checkpointIndex).toBeGreaterThan(toolResultIndex);
    // The final assistant reply is appended after the checkpoint (the loop continued).
    const finalAssistant = records.findIndex((record, index) => index > checkpointIndex && record.role === "assistant" && record.content === "done");
    expect(finalAssistant).toBeGreaterThan(checkpointIndex);

    // The provider-visible history after the checkpoint keeps the tool round
    // (read_file call + result) exactly — the active frontier survived the rebuild.
    const snapshot = await loadSessionSnapshot(rootDir!, first.sessionId);
    const assistant = snapshot.messages.find((message) => message.role === "assistant" && (message.toolCalls?.length ?? 0) > 0);
    const tool = snapshot.messages.find((message) => message.role === "tool");
    expect(assistant?.toolCalls?.[0]?.id).toBe("call-read");
    expect(tool?.toolCallId).toBe("call-read");
    expect(snapshot.messages.at(-1)?.content).toBe("done");
  });

  test("rechecks the exact request after soft compaction and queued input", async () => {
    await configure();
    let normalCalls = 0;
    const events: AgentLoopEvent[] = [];
    globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { messages?: Array<{ content?: string }> };
      const last = body.messages?.at(-1)?.content ?? "";
      if (last.includes("TEXT ONLY")) {
        return Response.json({ id: "summary", choices: [{ message: { content: "<summary>Compact prior work.</summary>" } }] });
      }
      normalCalls += 1;
      if (normalCalls === 2) {
        return Response.json({
          id: "tool",
          choices: [{
            message: {
              content: "",
              tool_calls: [{ id: "call-read", type: "function", function: { name: "read_file", arguments: JSON.stringify({ path: "workspace/big.md" }) } }],
            },
          }],
        });
      }
      return Response.json({ id: "unsafe", choices: [{ message: { content: "unsafe" } }] });
    }) as typeof fetch;

    const setup = `setup ${"x".repeat(400)}`;
    const first = await runPrompt({ input: setup, rootDir: rootDir!, messages: [{ role: "user", content: setup }] });
    if (first.kind !== "complete") throw new Error(`expected complete, got ${first.kind}`);
    let drained = false;
    const second = await runPrompt({
      input: "read and continue",
      rootDir: rootDir!,
      sessionId: first.sessionId,
      messages: [
        { role: "user", content: setup },
        { role: "assistant", content: "unsafe" },
        { role: "user", content: "read and continue" },
      ],
      takePendingUserInputs: () => {
        if (drained) return [];
        drained = true;
        return [{ content: `queued: ${"q".repeat(3000)}` }];
      },
      onEvent: (event) => events.push(event),
    });
    if (second.kind !== "complete") throw new Error(`expected complete, got ${second.kind}`);

    expect(normalCalls).toBe(2);
    const records = await loadSessionRecords(rootDir!, first.sessionId);
    expect(records.filter((record) => record.metadata?.kind === COMPACT_CHECKPOINT_KIND)).toHaveLength(1);
    expect(records.some((record) => record.metadata?.kind === "queued-user-message")).toBe(true);
    expect(records.some((record) => record.metadata?.kind === "compact-blocked")).toBe(true);
    expect(events.some((event) => event.type === "compact_failed" && event.reason === "hard-ceiling")).toBe(true);
  });
});
