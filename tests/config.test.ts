import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { inspectConfig, loadConfig } from "../src/config/env";
import { loadConfigForSelection, loadProviderRegistry } from "../src/config/providers";

describe("config loading", () => {
  test("loads OpenAI-compatible defaults", () => {
    const config = loadConfig({});

    expect(config.provider).toBe("openai-chat-compatible");
    expect(config.baseUrl).toBe("https://api.openai.com/v1");
    expect(config.model).toBe("gpt-4.1-mini");
  });

  test("reports missing API key", () => {
    const status = inspectConfig({
      VESICLE_BASE_URL: "https://example.test/v1",
      VESICLE_MODEL: "test-model",
      VESICLE_PROVIDER: "openai-chat-compatible",
    });

    expect(status.hasApiKey).toBe(false);
    expect(status.missing).toContain("VESICLE_API_KEY");
  });

  test("loads provider registry from .vesicle/providers.yaml", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "vesicle-provider-config-"));
    await mkdir(join(rootDir, ".vesicle"), { recursive: true });
    await writeFile(join(rootDir, ".vesicle", "providers.yaml"), [
      "default:",
      "  provider: deepseek",
      "  model: deepseek-v4-flash",
      "providers:",
      "  deepseek:",
      "    protocol: openai-chat-compatible",
      "    baseUrl: https://api.deepseek.com/v1/",
      "    apiKeyEnv: DEEPSEEK_API_KEY",
      "    models:",
      "      - deepseek-v4-flash",
      "      - deepseek-reasoner",
      "  local:",
      "    protocol: openai-chat-compatible",
      "    baseUrl: http://127.0.0.1:11434/v1",
      "    apiKey: local",
      "    models:",
      "      - qwen3",
      "",
    ].join("\n"));

    const registry = await loadProviderRegistry(rootDir, { DEEPSEEK_API_KEY: "secret" });
    const config = await loadConfigForSelection(rootDir, { provider: "deepseek", model: "deepseek-reasoner" }, { DEEPSEEK_API_KEY: "secret" });

    expect(registry.source).toBe("file");
    expect(registry.providers.map((provider) => provider.id)).toEqual(["deepseek", "local"]);
    expect(config.providerId).toBe("deepseek");
    expect(config.baseUrl).toBe("https://api.deepseek.com/v1");
    expect(config.model).toBe("deepseek-reasoner");
    expect(config.apiKey).toBe("secret");
  });

  test("rejects model switches outside the configured provider catalog", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "vesicle-provider-config-"));
    await mkdir(join(rootDir, ".vesicle"), { recursive: true });
    await writeFile(join(rootDir, ".vesicle", "providers.yaml"), [
      "default:",
      "  provider: local",
      "  model: qwen3",
      "providers:",
      "  local:",
      "    protocol: openai-chat-compatible",
      "    baseUrl: http://127.0.0.1:11434/v1",
      "    apiKey: local",
      "    models:",
      "      - qwen3",
      "",
    ].join("\n"));

    await expect(loadConfigForSelection(rootDir, { provider: "local", model: "missing" })).rejects.toThrow(
      'Provider "local" does not declare model "missing".',
    );
  });

  test("preserves hash characters inside quoted provider config values", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "vesicle-provider-config-"));
    await mkdir(join(rootDir, ".vesicle"), { recursive: true });
    await writeFile(join(rootDir, ".vesicle", "providers.yaml"), [
      "default:",
      "  provider: local",
      "  model: qwen3",
      "providers:",
      "  local:",
      "    protocol: openai-chat-compatible",
      "    baseUrl: http://127.0.0.1:11434/v1",
      "    apiKey: \"abc#def\"",
      "    models:",
      "      - qwen3",
      "",
    ].join("\n"));

    const config = await loadConfigForSelection(rootDir);

    expect(config.apiKey).toBe("abc#def");
  });
});
