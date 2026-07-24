import { describe, expect, test } from "bun:test";
import { builtinCommands } from "../../../src/tui/commands/builtin";
import type { CommandContext } from "../../../src/tui/commands/types";

describe("/workspace command", () => {
  test("is registered as immediate so it switches pages while the Agent Loop is busy", () => {
    const command = builtinCommands.find((entry) => entry.name === "workspace");
    if (!command) throw new Error("Missing /workspace command.");
    const behavior = typeof command.busyBehavior === "function"
      ? command.busyBehavior("")
      : command.busyBehavior;
    expect(behavior).toEqual({ kind: "immediate" });
  });

  test("opens the Workspace page and echoes into the transcript", async () => {
    const command = builtinCommands.find((entry) => entry.name === "workspace");
    if (!command) throw new Error("Missing /workspace command.");
    let opened = 0;
    const messages: { role: string; content: string }[] = [];
    const ctx = {
      openWorkspacePage() { opened += 1; },
      setStatus() {},
      setMessages(updater: (prev: { role: string; content: string }[]) => { role: string; content: string }[]) {
        messages.push(...updater([]));
      },
    } as unknown as CommandContext;

    await command.run(ctx, "", "/workspace");

    expect(opened).toBe(1);
    expect(messages[0]).toEqual({ role: "user", content: "/workspace" });
    expect(messages[1]?.role).toBe("system");
    expect(messages[1]?.content).toContain("Workspace page");
    expect(messages[1]?.content).toContain("Ctrl+O");
  });
});
