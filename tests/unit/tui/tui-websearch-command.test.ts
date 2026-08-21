import { describe, expect, test } from "bun:test";
import { createWebSearchCommands } from "../../../src/tui/commands/websearch";
import type { WebSearchCommandContext } from "../../../src/tui/commands/types";
import type { Message } from "../../../src/tui/types";

describe("/websearch command", () => {
  test("does not report status or activity when an override is rejected", async () => {
    let messages: Message[] = [];
    const statuses: string[] = [];
    const activities: string[] = [];
    const context: WebSearchCommandContext = {
      setMessages(updater) { messages = updater(messages); },
      setStatus(status) { statuses.push(status); },
      recordActivity(event) { activities.push(event.text); },
      webSearch: {
        statusText: async () => "unused",
        applyOverride: async () => ({ applied: false, notice: "Search is unavailable." }),
        clearOverride() {},
      },
    };

    const command = createWebSearchCommands(context)[0]!;
    await command.run("on", "/websearch on");

    expect(statuses).toEqual([]);
    expect(activities).toEqual([]);
    expect(messages.at(-1)?.content).toBe("Search is unavailable.");
  });

  test("records status and activity after an override is applied", async () => {
    let messages: Message[] = [];
    const statuses: string[] = [];
    const activities: string[] = [];
    const context: WebSearchCommandContext = {
      setMessages(updater) { messages = updater(messages); },
      setStatus(status) { statuses.push(status); },
      recordActivity(event) { activities.push(event.text); },
      webSearch: {
        statusText: async () => "unused",
        applyOverride: async () => ({ applied: true, notice: "Search is on." }),
        clearOverride() {},
      },
    };

    const command = createWebSearchCommands(context)[0]!;
    await command.run("on", "/websearch on");

    expect(statuses).toEqual(["web search on"]);
    expect(activities).toEqual(["websearch on"]);
    expect(messages.at(-1)?.content).toBe("Search is on.");
  });
});
