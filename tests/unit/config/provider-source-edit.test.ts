import { describe, expect, test } from "bun:test";
import {
  appendModelToProviderSource,
  appendProviderToSource,
  removeModelFromSource,
  removeProviderFromSource,
  replaceDefaultSelectionInSource,
  replaceProviderFieldInSource,
} from "../../../src/config/provider-source-edit";
import type { ProviderModelProfile, ProviderProfile } from "../../../src/config/providers";
import {
  capabilityFieldNames,
  generationFieldNames,
  modelEntryFieldNames,
  parseProviderConfig,
} from "../../../src/config/providers";
import { serializeProviderRegistry } from "../../../src/setup/config-writer";

const baseSource = [
  "default:",
  "  provider: first",
  "  model: keep",
  "",
  "providers:",
  "  first:",
  "    protocol: openai-chat-compatible",
  "    baseUrl: https://first.example/v1",
  "    apiKeyEnv: FIRST_API_KEY",
  "    # provider comment",
  "    models:",
  "      - id: keep",
  "        # model rationale",
  "        capabilities:",
  "          builtinWebSearch: true",
  "        webSearchDefault: false # preserve this",
  "      # comment belongs after the last model",
  "",
  "  # second provider docs",
  "  second:",
  "    protocol: openai-chat-compatible",
  "    baseUrl: https://second.example/v1",
  "    apiKeyEnv: SECOND_API_KEY",
  "    models:",
  "      - second-model",
  "",
].join("\n");

const addedModel: ProviderModelProfile = {
  id: "new-model",
  capabilities: { builtinWebSearch: true },
  webSearchDefault: true,
};

describe("provider source editor", () => {
  test("appends a model while preserving unrelated source and emits webSearchDefault", () => {
    const result = appendModelToProviderSource(baseSource, "first", addedModel);
    expect(result).toContain("webSearchDefault: false # preserve this");
    expect(result).toContain("# comment belongs after the last model");
    expect(result).toContain("        webSearchDefault: true");
    expect(result.indexOf("# comment belongs after the last model")).toBeLessThan(result.indexOf("new-model"));
    expect(result).toContain("  second:\n");
  });

  test("appends a provider at the end of the providers section", () => {
    const provider: ProviderProfile = {
      id: "third",
      protocol: "openai-chat-compatible",
      baseUrl: "https://third.example/v1",
      apiKeyEnv: "THIRD_API_KEY",
      models: [{ id: "third-model", webSearchDefault: false }],
    };
    const result = appendProviderToSource(baseSource, provider);
    expect(result.indexOf("  second:")).toBeLessThan(result.indexOf("  third:"));
    expect(result).toContain("        webSearchDefault: false");
    expect(result).toContain("# provider comment");
  });

  test("replaces provider fields and global defaults without rebuilding the file", () => {
    let result = replaceProviderFieldInSource(baseSource, "first", "userAgent", '"client dev/1"');
    result = replaceDefaultSelectionInSource(result, "model", "new-model");
    expect(result).toContain('    userAgent: "client dev/1"');
    expect(result).toContain("  model: new-model");
    expect(result).toContain("# preserve this");
    expect(result).toContain("  second:\n");
  });

  test("preserves inline comment spacing when replacing a value", () => {
    const source = baseSource
      .replace("  model: keep", "  model: keep  # global selection")
      .replace("    baseUrl: https://first.example/v1", "    baseUrl: https://first.example/v1  # endpoint");
    let result = replaceProviderFieldInSource(source, "first", "baseUrl", "https://changed.example/v1");
    result = replaceDefaultSelectionInSource(result, "model", "changed");
    expect(result).toContain("    baseUrl: https://changed.example/v1  # endpoint");
    expect(result).toContain("  model: changed  # global selection");
  });

  test("removes only the requested model and provider", () => {
    const withoutModel = removeModelFromSource(baseSource, "first", "keep");
    expect(withoutModel).not.toContain("- id: keep");
    expect(withoutModel).not.toContain("# model rationale");
    expect(withoutModel).toContain("# comment belongs after the last model");
    expect(withoutModel).toContain("  second:\n");

    const withoutProvider = removeProviderFromSource(baseSource, "first");
    expect(withoutProvider).not.toContain("  first:\n");
    expect(withoutProvider).not.toContain("# provider comment");
    expect(withoutProvider).toContain("  # second provider docs\n  second:");
    expect(withoutProvider).toContain("  second:\n");
    expect(withoutProvider).toContain("default:\n  provider: first");
  });

  test("normalizes CRLF and supports a source without a final newline", () => {
    const source = baseSource.replace(/\n/g, "\r\n").replace(/\r\n$/, "");
    const result = appendModelToProviderSource(source, "first", { id: "tail" });
    expect(result).not.toContain("\r\n");
    expect(result.endsWith("\n")).toBe(false);
    expect(result).toContain("      - tail");
  });

  test("rejects missing providers, models, and model targets", () => {
    expect(() => appendModelToProviderSource("default:\n  provider: x\n", "x", { id: "m" })).toThrow("providers:");
    expect(() => appendModelToProviderSource(baseSource.replace("    models:", "    # models removed"), "first", { id: "m" })).toThrow("models");
    expect(() => removeModelFromSource(baseSource, "first", "missing")).toThrow("missing");
  });

  test("round-trips every supported model-level field without semantic loss", () => {
    const completeModel = {
      id: "complete",
      generation: {
        temperature: 0.4,
        maxTokens: 8192,
      } satisfies Record<(typeof generationFieldNames)[number], number>,
      capabilities: {
        streaming: true,
        tools: true,
        reasoningTier: true,
        reasoningContent: true,
        temperature: true,
        maxTokens: true,
        vision: true,
        remoteCompact: true,
        builtinWebSearch: true,
      } satisfies Record<(typeof capabilityFieldNames)[number], boolean>,
      limits: {
        contextWindow: 100000,
        maxOutputTokens: 8192,
        autoCompact: { enabled: true, threshold: 0.8, reserveOutputTokens: 8192 },
      },
      webSearchDefault: true,
    } satisfies ProviderModelProfile & Record<(typeof modelEntryFieldNames)[number], unknown>;
    const serialized = serializeProviderRegistry({
      source: "file",
      default: { provider: "complete", model: "complete" },
      providers: [{
        id: "complete",
        protocol: "openai-chat-compatible",
        baseUrl: "https://complete.example/v1",
        apiKeyEnv: "COMPLETE_API_KEY",
        models: [completeModel],
      }],
    });
    const reparsed = parseProviderConfig(serialized, "providers.yaml", {});
    expect(reparsed.providers[0]?.models[0]).toEqual(completeModel);
  });
});
