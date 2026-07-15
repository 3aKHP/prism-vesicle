import { describe, expect, test } from "bun:test";
import { builtinCommands } from "../src/tui/commands/builtin";
import type { CommandContext } from "../src/tui/commands/types";
import type { Message } from "../src/tui/types";

describe("/agents command", () => {
  test("renders host Agent Profile and child status output", async () => {
    const command = builtinCommands.find((entry) => entry.name === "agents");
    if (!command) throw new Error("Missing /agents command.");
    let messages: Message[] = [];
    const ctx = {
      async agentCommand(args: string) {
        expect(args).toBe("");
        return "Agent Profiles:\n  explore [background/fresh]\n\nCurrent session SubAgents:\n  explore-1 [running/background] Explore";
      },
      setMessages(updater: (previous: Message[]) => Message[]) {
        messages = updater(messages);
      },
    } as unknown as CommandContext;

    await command.run(ctx, "", "/agents");
    expect(messages[0]).toEqual({ role: "user", content: "/agents" });
    expect(messages[1]?.content).toContain("explore-1 [running/background]");
  });
});
