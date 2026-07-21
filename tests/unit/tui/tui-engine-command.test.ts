import { describe, expect, test } from "bun:test";
import type { EngineTransition } from "../../../src/core/engine/transition";
import { builtinCommands } from "../../../src/tui/commands/builtin";
import type { CommandContext } from "../../../src/tui/commands/types";
import type { Message } from "../../../src/tui/types";

describe("/engine command", () => {
  test("replaces the shape-near /engines listing command", () => {
    expect(builtinCommands.some((command) => command.name === "engine")).toBe(true);
    expect(builtinCommands.some((command) => command.name === "engines")).toBe(false);
  });

  test("lists profiles and marks the active engine when invoked without arguments", async () => {
    const command = builtinCommands.find((entry) => entry.name === "engine");
    if (!command) throw new Error("Missing /engine command.");
    let messages: Message[] = [];
    const ctx = {
      activeEngine: () => "etl",
      setMessages(updater: (previous: Message[]) => Message[]) {
        messages = updater(messages);
      },
    } as unknown as CommandContext;

    await command.run(ctx, "", "/engine");

    expect(messages[1]?.content).toContain("Prism engines:");
    expect(messages[1]?.content).toContain("* ETL (etl)");
    expect(messages[1]?.content).toContain("Use /engine <id> to switch");
  });

  test("/new resets Stage to ETL because Stage requires /stage bootstrap", async () => {
    const command = builtinCommands.find((entry) => entry.name === "new");
    if (!command) throw new Error("Missing /new command.");
    let activeEngine = "stage";
    let messages: Message[] = [];
    const ctx = {
      activeEngine: () => activeEngine,
      setActiveEngine(engine: typeof activeEngine) { activeEngine = engine; },
      resetRewindState() {}, setSessionId() {}, setSessionPath() {}, setConversation() {}, setOutput() {},
      setLastTurnUsage() {}, setSessionUsage() {}, setPendingGate() {}, setPendingEngineSwitch() {}, setPendingUserQuestion() {}, setStatus() {},
      setMessages(updater: (previous: Message[]) => Message[]) { messages = updater(messages); },
    } as unknown as CommandContext;

    await command.run(ctx, "", "/new");

    expect(activeEngine).toBe("etl");
    expect(messages.at(-1)?.content).toContain("Start another Stage narrative with /stage");
  });

  test("/engine stage preserves the current engine and directs the user to /stage", async () => {
    const command = builtinCommands.find((entry) => entry.name === "engine");
    if (!command) throw new Error("Missing /engine command.");
    let activeEngine = "runtime";
    let switched = false;
    let messages: Message[] = [];
    const ctx = {
      activeEngine: () => activeEngine,
      setActiveEngine(engine: typeof activeEngine) { activeEngine = engine; },
      async persistEngineSwitch() { switched = true; },
      setMessages(updater: (previous: Message[]) => Message[]) { messages = updater(messages); },
    } as unknown as CommandContext;

    await command.run(ctx, "stage", "/engine stage");

    expect(activeEngine).toBe("runtime");
    expect(switched).toBe(false);
    expect(messages.at(-1)?.content).toContain("Stage requires /stage");
  });

  test("persists manual switches as direct engine transitions", async () => {
    const command = builtinCommands.find((entry) => entry.name === "engine");
    if (!command) throw new Error("Missing /engine command.");
    let activeEngine = "etl";
    let transition: EngineTransition | undefined;
    let messages: Message[] = [];
    const ctx = {
      activeEngine: () => activeEngine,
      setActiveEngine(engine: typeof activeEngine) {
        activeEngine = engine;
      },
      setStatus() {},
      recordActivity() {},
      async persistEngineSwitch(next: EngineTransition) {
        transition = next;
      },
      setMessages(updater: (previous: Message[]) => Message[]) {
        messages = updater(messages);
      },
    } as unknown as CommandContext;

    await command.run(ctx, "runtime", "/engine runtime");

    expect(activeEngine).toBe("runtime");
    expect(transition).toMatchObject({
      source: "manual",
      decision: "direct",
      fromEngine: "etl",
      toEngine: "runtime",
      contextPolicy: "preserve_full",
    });
    expect(messages.at(-1)?.content).toContain("Engine switched to runtime");
  });

  test("switches with summarized context when --summary is requested", async () => {
    const command = builtinCommands.find((entry) => entry.name === "engine");
    if (!command) throw new Error("Missing /engine command.");
    let activeEngine = "etl";
    let transition: EngineTransition | undefined;
    let compactInstructions: string | undefined;
    let messages: Message[] = [];
    const ctx = {
      activeEngine: () => activeEngine,
      setActiveEngine(engine: typeof activeEngine) {
        activeEngine = engine;
      },
      setStatus() {},
      recordActivity() {},
      async compactSession(instructions?: string) {
        compactInstructions = instructions;
        return { summary: "Compacted handoff summary.", messagesSummarized: 6 };
      },
      async persistEngineSwitch(next: EngineTransition) {
        transition = next;
      },
      setMessages(updater: (previous: Message[]) => Message[]) {
        messages = updater(messages);
      },
    } as unknown as CommandContext;

    await command.run(ctx, "runtime --summary preserve artifacts", "/engine runtime --summary preserve artifacts");

    expect(activeEngine).toBe("runtime");
    expect(compactInstructions).toBe("preserve artifacts");
    expect(transition).toMatchObject({
      source: "manual",
      decision: "direct",
      fromEngine: "etl",
      toEngine: "runtime",
      contextPolicy: "summary",
      contextSummary: "Compacted handoff summary.",
    });
    expect(messages.at(-1)?.content).toContain("summarized context");
  });

  test("/compact delegates to the host compact workflow", async () => {
    const command = builtinCommands.find((entry) => entry.name === "compact");
    if (!command) throw new Error("Missing /compact command.");
    let instructions: string | undefined;
    let messages: Message[] = [];
    const ctx = {
      async compactSession(next?: string) {
        instructions = next;
        return { summary: "Compact summary.", messagesSummarized: 4 };
      },
      setMessages(updater: (previous: Message[]) => Message[]) {
        messages = updater(messages);
      },
    } as unknown as CommandContext;

    await command.run(ctx, "focus on files", "/compact focus on files");

    expect(instructions).toBe("focus on files");
    expect(messages[0]).toEqual({ role: "user", content: "/compact focus on files" });
    expect(messages.at(-1)?.content).toContain("Conversation compacted into a summary (4 messages).");
  });

  test("/context reports configured limits and latest usage", async () => {
    const command = builtinCommands.find((entry) => entry.name === "context");
    if (!command) throw new Error("Missing /context command.");
    let messages: Message[] = [];
    const ctx = {
      activeProvider: () => "deepseek",
      activeModel: () => "deepseek-v4-flash",
      activeModelLimits: () => ({
        contextWindow: 1_000_000,
        maxOutputTokens: 65536,
        autoCompact: {
          enabled: true,
          threshold: 0.85,
          reserveOutputTokens: 20000,
        },
      }),
      lastTurnUsage: () => ({
        inputTokens: 18_700,
        outputTokens: 870,
        cachedInputTokens: 18_600,
        contextInputTokens: 18_700,
      }),
      sessionUsage: () => ({
        inputTokens: 75_300,
        outputTokens: 3_000,
        cachedInputTokens: 70_100,
        contextInputTokens: 18_700,
      }),
      setMessages(updater: (previous: Message[]) => Message[]) {
        messages = updater(messages);
      },
    } as unknown as CommandContext;

    await command.run(ctx, "", "/context");

    expect(messages[0]).toEqual({ role: "user", content: "/context" });
    expect(messages[1]?.content).toContain("deepseek/deepseek-v4-flash");
    expect(messages[1]?.content).toContain("Used: 18.7k / 1.0M (2%)");
    expect(messages[1]?.content).toContain("Auto compact: enabled at 85% (~850.0k)");
    expect(messages[1]?.content).toContain("Session: ↑75.3k ↓3.0k ↻ 70.1k");
  });

  test("/context reports missing contextWindow without guessing", async () => {
    const command = builtinCommands.find((entry) => entry.name === "context");
    if (!command) throw new Error("Missing /context command.");
    let messages: Message[] = [];
    const ctx = {
      activeProvider: () => "local",
      activeModel: () => "qwen3",
      activeModelLimits: () => undefined,
      lastTurnUsage: () => undefined,
      sessionUsage: () => ({ inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, contextInputTokens: 0 }),
      setMessages(updater: (previous: Message[]) => Message[]) {
        messages = updater(messages);
      },
    } as unknown as CommandContext;

    await command.run(ctx, "", "/context");

    expect(messages[1]?.content).toContain("Context window: not configured");
    expect(messages[1]?.content).toContain("providers.yaml");
    expect(messages[1]?.content).toContain("Source: model config only");
  });
});
