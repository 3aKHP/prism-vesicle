import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadConfigForSelection, loadProviderRegistry } from "../src/config/providers";

const tempDirs: string[] = [];

afterEach(async () => {
  const dirs = tempDirs.splice(0);
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("config loading", () => {
  test("requires a provider registry file instead of legacy single-key env fallback", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "vesicle-missing-provider-config-"));
    tempDirs.push(rootDir);
    const env = {
      VESICLE_CONFIG_DIR: join(rootDir, "config"),
      VESICLE_API_KEY: "legacy-key",
      VESICLE_BASE_URL: "https://example.test/v1",
      VESICLE_MODEL: "test-model",
    };

    await expect(loadProviderRegistry(env)).rejects.toThrow("Provider config not found");
  });

  test("reports a missing explicit VESICLE_PROVIDERS_FILE path clearly", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "vesicle-missing-explicit-provider-config-"));
    tempDirs.push(rootDir);
    const configPath = join(rootDir, "missing.yaml");

    await expect(loadProviderRegistry({ VESICLE_PROVIDERS_FILE: configPath })).rejects.toThrow(
      "VESICLE_PROVIDERS_FILE points to a provider config that does not exist",
    );
  });

  test("loads provider registry from the configured global providers file", async () => {
    const { env } = await writeProvidersFile([
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
    ], ["DEEPSEEK_API_KEY=secret"]);

    const registry = await loadProviderRegistry(env);
    const config = await loadConfigForSelection({ provider: "deepseek", model: "deepseek-reasoner" }, env);

    expect(registry.source).toBe("file");
    expect(registry.providers.map((provider) => provider.id)).toEqual(["deepseek", "local"]);
    expect(config.providerId).toBe("deepseek");
    expect(config.baseUrl).toBe("https://api.deepseek.com/v1");
    expect(config.model).toBe("deepseek-reasoner");
    expect(config.apiKey).toBe("secret");
  });

  test("loads object model generation defaults and capabilities", async () => {
    const { env } = await writeProvidersFile([
      "default:",
      "  provider: deepseek",
      "  model: deepseek-reasoner",
      "providers:",
      "  deepseek:",
      "    protocol: openai-chat-compatible",
      "    baseUrl: https://api.deepseek.com/v1",
      "    apiKeyEnv: DEEPSEEK_API_KEY",
      "    models:",
      "      - deepseek-v4-flash",
      "      - id: deepseek-reasoner",
      "        generation:",
      "          temperature: 0.4",
      "          maxTokens: 8192",
      "        capabilities:",
      "          streaming: true",
      "          tools: true",
      "          reasoningTier: true",
      "          reasoningContent: true",
      "",
    ], ["DEEPSEEK_API_KEY=secret"]);

    const registry = await loadProviderRegistry(env);
    const config = await loadConfigForSelection(undefined, env);

    expect(registry.providers[0].models.map((model) => model.id)).toEqual(["deepseek-v4-flash", "deepseek-reasoner"]);
    expect(config.generation).toEqual({ temperature: 0.4, maxTokens: 8192 });
    expect(config.capabilities).toMatchObject({
      streaming: true,
      tools: true,
      reasoningTier: true,
      reasoningContent: true,
    });
  });

  test("loads Anthropic Messages provider profiles", async () => {
    const { env } = await writeProvidersFile([
      "default:",
      "  provider: anthropic",
      "  model: claude-sonnet",
      "providers:",
      "  anthropic:",
      "    protocol: anthropic-messages",
      "    baseUrl: https://api.anthropic.com/v1",
      "    apiKeyEnv: ANTHROPIC_API_KEY",
      "    authMethod: x-api-key",
      "    models:",
      "      - id: claude-sonnet",
      "        generation:",
      "          maxTokens: 4096",
      "        capabilities:",
      "          tools: true",
      "          reasoningTier: true",
      "",
    ], ["ANTHROPIC_API_KEY=secret"]);

    const config = await loadConfigForSelection(undefined, env);

    expect(config).toMatchObject({
      provider: "anthropic-messages",
      providerId: "anthropic",
      model: "claude-sonnet",
      authMethod: "x-api-key",
      apiKey: "secret",
      generation: { maxTokens: 4096 },
      capabilities: { tools: true, reasoningTier: true },
    });
  });

  test("rejects duplicate model ids across string and object entries", async () => {
    const { env } = await writeProvidersFile([
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
      "      - id: qwen3",
      "",
    ]);

    await expect(loadProviderRegistry(env)).rejects.toThrow('Provider "local" declares duplicate model "qwen3".');
  });

  test("preserves colon-bearing string model ids", async () => {
    const { env } = await writeProvidersFile([
      "default:",
      "  provider: local",
      "  model: anthropic:claude-3-opus",
      "providers:",
      "  local:",
      "    protocol: openai-chat-compatible",
      "    baseUrl: http://127.0.0.1:11434/v1",
      "    apiKeyEnv: LOCAL_OPENAI_COMPAT_API_KEY",
      "    models:",
      "      - anthropic:claude-3-opus",
      "",
    ]);

    const registry = await loadProviderRegistry(env);

    expect(registry.providers[0].models[0].id).toBe("anthropic:claude-3-opus");
  });

  test("prefers the user-level provider .env over inherited process variables", async () => {
    const { env } = await writeProvidersFile([
      "default:",
      "  provider: deepseek",
      "  model: deepseek-v4-flash",
      "providers:",
      "  deepseek:",
      "    protocol: openai-chat-compatible",
      "    baseUrl: https://api.deepseek.com/v1",
      "    apiKeyEnv: DEEPSEEK_API_KEY",
      "    models:",
      "      - deepseek-v4-flash",
      "",
    ], ["DEEPSEEK_API_KEY=file-secret"]);

    const config = await loadConfigForSelection(undefined, { ...env, DEEPSEEK_API_KEY: "process-secret" });

    expect(config.apiKey).toBe("file-secret");
  });

  test("rejects model switches outside the configured provider catalog", async () => {
    const { env } = await writeProvidersFile([
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

    await expect(loadConfigForSelection({ provider: "local", model: "missing" }, env)).rejects.toThrow(
      'Provider "local" does not declare model "missing".',
    );
  });

  test("preserves hash characters inside quoted provider config values", async () => {
    const { env } = await writeProvidersFile([
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
    ], ["LOCAL_OPENAI_COMPAT_API_KEY=local"]);

    const config = await loadConfigForSelection(undefined, env);

    expect(config.model).toBe("qwen#3");
    expect(config.apiKey).toBe("local");
  });

  test("rejects inline provider api keys in providers.yaml", async () => {
    const { env } = await writeProvidersFile([
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

    await expect(loadProviderRegistry(env)).rejects.toThrow("use apiKeyEnv instead of inline apiKey");
  });

  test("reports bare export statements in provider .env files clearly", async () => {
    const { env } = await writeProvidersFile([
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
    ], ["export LOCAL_OPENAI_COMPAT_API_KEY"]);

    await expect(loadProviderRegistry(env)).rejects.toThrow("use KEY=value syntax, not bare export statements");
  });

  test("rejects duplicate provider ids", async () => {
    const { env } = await writeProvidersFile([
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
      "  local:",
      "    protocol: openai-chat-compatible",
      "    baseUrl: http://127.0.0.1:11435/v1",
      "    apiKeyEnv: LOCAL_OPENAI_COMPAT_API_KEY",
      "    models:",
      "      - qwen4",
      "",
    ]);

    await expect(loadProviderRegistry(env)).rejects.toThrow('Duplicate provider id "local".');
  });
});

async function writeProvidersFile(lines: string[], envLines: string[] = []): Promise<{ env: NodeJS.ProcessEnv }> {
  const rootDir = await mkdtemp(join(tmpdir(), "vesicle-provider-config-"));
  tempDirs.push(rootDir);
  const configDir = join(rootDir, "config");
  await mkdir(configDir, { recursive: true });
  const configPath = join(configDir, "providers.yaml");
  await writeFile(configPath, lines.join("\n"));
  if (envLines.length > 0) {
    await writeFile(join(configDir, ".env"), envLines.join("\n"), "utf8");
  }
  return { env: { VESICLE_PROVIDERS_FILE: configPath } };
}
