import { describe, expect, test } from "bun:test";
import type { ReasoningTier } from "../../../src/providers/shared/types";
import { createBuiltinCommands } from "../../../src/tui/commands/builtin";
import { createProviderCommands } from "../../../src/tui/commands/provider";
import type { BuiltinCommandContexts, ProviderCommandContext } from "../../../src/tui/commands/types";
import type { Message } from "../../../src/tui/types";

const allCommands = createBuiltinCommands({} as unknown as BuiltinCommandContexts);

describe("/effort command", () => {
  test("is the only provider thinking-effort command and leaves workflow unclaimed", () => {
    expect(allCommands.some((command) => command.name === "effort")).toBe(true);
    expect(allCommands.some((command) => command.name === "think")).toBe(false);
    expect(allCommands.find((command) => command.name === "engine")?.aliases).toBeUndefined();
  });

  test("persists the canonical medium effort", async () => {
    let messages: Message[] = [];
    let selected: ReasoningTier | undefined;
    let persisted: ReasoningTier | undefined;
    const ctx = {
      setMessages(updater: (previous: Message[]) => Message[]) {
        messages = updater(messages);
      },
      thinkingTier: () => selected,
      setThinkingTier(tier: ReasoningTier | undefined) {
        selected = tier;
      },
      async persistThinkingSwitch(tier: ReasoningTier | undefined) {
        persisted = tier;
      },
      setStatus() {},
      recordActivity() {},
    } as unknown as ProviderCommandContext;
    const command = createProviderCommands(ctx).find((entry) => entry.name === "effort");
    if (!command) throw new Error("Missing /effort command.");

    await command.run("medium", "/effort medium");

    expect(selected).toBe("medium");
    expect(persisted).toBe("medium");
    expect(messages.at(-1)?.content).toBe("Thinking effort set to medium.");
  });
});
