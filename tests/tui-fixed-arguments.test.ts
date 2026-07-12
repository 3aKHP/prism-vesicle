import { describe, expect, test } from "bun:test";
import {
  completeAgentArgument,
  completeFixedArgument,
  fixedArgumentOptions,
  matchOptionItems,
  parseAgentArgumentDraft,
  parseFixedArgumentDraft,
} from "../src/tui/commands/argument-completion";

describe("fixed slash-command argument completion", () => {
  test("recognizes engine, effort, and reasoning argument positions", () => {
    expect(parseFixedArgumentDraft("/engine ")).toEqual({ command: "engine", query: "" });
    expect(parseFixedArgumentDraft("/effort hi")).toEqual({ command: "effort", query: "hi" });
    expect(parseFixedArgumentDraft("/reasoning pre")).toEqual({ command: "reasoning", query: "pre" });
    expect(parseFixedArgumentDraft("/workflow run")).toBeNull();
    expect(parseFixedArgumentDraft("/think hi")).toBeNull();
    expect(parseFixedArgumentDraft("/resume ")).toBeNull();
  });

  test("offers every engine id from the engine registry", () => {
    expect(fixedArgumentOptions("engine").map((item) => item.id)).toEqual([
      "etl",
      "runtime",
      "evaluate",
      "weaver",
      "weaver-orch",
      "dyad",
    ]);
  });

  test("offers canonical effort tiers plus provider-default auto", () => {
    expect(fixedArgumentOptions("effort").map((item) => item.id)).toEqual([
      "off",
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
      "auto",
    ]);
    expect(matchOptionItems("medium", fixedArgumentOptions("effort"))[0]?.id).toBe("medium");
    expect(matchOptionItems("default", fixedArgumentOptions("effort"))[0]?.id).toBe("auto");
  });

  test("offers canonical reasoning modes while matching their aliases", () => {
    expect(fixedArgumentOptions("reasoning").map((item) => item.id)).toEqual([
      "hidden",
      "collapsed",
      "expanded",
    ]);
    expect(matchOptionItems("preview", fixedArgumentOptions("reasoning"))[0]?.id).toBe("collapsed");
    expect(matchOptionItems("off", fixedArgumentOptions("reasoning"))[0]?.id).toBe("hidden");
  });

  test("completes the selected canonical argument", () => {
    expect(completeFixedArgument(
      { command: "engine", query: "run" },
      { id: "runtime", label: "runtime" },
    )).toBe("/engine runtime");
  });

  test("parses and completes handle-based Agent commands", () => {
    expect(parseAgentArgumentDraft("/agents exp")).toEqual({ stage: "command", query: "exp" });
    expect(parseAgentArgumentDraft("/agents stop rev")).toEqual({ stage: "stop", query: "rev" });
    expect(completeAgentArgument(
      { stage: "command", query: "" },
      { id: "stop", label: "stop" },
    )).toBe("/agents stop ");
    expect(completeAgentArgument(
      { stage: "command", query: "ret" },
      { id: "retry", label: "retry" },
    )).toBe("/agents retry");
    expect(completeAgentArgument(
      { stage: "stop", query: "exp" },
      { id: "explore-1", label: "explore-1" },
    )).toBe("/agents stop explore-1");
  });
});
