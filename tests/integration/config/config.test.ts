import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadConfigForSelection, loadProviderRegistry } from "../../../src/config/providers";
import { userConfigDirectory } from "../../../src/config/paths";
import {
  loadExperimentalQualityProfile,
  loadExperimentalQualitySettings,
  parseExperimentalQualitySettings,
  writeExperimentalQualitySettings,
} from "../../../src/config/quality";

const tempDirs: string[] = [];

afterEach(async () => {
  const dirs = tempDirs.splice(0);
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("config loading", () => {
  test("keeps sibling user configuration beside an explicit providers file", () => {
    expect(userConfigDirectory({
      VESICLE_PROVIDERS_FILE: "/tmp/vesicle-custom/providers.yaml",
      VESICLE_CONFIG_DIR: "/tmp/ignored-default",
    })).toBe("/tmp/vesicle-custom");
  });

  test("defaults experimental Semantic Judge settings to off without reading a provider", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "vesicle-quality-config-"));
    tempDirs.push(rootDir);
    const env = { VESICLE_CONFIG_DIR: join(rootDir, "config") };
    const settings = await loadExperimentalQualitySettings(env);
    expect(settings).toMatchObject({ mode: "off", exists: false });
    await expect(loadExperimentalQualityProfile(undefined, env)).resolves.toBeUndefined();
  });

  test("validates and atomically writes an enabled experimental Judge profile", async () => {
    const { env } = await writeProvidersFile([
      "default:", "  provider: generation", "  model: main", "providers:",
      "  generation:", "    protocol: openai-chat-compatible", "    baseUrl: https://example.test/v1", "    apiKeyEnv: MAIN_KEY", "    models:", "      - main",
      "  judge:", "    protocol: gemini-generate-content", "    baseUrl: https://example.test/v1", "    apiKeyEnv: JUDGE_KEY", "    models:", "      - judge-model", "",
    ], ["MAIN_KEY=main-secret", "JUDGE_KEY=judge-secret"]);
    const written = await writeExperimentalQualitySettings({
      mode: "rewrite", providerAlias: "judge", modelId: "judge-model", judgeTimeoutMs: 30_000,
    }, env);
    expect(written).toMatchObject({ mode: "rewrite", providerAlias: "judge", modelId: "judge-model", judgeTimeoutMs: 30_000, exists: true });
    const profile = await loadExperimentalQualityProfile({ judge: { rubric: "fixture", rules: [] } } as never, env);
    expect(profile).toMatchObject({ mode: "rewrite", providerId: "judge", modelId: "judge-model", protocol: "gemini-generate-content", judgeTimeoutMs: 30_000 });
    expect(profile?.configIdentity).toMatch(/^[a-f0-9]{64}$/);
    await writeFile(env.VESICLE_PROVIDERS_FILE!, [
      "default:", "  provider: generation", "  model: main", "providers:",
      "  generation:", "    protocol: openai-chat-compatible", "    baseUrl: https://example.test/v1", "    apiKeyEnv: MAIN_KEY", "    models:", "      - main",
      "  judge:", "    protocol: gemini-generate-content", "    baseUrl: https://drifted.example.test/v1", "    apiKeyEnv: JUDGE_KEY", "    models:", "      - judge-model", "",
    ].join("\n"));
    const drifted = await loadExperimentalQualityProfile({ judge: { rubric: "fixture", rules: [] } } as never, env);
    expect(drifted?.configIdentity).not.toBe(profile?.configIdentity);
  });

  test("rejects unsafe enabled Judge configuration before provider calls", () => {
    expect(() => parseExperimentalQualitySettings("version: 1\nmode: rewrite\nproviderAlias: judge\nmodelId: m\njudgeTimeoutMs: 999\n"))
      .toThrow("judgeTimeoutMs must be an integer from 1000 to 180000");
    expect(() => parseExperimentalQualitySettings("version: 1\nmode: off\nproviderAlias: judge\n"))
      .toThrow("mode off cannot retain");
    expect(() => parseExperimentalQualitySettings("version: 1\nmode: observe\nproviderAlias: judge\nmodelId: m\njudgeTimeoutMs: 15000\nbaseUrl: https://bad.test\n"))
      .toThrow("Unknown quality.yaml field: baseUrl");
  });

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

  test("loads a provider-level User-Agent override", async () => {
    const { env } = await writeProvidersFile([
      "default:",
      "  provider: custom",
      "  model: test-model",
      "providers:",
      "  custom:",
      "    protocol: openai-chat-compatible",
      "    baseUrl: https://example.test/v1",
      "    apiKeyEnv: CUSTOM_API_KEY",
      "    userAgent: custom-client/2.0 runtime/test",
      "    models:",
      "      - test-model",
      "",
    ], ["CUSTOM_API_KEY=secret"]);

    const registry = await loadProviderRegistry(env);
    const config = await loadConfigForSelection(undefined, env);

    expect(registry.providers[0].userAgent).toBe("custom-client/2.0 runtime/test");
    expect(config.userAgent).toBe("custom-client/2.0 runtime/test");
  });

  test("rejects control characters in a provider User-Agent override", async () => {
    const { env } = await writeProvidersFile([
      "default:",
      "  provider: custom",
      "  model: test-model",
      "providers:",
      "  custom:",
      "    protocol: openai-chat-compatible",
      "    baseUrl: https://example.test/v1",
      "    apiKeyEnv: CUSTOM_API_KEY",
      "    userAgent: custom-client/2.0\u0001bad",
      "    models:",
      "      - test-model",
      "",
    ]);

    await expect(loadProviderRegistry(env)).rejects.toThrow("userAgent contains an invalid control character");
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
      "          vision: true",
      "        limits:",
      "          contextWindow: 1000000",
      "          autoCompact:",
      "            enabled: true",
      "            threshold: 0.85",
      "            reserveOutputTokens: 20000",
      "          maxOutputTokens: 65536",
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
      vision: true,
    });
    expect(config.limits).toEqual({
      contextWindow: 1000000,
      autoCompact: {
        enabled: true,
        threshold: 0.85,
        reserveOutputTokens: 20000,
      },
      maxOutputTokens: 65536,
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

  test("loads Gemini generateContent provider profiles", async () => {
    const { env } = await writeProvidersFile([
      "default:",
      "  provider: google",
      "  model: gemini-test",
      "providers:",
      "  google:",
      "    protocol: gemini-generate-content",
      "    baseUrl: https://generativelanguage.googleapis.com/v1beta",
      "    apiKeyEnv: GEMINI_API_KEY",
      "    authMethod: x-goog-api-key",
      "    models:",
      "      - id: gemini-test",
      "        capabilities:",
      "          streaming: true",
      "          tools: true",
      "          reasoningTier: true",
      "          reasoningContent: true",
      "",
    ], ["GEMINI_API_KEY=secret"]);

    const config = await loadConfigForSelection(undefined, env);

    expect(config).toMatchObject({
      provider: "gemini-generate-content",
      providerId: "google",
      model: "gemini-test",
      authMethod: "x-goog-api-key",
      apiKey: "secret",
      capabilities: {
        streaming: true,
        tools: true,
        reasoningTier: true,
        reasoningContent: true,
      },
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

  test("uses provider defaultModel when switching without an explicit model", async () => {
    const { env } = await writeProvidersFile([
      "default:",
      "  provider: deepseek",
      "  model: deepseek-v4-flash",
      "providers:",
      "  deepseek:",
      "    protocol: openai-chat-compatible",
      "    baseUrl: https://api.deepseek.com/v1",
      "    apiKeyEnv: DEEPSEEK_API_KEY",
      "    defaultModel: deepseek-reasoner",
      "    models:",
      "      - deepseek-v4-flash",
      "      - deepseek-reasoner",
      "",
    ], ["DEEPSEEK_API_KEY=secret"]);

    const registry = await loadProviderRegistry(env);
    expect(registry.providers[0].defaultModel).toBe("deepseek-reasoner");

    // Switching to deepseek with no explicit model picks defaultModel, not models[0].
    const config = await loadConfigForSelection({ provider: "deepseek" }, env);
    expect(config.model).toBe("deepseek-reasoner");
  });

  test("an explicit selection.model wins over provider defaultModel", async () => {
    const { env } = await writeProvidersFile([
      "default:",
      "  provider: deepseek",
      "  model: deepseek-v4-flash",
      "providers:",
      "  deepseek:",
      "    protocol: openai-chat-compatible",
      "    baseUrl: https://api.deepseek.com/v1",
      "    apiKeyEnv: DEEPSEEK_API_KEY",
      "    defaultModel: deepseek-reasoner",
      "    models:",
      "      - deepseek-v4-flash",
      "      - deepseek-reasoner",
      "",
    ], ["DEEPSEEK_API_KEY=secret"]);

    const config = await loadConfigForSelection({ provider: "deepseek", model: "deepseek-v4-flash" }, env);
    expect(config.model).toBe("deepseek-v4-flash");
  });

  test("rejects a provider defaultModel outside its model catalog", async () => {
    const { env } = await writeProvidersFile([
      "default:",
      "  provider: deepseek",
      "  model: deepseek-v4-flash",
      "providers:",
      "  deepseek:",
      "    protocol: openai-chat-compatible",
      "    baseUrl: https://api.deepseek.com/v1",
      "    apiKeyEnv: DEEPSEEK_API_KEY",
      "    defaultModel: missing-model",
      "    models:",
      "      - deepseek-v4-flash",
      "",
    ]);

    await expect(loadProviderRegistry(env)).rejects.toThrow(
      'Provider "deepseek" defaultModel "missing-model" is not declared in models.',
    );
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
