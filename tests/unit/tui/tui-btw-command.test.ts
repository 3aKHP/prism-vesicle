import { describe, expect, test } from "bun:test";
import { builtinCommands } from "../../../src/tui/commands/builtin";
import type { CommandContext } from "../../../src/tui/commands/types";

describe("/btw command", () => {
  test("is registered as immediate so it runs while the Agent Loop is busy", () => {
    const command = builtinCommands.find((entry) => entry.name === "btw");
    if (!command) throw new Error("Missing /btw command.");
    const behavior = typeof command.busyBehavior === "function"
      ? command.busyBehavior("anything")
      : command.busyBehavior;
    expect(behavior).toEqual({ kind: "immediate" });
  });

  test("dispatches to openSideQuestion and never mutates the main transcript", async () => {
    const command = builtinCommands.find((entry) => entry.name === "btw");
    if (!command) throw new Error("Missing /btw command.");
    let setMessagesCalls = 0;
    let openedWith: string | undefined;
    const ctx = {
      setMessages() { setMessagesCalls += 1; },
      async openSideQuestion(args: string) { openedWith = args; },
    } as unknown as CommandContext;

    await command.run(ctx, "what is this?", "/btw what is this?");

    expect(openedWith).toBe("what is this?");
    expect(setMessagesCalls).toBe(0);
  });

  test("bare /btw forwards an empty argument string", async () => {
    const command = builtinCommands.find((entry) => entry.name === "btw");
    if (!command) throw new Error("Missing /btw command.");
    let openedWith: string | undefined;
    const ctx = {
      setMessages() {},
      async openSideQuestion(args: string) { openedWith = args; },
    } as unknown as CommandContext;

    await command.run(ctx, "", "/btw");

    expect(openedWith).toBe("");
  });
});
