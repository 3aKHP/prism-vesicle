import { describe, expect, test } from "bun:test";
import { builtinCommands } from "../../../src/tui/commands/builtin";
import type { CommandContext } from "../../../src/tui/commands/types";
import type { Message } from "../../../src/tui/types";

describe("/workspace command", () => {
  test("is registered as immediate so it switches pages while the Agent Loop is busy", () => {
    const command = builtinCommands.find((entry) => entry.name === "workspace");
    if (!command) throw new Error("Missing /workspace command.");
    const behavior = typeof command.busyBehavior === "function"
      ? command.busyBehavior("")
      : command.busyBehavior;
    expect(behavior).toEqual({ kind: "immediate" });
  });

  test("opens the Workspace page and echoes the key hints", async () => {
    const command = builtinCommands.find((entry) => entry.name === "workspace");
    if (!command) throw new Error("Missing /workspace command.");
    let opened = 0;
    const messages: Message[] = [];
    const ctx = {
      async openWorkspaceTarget() { opened += 1; return null; },
      setStatus() {},
      setMessages(updater: (prev: Message[]) => Message[]) {
        messages.push(...updater([]));
        return messages;
      },
    } as unknown as CommandContext;

    await command.run(ctx, "", "/workspace");

    expect(opened).toBe(1);
    expect(messages[0]).toEqual({ role: "user", content: "/workspace" });
    expect(messages[1]?.role).toBe("system");
    expect(messages[1]?.content).toContain("Workspace page");
    expect(messages[1]?.content).toContain("Ctrl+O");
  });

  test("locates a path argument and reports when it is missing", async () => {
    const command = builtinCommands.find((entry) => entry.name === "workspace");
    if (!command) throw new Error("Missing /workspace command.");
    const opened: (string | undefined)[] = [];
    const messages: Message[] = [];
    const ctx = {
      async openWorkspaceTarget(relPath?: string) {
        opened.push(relPath);
        return relPath === "workspace/cards" ? "dir" : null;
      },
      setStatus() {},
      setMessages(updater: (prev: Message[]) => Message[]) {
        messages.push(...updater([]));
        return messages;
      },
    } as unknown as CommandContext;

    await command.run(ctx, "workspace/cards", "/workspace workspace/cards");
    expect(opened).toEqual(["workspace/cards"]);
    expect(messages[1]?.content).toContain("Opened workspace/cards");

    messages.length = 0;
    await command.run(ctx, "gone.md", "/workspace gone.md");
    expect(messages[1]?.content).toContain("not found");
  });
});
