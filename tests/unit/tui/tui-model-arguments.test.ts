import { describe, expect, test } from "bun:test";
import {
  completeModelArgument,
  matchOptionItems,
  parseModelArgumentDraft,
} from "../../../src/tui/commands/argument-completion";
import type { OptionItem } from "../../../src/tui/types";

const providers: OptionItem[] = [
  { id: "deepseek", label: "deepseek", detail: "OpenAI compatible" },
  { id: "mimo", label: "mimo", detail: "Anthropic messages" },
];

describe("/model argument completion", () => {
  test("opens provider completion after the first space", () => {
    expect(parseModelArgumentDraft("/model")).toBeNull();
    expect(parseModelArgumentDraft("/model ")).toEqual({ stage: "provider", query: "" });
    expect(parseModelArgumentDraft("/MODEL dee")).toEqual({ stage: "provider", query: "dee" });
  });

  test("opens model completion after the provider and second space", () => {
    expect(parseModelArgumentDraft("/model deepseek ")).toEqual({
      stage: "model",
      providerId: "deepseek",
      query: "",
    });
    expect(parseModelArgumentDraft("/model deepseek reason")).toEqual({
      stage: "model",
      providerId: "deepseek",
      query: "reason",
    });
  });

  test("ranks exact and prefix option matches before detail matches", () => {
    expect(matchOptionItems("mi", providers).map((item) => item.id)).toEqual(["mimo"]);
    expect(matchOptionItems("messages", providers).map((item) => item.id)).toEqual(["mimo"]);
    expect(matchOptionItems("missing", providers)).toEqual([]);
  });

  test("completes providers into model stage and models into executable input", () => {
    expect(completeModelArgument({ stage: "provider", query: "dee" }, providers[0])).toBe("/model deepseek ");
    expect(completeModelArgument(
      { stage: "model", providerId: "deepseek", query: "reas" },
      { id: "deepseek-reasoner", label: "deepseek-reasoner" },
    )).toBe("/model deepseek deepseek-reasoner");
  });
});
