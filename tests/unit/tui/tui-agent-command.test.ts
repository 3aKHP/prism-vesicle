import { describe, expect, test } from "bun:test";
import { createAgentsCommands } from "../../../src/tui/commands/agents";
import type { AgentsCommandContext } from "../../../src/tui/commands/types";
import type { Message } from "../../../src/tui/types";

describe("/agents command", () => {
  test("renders host Agent Profile and child status output", async () => {
    let messages: Message[] = [];
    const ctx = {
      async agentCommand(args: string) {
        expect(args).toBe("");
        return "Agent Profiles:\n  explore [background/fresh]\n\nCurrent session SubAgents:\n  explore-1 [running/background] Explore";
      },
      setMessages(updater: (previous: Message[]) => Message[]) {
        messages = updater(messages);
      },
    } as unknown as AgentsCommandContext;
    const command = createAgentsCommands(ctx).find((entry) => entry.name === "agents");
    if (!command) throw new Error("Missing /agents command.");

    await command.run("", "/agents");
    expect(messages[0]).toEqual({ role: "user", content: "/agents" });
    expect(messages[1]?.content).toContain("explore-1 [running/background]");
  });
});
