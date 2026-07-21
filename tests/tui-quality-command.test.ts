import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadExperimentalQualitySettings } from "../src/config/quality";
import { builtinCommands } from "../src/tui/commands/builtin";
import type { CommandContext } from "../src/tui/commands/types";
import type { Message } from "../src/tui/types";

const originalProvidersFile = process.env.VESICLE_PROVIDERS_FILE;
const originalQualityFile = process.env.VESICLE_QUALITY_FILE;
const directories: string[] = [];

afterEach(async () => {
  if (originalProvidersFile === undefined) delete process.env.VESICLE_PROVIDERS_FILE;
  else process.env.VESICLE_PROVIDERS_FILE = originalProvidersFile;
  if (originalQualityFile === undefined) delete process.env.VESICLE_QUALITY_FILE;
  else process.env.VESICLE_QUALITY_FILE = originalQualityFile;
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("/quality command", () => {
  test("opens the picker without arguments and keeps status read-only", async () => {
    const command = builtinCommands.find((entry) => entry.name === "quality");
    if (!command) throw new Error("Missing /quality command.");
    let opened = false;
    let messages: Message[] = [];
    const ctx = {
      setMessages(updater: (previous: Message[]) => Message[]) { messages = updater(messages); },
      async openQualityPicker() { opened = true; },
    } as unknown as CommandContext;
    await command.run(ctx, "", "/quality");
    expect(opened).toBe(true);
    expect(messages).toHaveLength(1);
  });

  test("requires explicit confirmation before enabling experimental rewrite", async () => {
    const config = await configFixture();
    process.env.VESICLE_PROVIDERS_FILE = join(config, "providers.yaml");
    process.env.VESICLE_QUALITY_FILE = join(config, "quality.yaml");
    const command = builtinCommands.find((entry) => entry.name === "quality");
    if (!command) throw new Error("Missing /quality command.");
    let messages: Message[] = [];
    const ctx = {
      setMessages(updater: (previous: Message[]) => Message[]) { messages = updater(messages); },
      ensureProviderRegistry: async () => ({ providers: [] }),
      setStatus: () => undefined,
      recordActivity: () => undefined,
    } as unknown as CommandContext;

    await command.run(ctx, "rewrite judge judge-model 20000", "/quality rewrite judge judge-model 20000");
    expect(messages.at(-1)?.content).toContain("Confirm with /quality confirm rewrite judge judge-model 20000");
    expect((await loadExperimentalQualitySettings()).mode).toBe("off");

    await command.run(ctx, "confirm rewrite judge judge-model 20000", "/quality confirm rewrite judge judge-model 20000");
    expect(await loadExperimentalQualitySettings()).toMatchObject({
      mode: "rewrite", providerAlias: "judge", modelId: "judge-model", judgeTimeoutMs: 20_000,
    });
  });
});

async function configFixture(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "vesicle-quality-command-"));
  directories.push(directory);
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "providers.yaml"), [
    "default:", "  provider: judge", "  model: judge-model", "providers:",
    "  judge:", "    protocol: openai-chat-compatible", "    baseUrl: https://example.test/v1", "    apiKeyEnv: JUDGE_KEY", "    models:", "      - judge-model", "",
  ].join("\n"));
  await writeFile(join(directory, ".env"), "JUDGE_KEY=test-key\n");
  return directory;
}
