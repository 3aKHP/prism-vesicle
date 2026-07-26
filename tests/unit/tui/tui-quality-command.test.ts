import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadExperimentalQualitySettings } from "../../../src/config/quality";
import { builtinCommands } from "../../../src/tui/commands/builtin";
import type { CommandContext } from "../../../src/tui/commands/types";
import type { Message } from "../../../src/tui/types";

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

  test("/quality rewrite validates and stages the red panel without writing settings", async () => {
    const config = await configFixture();
    process.env.VESICLE_PROVIDERS_FILE = join(config, "providers.yaml");
    process.env.VESICLE_QUALITY_FILE = join(config, "quality.yaml");
    const command = builtinCommands.find((entry) => entry.name === "quality");
    if (!command) throw new Error("Missing /quality command.");
    let messages: Message[] = [];
    const stagedCandidates: { providerAlias: string; modelId: string; judgeTimeoutMs: number }[] = [];
    const ctx = {
      setMessages(updater: (previous: Message[]) => Message[]) { messages = updater(messages); },
      ensureProviderRegistry: async () => ({ providers: [] }),
      setStatus: () => undefined,
      recordActivity: () => undefined,
      activeProvider: () => "judge",
      activeModel: () => "judge-model",
      async openQualityRewriteConfirm(candidate: { providerAlias: string; modelId: string; judgeTimeoutMs: number }) { stagedCandidates.push(candidate); },
    } as unknown as CommandContext;

    await command.run(ctx, "rewrite judge judge-model 20000", "/quality rewrite judge judge-model 20000");
    expect(stagedCandidates).toEqual([{ providerAlias: "judge", modelId: "judge-model", judgeTimeoutMs: 20_000 }]);
    // The command must not persist Rewrite before the confirmation panel commits.
    expect((await loadExperimentalQualitySettings()).mode).toBe("off");
  });

  test("/quality confirm ... is rejected as invalid usage with no mutation", async () => {
    const config = await configFixture();
    process.env.VESICLE_PROVIDERS_FILE = join(config, "providers.yaml");
    process.env.VESICLE_QUALITY_FILE = join(config, "quality.yaml");
    const command = builtinCommands.find((entry) => entry.name === "quality");
    if (!command) throw new Error("Missing /quality command.");
    let messages: Message[] = [];
    let staged = false;
    const ctx = {
      setMessages(updater: (previous: Message[]) => Message[]) { messages = updater(messages); },
      ensureProviderRegistry: async () => ({ providers: [] }),
      setStatus: () => undefined,
      recordActivity: () => undefined,
      activeProvider: () => "judge",
      activeModel: () => "judge-model",
      async openQualityRewriteConfirm() { staged = true; },
    } as unknown as CommandContext;

    await command.run(ctx, "confirm rewrite judge judge-model 20000", "/quality confirm rewrite judge judge-model 20000");
    expect(messages.at(-1)?.content).toContain("confirm step was removed");
    expect(staged).toBe(false);
    expect((await loadExperimentalQualitySettings()).mode).toBe("off");
  });

  test("/quality observe <provider> <model> [timeout] writes observe immediately", async () => {
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

    await command.run(ctx, "observe judge judge-model 25000", "/quality observe judge judge-model 25000");
    expect(await loadExperimentalQualitySettings()).toMatchObject({
      mode: "observe", providerAlias: "judge", modelId: "judge-model", judgeTimeoutMs: 25_000,
    });
  });

  test("/quality off retains the dormant tuple", async () => {
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

    await command.run(ctx, "observe judge judge-model 18000", "/quality observe judge judge-model 18000");
    await command.run(ctx, "off", "/quality off");
    const off = await loadExperimentalQualitySettings();
    expect(off).toMatchObject({ mode: "off", providerAlias: "judge", modelId: "judge-model", judgeTimeoutMs: 18_000 });
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
