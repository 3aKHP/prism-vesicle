import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { listRewindPoints, summarizeConversationFrom } from "../../../src/core/rewind/service";
import { createSessionStore } from "../../../src/core/session/store";

const originalFetch = globalThis.fetch;
const originalEnv = { ...process.env };
let configDir: string | undefined;

describe("rewind partial summary", () => {
  beforeEach(async () => {
    configDir = await mkdtemp(join(tmpdir(), "vesicle-rewind-provider-"));
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

  test("summarizes from the selected prompt into a new branch and refills that prompt", async () => {
    const rootDir = await createPromptRoot();
    const store = await createSessionStore(rootDir, "rewind-summary");
    await store.append({ role: "system", content: "base\n\netl", metadata: { engine: "etl" } });
    await store.append({ role: "user", content: "first" });
    await store.append({ role: "assistant", content: "answer one" });
    await store.append({ role: "user", content: "second" });
    await store.append({ role: "assistant", content: "answer two" });
    const point = (await listRewindPoints(rootDir, store.sessionId))[1]!;
    let requestBody: { messages?: Array<{ content?: string }>; tools?: unknown } = {};
    globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
      requestBody = JSON.parse(String(init?.body));
      return Response.json({
        id: "summary",
        choices: [{ message: { content: "<analysis>draft</analysis><summary>Second turn summary.</summary>" } }],
      });
    }) as typeof fetch;

    const result = await summarizeConversationFrom({
      rootDir,
      sessionId: store.sessionId,
      point,
      engine: "etl",
    });

    expect(result.prompt).toBe("second");
    expect(result.snapshot.messages.map((message) => message.content)).toEqual([
      "first",
      "answer one",
      "[conversation summary]\nSecond turn summary.",
    ]);
    expect(result.snapshot.messages.at(-1)?.kind).toBe("compact-summary");
    expect(requestBody.messages?.at(-1)?.content).toContain("Summarize the conversation context");
    expect(requestBody.tools).toBeUndefined();
    expect((await listRewindPoints(rootDir, store.sessionId)).map((entry) => entry.content)).toEqual(["first"]);
  });
});

async function createPromptRoot(): Promise<string> {
  const rootDir = await mkdtemp(join(tmpdir(), "vesicle-rewind-summary-"));
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
    "stopGates: []",
    "stateRoots:",
    "  - workspace",
    "",
  ].join("\n"), "utf8");
  return rootDir;
}
