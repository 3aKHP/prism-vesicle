import { describe, expect, test } from "bun:test";
import { contextUsageTelemetryLine, footerLine, latestTurnUsage, sessionUsageTelemetryLine, sumSessionUsage, turnUsageTelemetryLine } from "../../../src/tui/app";
import { renderComposerLines } from "../../../src/tui/PromptComposer";
import { sharedSyntaxStyle } from "../../../src/tui/theme";
import { displayWidth, padDisplayEnd, truncateLine, truncateMiddle, wrapDisplayLines } from "../../../src/tui/format";
import { layoutComposerText } from "../../../src/tui/composer-layout";

describe("tui: format and telemetry", () => {
  test("truncates mixed CJK text by terminal columns", () => {
    const value = "路径/非常长的中文文件名.md";
    const family = "👨‍👩‍👧‍👦";
    expect(displayWidth(truncateLine(value, 12))).toBeLessThanOrEqual(12);
    expect(displayWidth(truncateMiddle(value, 12))).toBeLessThanOrEqual(12);
    expect(displayWidth(padDisplayEnd("中文", 8))).toBe(8);
    expect(displayWidth("1234567❤️")).toBe(Bun.stringWidth("1234567❤️"));
    expect(truncateMiddle(`123456789${family}`, 8)).toEndWith(family);
    expect(wrapDisplayLines(`AB${family}CD`, 4)).toEqual([`AB${family}`, "CD"]);
    expect(layoutComposerText(`AB${family}CD`, 0, 4, 4).lines.map((line) => line.text)).toEqual([`AB${family}`, "CD"]);
    expect(renderComposerLines(`A${family}B`, 1, "", 20, 2, true)[0]?.cursorChar).toBe(family);
    expect(truncateLine("plain ASCII", 20)).toBe("plain ASCII");
    expect(wrapDisplayLines("word     continuation", 8).slice(1).every((line) => !line.startsWith(" "))).toBe(true);
  });

  test("registers shared markdown and code syntax styles", () => {
    const names = sharedSyntaxStyle.getRegisteredNames();
    expect(names).toContain("markup.heading.2");
    expect(names).toContain("markup.strong");
    expect(names).toContain("keyword");
    expect(names).toContain("string");
    expect(names).toContain("comment");
  });

  test("formats turn and session usage telemetry for the footer", () => {
    expect(turnUsageTelemetryLine({
      inputTokens: 18200,
      outputTokens: 1400,
      cachedInputTokens: 12000,
      contextInputTokens: 18200,
    })).toBe("turn ↑18.2k ↓1.4k ↻ 12.0k");
    expect(contextUsageTelemetryLine({
      inputTokens: 18200,
      outputTokens: 1400,
      cachedInputTokens: 12000,
      contextInputTokens: 18200,
    }, { contextWindow: 1_000_000 })).toBe("ctx 18.2k/1.0M 2%");

    const wideFooter = footerLine("deepseek", "reasoner", true, 160, {
      inputTokens: 18200,
      outputTokens: 1400,
      cachedInputTokens: 12000,
      contextInputTokens: 18200,
    }, {
      inputTokens: 42000,
      outputTokens: 6200,
      cachedInputTokens: 18000,
      contextInputTokens: 42000,
    }, { contextWindow: 1_000_000 });
    expect(wideFooter).toContain("deepseek/reasoner · key ok · turn ↑18.2k ↓1.4k ↻ 12.0k · session ↑42.0k ↓6.2k ↻ 18.0k");
    expect(wideFooter.endsWith("ctx 18.2k/1.0M 2%")).toBe(true);
    expect(/↻ 18\.0k {4,}ctx/.test(wideFooter)).toBe(true);

    expect(footerLine("deepseek", "reasoner", true, 58, {
      inputTokens: 18200,
      outputTokens: 1400,
      cachedInputTokens: 12000,
      contextInputTokens: 18200,
    }, {
      inputTokens: 42000,
      outputTokens: 6200,
      cachedInputTokens: 18000,
      contextInputTokens: 42000,
    }, { contextWindow: 1_000_000 }).endsWith("ctx 18.2k/1.0M 2%")).toBe(true);
  });

  test("aggregates logical turn usage for the footer without double-counting tool-loop context", () => {
    expect(sessionUsageTelemetryLine({
      inputTokens: 42000,
      outputTokens: 6200,
      cachedInputTokens: 18000,
      contextInputTokens: 42000,
    })).toBe("session ↑42.0k ↓6.2k ↻ 18.0k");

    const messages = [
      {
        role: "user" as const,
        content: "first prompt",
      },
      {
        role: "assistant" as const,
        content: "first",
        usage: { inputTokens: 500, outputTokens: 50, contextInputTokens: 500, cacheReadInputTokens: 100, reasoningTokens: 10, effectiveTokens: 450 },
      },
      {
        role: "user" as const,
        content: "second prompt",
      },
      {
        role: "assistant" as const,
        content: "second tool call",
        usage: { inputTokens: 1000, outputTokens: 100, contextInputTokens: 1000, cacheReadInputTokens: 300, reasoningTokens: 20, effectiveTokens: 800 },
      },
      {
        role: "tool" as const,
        content: "{}",
      },
      {
        role: "tool" as const,
        content: "subagent result",
        kind: "subagent-result",
        usage: { inputTokens: 300, outputTokens: 30, cacheReadInputTokens: 50 },
      },
      {
        role: "assistant" as const,
        content: "second final",
        usage: { inputTokens: 2000, outputTokens: 200, contextInputTokens: 2000, cacheHitInputTokens: 500, reasoningTokens: 30, effectiveTokens: 1700 },
      },
      {
        role: "user" as const,
        content: "[engine_handoff]\nSource: model_request\n[/engine_handoff]",
        kind: "engine-handoff",
      },
    ];

    expect(sumSessionUsage(messages)).toEqual({
      inputTokens: 2800,
      outputTokens: 380,
      cachedInputTokens: 650,
      contextInputTokens: 2000,
    });
    expect(latestTurnUsage(messages)).toEqual({
      inputTokens: 2300,
      outputTokens: 330,
      cachedInputTokens: 550,
      contextInputTokens: 2000,
    });
  });

});
