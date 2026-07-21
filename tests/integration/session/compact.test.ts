import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  ERROR_PENDING_INTERACTION,
  compactConversation,
} from "../../../src/core/compact/service";
import { createSessionStore, loadSessionRecords } from "../../../src/core/session/store";

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

  test("summarizes the active session into a new compact branch", async () => {
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
    expect(result.messagesSummarized).toBe(4);
    expect(result.snapshot.messages.map((message) => message.content)).toEqual([
      "[conversation summary]\nWhole session summary.",
    ]);
    expect(result.snapshot.messages[0].kind).toBe("compact-summary");
    expect(requestBody.messages?.at(-1)?.content).toContain("Additional summary instructions:\nkeep file names");
    expect(requestBody.tools).toBeUndefined();

    const records = await loadSessionRecords(rootDir, store.sessionId);
    expect(records.at(-2)?.metadata?.kind).toBe("compact-boundary");
    expect(records.at(-1)?.metadata?.kind).toBe("compact-summary");
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
