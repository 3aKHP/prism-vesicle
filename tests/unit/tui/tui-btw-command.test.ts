import { describe, expect, test } from "bun:test";
import { createAgentsCommands } from "../../../src/tui/commands/agents";
import type { AgentsCommandContext } from "../../../src/tui/commands/types";

describe("/btw command", () => {
  test("is registered as immediate so it runs while the Agent Loop is busy", () => {
    const command = createAgentsCommands({} as unknown as AgentsCommandContext).find((entry) => entry.name === "btw");
    if (!command) throw new Error("Missing /btw command.");
    const behavior = typeof command.busyBehavior === "function"
      ? command.busyBehavior("anything")
      : command.busyBehavior;
    expect(behavior).toEqual({ kind: "immediate" });
  });

  test("dispatches to openSideQuestion and never mutates the main transcript", async () => {
    let setMessagesCalls = 0;
    let openedWith: string | undefined;
    const ctx = {
      setMessages() { setMessagesCalls += 1; },
      async openSideQuestion(args: string) { openedWith = args; },
    } as unknown as AgentsCommandContext;
    const command = createAgentsCommands(ctx).find((entry) => entry.name === "btw");
    if (!command) throw new Error("Missing /btw command.");

    await command.run("what is this?", "/btw what is this?");

    expect(openedWith).toBe("what is this?");
    expect(setMessagesCalls).toBe(0);
  });

  test("bare /btw forwards an empty argument string", async () => {
    let openedWith: string | undefined;
    const ctx = {
      setMessages() {},
      async openSideQuestion(args: string) { openedWith = args; },
    } as unknown as AgentsCommandContext;
    const command = createAgentsCommands(ctx).find((entry) => entry.name === "btw");
    if (!command) throw new Error("Missing /btw command.");

    await command.run("", "/btw");

    expect(openedWith).toBe("");
  });
});
