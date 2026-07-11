import { describe, expect, test } from "bun:test";
import type { ProviderRegistry, ProviderSelection } from "../src/config/providers";
import { builtinCommands } from "../src/tui/commands/builtin";
import type { CommandContext } from "../src/tui/commands/types";
import type { Message } from "../src/tui/types";

const registry: ProviderRegistry = {
  source: "file",
  default: { provider: "deepseek", model: "deepseek-v4-flash" },
  providers: [
    {
      id: "deepseek",
      protocol: "openai-chat-compatible",
      baseUrl: "https://api.deepseek.com/v1",
      apiKeyEnv: "DEEPSEEK_API_KEY",
      defaultModel: "deepseek-v4-flash",
      models: [{ id: "deepseek-v4-flash" }, { id: "deepseek-reasoner" }],
    },
    {
      id: "mimo",
      protocol: "anthropic-messages",
      baseUrl: "https://example.com/v1",
      apiKeyEnv: "MIMO_API_KEY",
      defaultModel: "mimo-v2",
      models: [{ id: "mimo-v2" }],
    },
  ],
};

describe("/model command", () => {
  test("preserves the legacy one-argument model switch in the active provider", async () => {
    const harness = commandHarness();

    await harness.command.run(harness.ctx, "deepseek-reasoner", "/model deepseek-reasoner");

    expect(harness.requested()).toEqual({ provider: "deepseek", model: "deepseek-reasoner" });
    expect(harness.persisted()).toEqual({ provider: "deepseek", model: "deepseek-reasoner" });
  });

  test("treats a one-argument provider id as a switch to its default model", async () => {
    const harness = commandHarness();

    await harness.command.run(harness.ctx, "mimo", "/model mimo");

    expect(harness.requested()).toEqual({ provider: "mimo" });
    expect(harness.persisted()).toEqual({ provider: "mimo", model: "mimo-v2" });
  });

  test("opens the picker when no arguments are supplied", async () => {
    const harness = commandHarness();

    await harness.command.run(harness.ctx, "", "/model");

    expect(harness.pickerOpened()).toBe(true);
    expect(harness.requested()).toBeNull();
  });
});

function commandHarness() {
  const command = builtinCommands.find((entry) => entry.name === "model");
  if (!command) throw new Error("Missing /model command.");
  let messages: Message[] = [];
  let requestedSelection: Partial<ProviderSelection> | null = null;
  let persistedSelection: ProviderSelection | null = null;
  let opened = false;

  const ctx = {
    setMessages(updater: (previous: Message[]) => Message[]) {
      messages = updater(messages);
    },
    activeProvider: () => "deepseek",
    ensureProviderRegistry: async () => registry,
    async applyProviderSelection(selection: Partial<ProviderSelection>) {
      requestedSelection = selection;
      const provider = selection.provider ?? "deepseek";
      const profile = registry.providers.find((entry) => entry.id === provider);
      return { provider, model: selection.model ?? profile?.defaultModel ?? profile?.models[0]?.id ?? "" };
    },
    async persistProviderSwitch(selection: ProviderSelection) {
      persistedSelection = selection;
    },
    async openModelPicker() {
      opened = true;
    },
  } as unknown as CommandContext;

  return {
    command,
    ctx,
    requested: () => requestedSelection,
    persisted: () => persistedSelection,
    pickerOpened: () => opened,
  };
}
