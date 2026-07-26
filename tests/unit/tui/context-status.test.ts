import { describe, expect, test } from "bun:test";
import { renderContextStatus } from "../../../src/tui/commands/builtin";

type Ctx = Parameters<typeof renderContextStatus>[0];

function mockCtx(options: {
  contextWindow?: number;
  autoCompact?: { enabled?: boolean; threshold?: number; reserveOutputTokens?: number };
  maxOutputTokens?: number;
  contextInputTokens?: number;
}): Ctx {
  return {
    activeModelLimits: () => ({
      ...(options.contextWindow !== undefined ? { contextWindow: options.contextWindow } : {}),
      ...(options.maxOutputTokens !== undefined ? { maxOutputTokens: options.maxOutputTokens } : {}),
      ...(options.autoCompact ? { autoCompact: options.autoCompact } : {}),
    }),
    lastTurnUsage: () => (options.contextInputTokens !== undefined
      ? { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, contextInputTokens: options.contextInputTokens }
      : undefined),
    sessionUsage: () => ({ inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, contextInputTokens: 0 }),
    activeProvider: () => "test",
    activeModel: () => "m",
  } as unknown as Ctx;
}

describe("/context status", () => {
  test("an active config reports the soft trigger, hard ceiling, reserve source, and strategy", () => {
    const out = renderContextStatus(mockCtx({ contextWindow: 10_000, autoCompact: { enabled: true, threshold: 0.8, reserveOutputTokens: 2_000 }, contextInputTokens: 8_500 }));
    expect(out).toContain("Soft trigger:");
    expect(out).toContain("Hard input ceiling:");
    expect(out).toContain("Output reserve: 2.0k (from autoCompact.reserveOutputTokens)");
    expect(out).toContain("Auto compact: active · strategy portable-summary");
    expect(out).toContain("provider usage");
  });

  test("a missing threshold reports inactive with a reason, not 'enabled'", () => {
    const out = renderContextStatus(mockCtx({ contextWindow: 10_000, autoCompact: { enabled: true } }));
    expect(out).toContain("Auto compact: inactive · threshold not set");
    expect(out).not.toMatch(/Auto compact: enabled/);
  });

  test("a missing context window reports inactive with a reason", () => {
    const out = renderContextStatus(mockCtx({ autoCompact: { enabled: true, threshold: 0.8 } }));
    expect(out).toContain("Context window: not configured");
    expect(out).toContain("Auto compact: inactive · limits.contextWindow not set");
  });

  test("disabled config reports inactive disabled", () => {
    const out = renderContextStatus(mockCtx({ contextWindow: 10_000, autoCompact: { enabled: false, threshold: 0.8 } }));
    expect(out).toContain("Auto compact: inactive · enabled: false");
  });

  test("no autoCompact block reports not configured", () => {
    const out = renderContextStatus(mockCtx({ contextWindow: 10_000 }));
    expect(out).toContain("Auto compact: not configured");
  });
});
