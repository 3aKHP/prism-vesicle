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

  test("loads provider registry from the configured global providers file", async () => {
    const { rootDir, env } = await writeProvidersFile([
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
      "    apiKeyEnv: LOCAL_OPENAI_COMPAT_API_KEY",
      "    models:",
      "      - qwen3",
      "",
    ]);

    const registry = await loadProviderRegistry(rootDir, { ...env, DEEPSEEK_API_KEY: "secret" });
    const config = await loadConfigForSelection(rootDir, { provider: "deepseek", model: "deepseek-reasoner" }, { ...env, DEEPSEEK_API_KEY: "secret" });

    expect(registry.source).toBe("file");
    expect(registry.providers.map((provider) => provider.id)).toEqual(["deepseek", "local"]);
    expect(config.providerId).toBe("deepseek");
    expect(config.baseUrl).toBe("https://api.deepseek.com/v1");
    expect(config.model).toBe("deepseek-reasoner");
    expect(config.apiKey).toBe("secret");
  });

  test("rejects model switches outside the configured provider catalog", async () => {
    const { rootDir, env } = await writeProvidersFile([
      "default:",
      "  provider: local",
      "  model: qwen3",
      "providers:",
      "  local:",
      "    protocol: openai-chat-compatible",
      "    baseUrl: http://127.0.0.1:11434/v1",
      "    apiKeyEnv: LOCAL_OPENAI_COMPAT_API_KEY",
      "    models:",
      "      - qwen3",
      "",
    ]);

    await expect(loadConfigForSelection(rootDir, { provider: "local", model: "missing" }, env)).rejects.toThrow(
      'Provider "local" does not declare model "missing".',
    );
  });

  test("preserves hash characters inside quoted provider config values", async () => {
    const { rootDir, env } = await writeProvidersFile([
      "default:",
      "  provider: local",
      "  model: \"qwen#3\"",
      "providers:",
      "  local:",
      "    protocol: openai-chat-compatible",
      "    baseUrl: http://127.0.0.1:11434/v1",
      "    apiKeyEnv: LOCAL_OPENAI_COMPAT_API_KEY",
      "    models:",
      "      - \"qwen#3\"",
      "",
    ]);

    const config = await loadConfigForSelection(rootDir, undefined, { ...env, LOCAL_OPENAI_COMPAT_API_KEY: "local" });

    expect(config.model).toBe("qwen#3");
    expect(config.apiKey).toBe("local");
  });

  test("rejects inline provider api keys in providers.yaml", async () => {
    const { rootDir, env } = await writeProvidersFile([
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
    ]);

    await expect(loadProviderRegistry(rootDir, env)).rejects.toThrow("use apiKeyEnv instead of inline apiKey");
  });
});

async function writeProvidersFile(lines: string[]): Promise<{ rootDir: string; env: NodeJS.ProcessEnv }> {
  const rootDir = await mkdtemp(join(tmpdir(), "vesicle-provider-config-"));
  const configDir = join(rootDir, "config");
  await mkdir(configDir, { recursive: true });
  const configPath = join(configDir, "providers.yaml");
  await writeFile(configPath, lines.join("\n"));
  return { rootDir, env: { VESICLE_PROVIDERS_FILE: configPath } };
}
