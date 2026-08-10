import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { runCli, seedProvidersConfig, withTempProject } from "./support";

/**
 * vesicle config CLI — integration tests through the real subprocess.
 * The critical security boundary is .env sanitization: secret values must
 * never appear on stdout. Write operations are verified by reading back the
 * resulting config files.
 */
describe("vesicle config CLI", () => {
  test("config path honors VESICLE_HOST_CONFIG_DIR when explicit overrides are absent", async () => {
    await withTempProject("vesicle-config-hostdir-", async (projectDir, configDir) => {
      // No explicit VESICLE_CONFIG_DIR; VESICLE_HOST_CONFIG_DIR must win
      // over any passed-through platform defaults (APPDATA, HOME).
      const result = await runCli(["config", "path"], {
        cwd: projectDir,
        env: { VESICLE_HOST_CONFIG_DIR: configDir },
      });
      expect(result.exitCode).toBe(0);
      expect(result.stdout.trim()).toBe(configDir);
    });
  });

  test("show env masks comment lines containing KEY= patterns", async () => {
    await withTempProject("vesicle-config-comment-", async (projectDir, configDir) => {
      await writeFile(join(configDir, ".env"), [
        "ACTIVE_KEY=value",
        "# OPENAI_API_KEY=sk-commented-out-secret",
        "# This is a plain comment without equals",
        "",
      ].join("\n"), "utf8");
      const result = await runCli(["config", "show", "env"], { cwd: projectDir, configDir });
      expect(result.exitCode).toBe(0);
      expect(result.stdout).not.toContain("sk-commented-out-secret");
      expect(result.stdout).toContain("<comment>");
      expect(result.stdout).toContain("# This is a plain comment without equals");
      expect(result.stdout).toContain("ACTIVE_KEY=<set>");
    });
  });

  test("config path prints the resolved config directory", async () => {
    await withTempProject("vesicle-config-path-", async (projectDir, configDir) => {
      const result = await runCli(["config", "path"], { cwd: projectDir, configDir });
      expect(result.exitCode).toBe(0);
      expect(result.stdout.trim()).toBe(configDir);
    });
  });

  test("show env never leaks secret values; reports <set> and <empty> markers", async () => {
    await withTempProject("vesicle-config-env-", async (projectDir, configDir) => {
      await writeFile(join(configDir, ".env"), [
        "SECRET_API_KEY=sk-abc123def456secret",
        "EMPTY_KEY=",
        'QUOTED_EMPTY=""',
        "VESICLE_PROVIDER_PROXY=http://user:pass@proxy.example.com:8080",
        "",
      ].join("\n"), "utf8");
      const result = await runCli(["config", "show", "env"], { cwd: projectDir, configDir });
      expect(result.exitCode).toBe(0);
      // Security boundary: actual secret values must not appear in output.
      expect(result.stdout).not.toContain("sk-abc123def456secret");
      expect(result.stdout).not.toContain("user:pass");
      // Structural markers must be present.
      expect(result.stdout).toContain("SECRET_API_KEY=<set>");
      expect(result.stdout).toContain("EMPTY_KEY=<empty>");
      // Quoted empty (KEY="") must also be classified as <empty>.
      expect(result.stdout).toContain("QUOTED_EMPTY=<empty>");
      expect(result.stdout).toContain("VESICLE_PROVIDER_PROXY=http://<credentials>@proxy.example.com:8080");
    });
  });

  test("show env masks unparseable lines instead of echoing them", async () => {
    await withTempProject("vesicle-config-unparseable-", async (projectDir, configDir) => {
      await writeFile(join(configDir, ".env"), [
        "VALID_KEY=value",
        "sk-bare-secret-without-key-prefix",
        "",
      ].join("\n"), "utf8");
      const result = await runCli(["config", "show", "env"], { cwd: projectDir, configDir });
      expect(result.exitCode).toBe(0);
      expect(result.stdout).not.toContain("sk-bare-secret-without-key-prefix");
      expect(result.stdout).toContain("<unparseable-line>");
      expect(result.stdout).toContain("VALID_KEY=<set>");
    });
  });

  test("env-set-empty creates an empty variable slot without a value", async () => {
    await withTempProject("vesicle-config-setempty-", async (projectDir, configDir) => {
      await seedProvidersConfig(configDir);
      await writeFile(join(configDir, ".env"), "EXISTING_KEY=existing-value\n", "utf8");
      const result = await runCli(["config", "env-set-empty", "NEW_API_KEY"], { cwd: projectDir, configDir });
      expect(result.exitCode).toBe(0);
      const envContent = await readFile(join(configDir, ".env"), "utf8");
      expect(envContent).toContain("EXISTING_KEY=existing-value");
      expect(envContent).toContain("NEW_API_KEY=");
      // The new key must have an empty value (bare = or quoted "").
      const newKeyLine = envContent.split("\n").find((line) => line.startsWith("NEW_API_KEY="));
      expect(newKeyLine).toBeDefined();
      expect(newKeyLine!.trim()).toMatch(/^NEW_API_KEY=("")?$/);
    });
  });

  test("env-set-empty refuses to overwrite an existing value", async () => {
    await withTempProject("vesicle-config-setempty-refuse-", async (projectDir, configDir) => {
      await seedProvidersConfig(configDir);
      await writeFile(join(configDir, ".env"), "EXISTING_KEY=secret-value\n", "utf8");
      const result = await runCli(["config", "env-set-empty", "EXISTING_KEY"], { cwd: projectDir, configDir });
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("already has a value");
      // Original value must be preserved.
      const envContent = await readFile(join(configDir, ".env"), "utf8");
      expect(envContent).toContain("EXISTING_KEY=secret-value");
    });
  });

  test("env-remove deletes a variable from .env", async () => {
    await withTempProject("vesicle-config-envrm-", async (projectDir, configDir) => {
      await seedProvidersConfig(configDir);
      await writeFile(join(configDir, ".env"), "KEEP_ME=value\nREMOVE_ME=gone\n", "utf8");
      const result = await runCli(["config", "env-remove", "REMOVE_ME"], { cwd: projectDir, configDir });
      expect(result.exitCode).toBe(0);
      const envContent = await readFile(join(configDir, ".env"), "utf8");
      expect(envContent).toContain("KEEP_ME=value");
      expect(envContent).not.toContain("REMOVE_ME");
    });
  });

  test("set permissions shellExec writes the correct value", async () => {
    await withTempProject("vesicle-config-setperm-", async (projectDir, configDir) => {
      await seedProvidersConfig(configDir);
      const result = await runCli(["config", "set", "permissions", "shellExec", "true"], { cwd: projectDir, configDir });
      expect(result.exitCode).toBe(0);
      const parsed = JSON.parse(result.stdout) as { ok: boolean; key: string; value: string };
      expect(parsed.ok).toBe(true);
      expect(parsed.key).toBe("shellExec");
      expect(parsed.value).toBe("true");
      const permsContent = await readFile(join(configDir, "permissions.yaml"), "utf8");
      expect(permsContent).toContain("shellExec: true");
    });
  });

  test("add-provider writes providers.yaml and creates .env empty slot", async () => {
    await withTempProject("vesicle-config-addprov-", async (projectDir, configDir) => {
      await seedProvidersConfig(configDir);
      const entry = JSON.stringify({
        id: "test-provider",
        protocol: "openai-chat-compatible",
        baseUrl: "https://api.test.example.com/v1",
        apiKeyEnv: "TEST_PROVIDER_API_KEY",
        models: [{ id: "test-model-1" }, { id: "test-model-2" }],
        defaultModel: "test-model-1",
      });
      const result = await runCli(["config", "add-provider", "--json", entry], { cwd: projectDir, configDir });
      expect(result.exitCode).toBe(0);
      const parsed = JSON.parse(result.stdout) as { ok: boolean; providerId: string; apiKeyEnv: string };
      expect(parsed.ok).toBe(true);
      expect(parsed.providerId).toBe("test-provider");
      expect(parsed.apiKeyEnv).toBe("TEST_PROVIDER_API_KEY");
      // providers.yaml must contain the new provider.
      const providersContent = await readFile(join(configDir, "providers.yaml"), "utf8");
      expect(providersContent).toContain("test-provider:");
      expect(providersContent).toContain("baseUrl: https://api.test.example.com/v1");
      // .env must have the empty slot (bare = or quoted "").
      const envContent = await readFile(join(configDir, ".env"), "utf8");
      const slotLine = envContent.split("\n").find((line) => line.startsWith("TEST_PROVIDER_API_KEY="));
      expect(slotLine).toBeDefined();
      expect(slotLine!.trim()).toMatch(/^TEST_PROVIDER_API_KEY=("")?$/);
    });
  });

  test("add-provider preserves existing apiKeyEnv value when key is already set", async () => {
    await withTempProject("vesicle-config-preserve-", async (projectDir, configDir) => {
      await seedProvidersConfig(configDir);
      await writeFile(join(configDir, ".env"), "SHARED_API_KEY=sk-existing-secret\n", "utf8");
      const entry = JSON.stringify({
        id: "second-provider",
        protocol: "openai-chat-compatible",
        baseUrl: "https://api.second.example.com/v1",
        apiKeyEnv: "SHARED_API_KEY",
        models: [{ id: "shared-model" }],
      });
      const result = await runCli(["config", "add-provider", "--json", entry], { cwd: projectDir, configDir });
      expect(result.exitCode).toBe(0);
      // The existing secret must NOT be overwritten.
      const envContent = await readFile(join(configDir, ".env"), "utf8");
      expect(envContent).toContain("SHARED_API_KEY=sk-existing-secret");
      expect(envContent).not.toContain('SHARED_API_KEY=""');
      // Provider should still be added to providers.yaml.
      const providersContent = await readFile(join(configDir, "providers.yaml"), "utf8");
      expect(providersContent).toContain("second-provider:");
    });
  });

  test("add-provider rejects duplicate provider id", async () => {
    await withTempProject("vesicle-config-dup-", async (projectDir, configDir) => {
      await seedProvidersConfig(configDir);
      const entry = JSON.stringify({
        id: "deepseek",
        protocol: "openai-chat-compatible",
        baseUrl: "https://api.deepseek.com/v1",
        apiKeyEnv: "DEEPSEEK_API_KEY",
        models: [{ id: "deepseek-v4-flash" }],
      });
      const result = await runCli(["config", "add-provider", "--json", entry], { cwd: projectDir, configDir });
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("already exists");
    });
  });

  test("env-set-proxy rejects URLs with credentials", async () => {
    await withTempProject("vesicle-config-proxy-creds-", async (projectDir, configDir) => {
      await seedProvidersConfig(configDir);
      const result = await runCli(["config", "env-set-proxy", "http://user:pass@proxy.example.com:8080"], { cwd: projectDir, configDir });
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("must not be passed as arguments");
    });
  });

  test("env-set-proxy accepts URLs without credentials", async () => {
    await withTempProject("vesicle-config-proxy-ok-", async (projectDir, configDir) => {
      await seedProvidersConfig(configDir);
      const result = await runCli(["config", "env-set-proxy", "http://proxy.example.com:8080"], { cwd: projectDir, configDir });
      expect(result.exitCode).toBe(0);
      const envContent = await readFile(join(configDir, ".env"), "utf8");
      expect(envContent).toContain("VESICLE_PROVIDER_PROXY=http://proxy.example.com:8080");
    });
  });

  test("set providers <id>.userAgent updates the provider userAgent", async () => {
    await withTempProject("vesicle-config-set-ua-", async (projectDir, configDir) => {
      await seedProvidersConfig(configDir);
      const result = await runCli(["config", "set", "providers", "providers.local.userAgent", "Prism-Vesicle-host-dev"], { cwd: projectDir, configDir });
      expect(result.exitCode).toBe(0);
      const parsed = JSON.parse(result.stdout) as { ok: boolean; key: string; value: string };
      expect(parsed.ok).toBe(true);
      expect(parsed.key).toBe("providers.local.userAgent");
      expect(parsed.value).toBe("Prism-Vesicle-host-dev");
      const providersContent = await readFile(join(configDir, "providers.yaml"), "utf8");
      expect(providersContent).toContain("userAgent: Prism-Vesicle-host-dev");
    });
  });

  test("set providers <id>.defaultModel switches to an existing model", async () => {
    await withTempProject("vesicle-config-set-defaultmodel-", async (projectDir, configDir) => {
      await seedProvidersConfig(configDir);
      const result = await runCli(["config", "set", "providers", "providers.deepseek.defaultModel", "deepseek-reasoner"], { cwd: projectDir, configDir });
      expect(result.exitCode).toBe(0);
      const parsed = JSON.parse(result.stdout) as { ok: boolean; key: string; value: string };
      expect(parsed.ok).toBe(true);
      expect(parsed.key).toBe("providers.deepseek.defaultModel");
      expect(parsed.value).toBe("deepseek-reasoner");
      const providersContent = await readFile(join(configDir, "providers.yaml"), "utf8");
      expect(providersContent).toContain("defaultModel: deepseek-reasoner");
    });
  });

  test("set providers <id>.defaultModel rejects unknown model", async () => {
    await withTempProject("vesicle-config-set-badmodel-", async (projectDir, configDir) => {
      await seedProvidersConfig(configDir);
      const result = await runCli(["config", "set", "providers", "providers.deepseek.defaultModel", "no-such-model"], { cwd: projectDir, configDir });
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("does not declare model \"no-such-model\"");
      const providersContent = await readFile(join(configDir, "providers.yaml"), "utf8");
      expect(providersContent).toContain("defaultModel: deepseek-v4-flash");
    });
  });

  test("add-model appends a model to an existing provider", async () => {
    await withTempProject("vesicle-config-addmodel-", async (projectDir, configDir) => {
      await seedProvidersConfig(configDir);
      const entry = JSON.stringify({
        id: "local-extra",
        capabilities: { streaming: true, tools: true },
        limits: { contextWindow: 4096 },
      });
      const result = await runCli(["config", "add-model", "local", "--json", entry], { cwd: projectDir, configDir });
      expect(result.exitCode).toBe(0);
      const parsed = JSON.parse(result.stdout) as { ok: boolean; providerId: string; modelId: string };
      expect(parsed.ok).toBe(true);
      expect(parsed.providerId).toBe("local");
      expect(parsed.modelId).toBe("local-extra");
      const providersContent = await readFile(join(configDir, "providers.yaml"), "utf8");
      expect(providersContent).toContain("local-extra");
    });
  });

  test("add-model rejects duplicate model id", async () => {
    await withTempProject("vesicle-config-addmodel-dup-", async (projectDir, configDir) => {
      await seedProvidersConfig(configDir);
      const entry = JSON.stringify({ id: "qwen3" });
      const result = await runCli(["config", "add-model", "local", "--json", entry], { cwd: projectDir, configDir });
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("already declares model \"qwen3\"");
    });
  });

  test("add-model rejects invalid capability value", async () => {
    await withTempProject("vesicle-config-addmodel-badcap-", async (projectDir, configDir) => {
      await seedProvidersConfig(configDir);
      const entry = JSON.stringify({ id: "local-extra", capabilities: { streaming: "yes" } });
      const result = await runCli(["config", "add-model", "local", "--json", entry], { cwd: projectDir, configDir });
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("must be true or false");
    });
  });

  test("remove-model deletes a model from a provider", async () => {
    await withTempProject("vesicle-config-rmmodel-", async (projectDir, configDir) => {
      await seedProvidersConfig(configDir);
      const result = await runCli(["config", "remove-model", "deepseek", "deepseek-reasoner"], { cwd: projectDir, configDir });
      expect(result.exitCode).toBe(0);
      const parsed = JSON.parse(result.stdout) as { ok: boolean; providerId: string; modelId: string };
      expect(parsed.ok).toBe(true);
      expect(parsed.providerId).toBe("deepseek");
      expect(parsed.modelId).toBe("deepseek-reasoner");
      const providersContent = await readFile(join(configDir, "providers.yaml"), "utf8");
      expect(providersContent).not.toContain("deepseek-reasoner");
    });
  });

  test("remove-model refuses to delete the provider defaultModel", async () => {
    await withTempProject("vesicle-config-rmmodel-default-", async (projectDir, configDir) => {
      await seedProvidersConfig(configDir);
      const result = await runCli(["config", "remove-model", "deepseek", "deepseek-v4-flash"], { cwd: projectDir, configDir });
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("is the default model");
      const providersContent = await readFile(join(configDir, "providers.yaml"), "utf8");
      expect(providersContent).toContain("deepseek-v4-flash");
    });
  });

  test("remove-provider deletes a non-default provider", async () => {
    await withTempProject("vesicle-config-rmprovider-", async (projectDir, configDir) => {
      await seedProvidersConfig(configDir);
      const result = await runCli(["config", "remove-provider", "local"], { cwd: projectDir, configDir });
      expect(result.exitCode).toBe(0);
      const parsed = JSON.parse(result.stdout) as { ok: boolean; providerId: string };
      expect(parsed.ok).toBe(true);
      expect(parsed.providerId).toBe("local");
      const providersContent = await readFile(join(configDir, "providers.yaml"), "utf8");
      expect(providersContent).not.toContain("local:");
    });
  });

  test("remove-provider refuses to delete the default provider", async () => {
    await withTempProject("vesicle-config-rmprovider-default-", async (projectDir, configDir) => {
      await seedProvidersConfig(configDir);
      const result = await runCli(["config", "remove-provider", "deepseek"], { cwd: projectDir, configDir });
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("is the current default provider");
      const providersContent = await readFile(join(configDir, "providers.yaml"), "utf8");
      expect(providersContent).toContain("deepseek:");
    });
  });

  test("unset preferences theme removes the project theme", async () => {
    await withTempProject("vesicle-config-unset-theme-", async (projectDir, configDir) => {
      await seedProvidersConfig(configDir);
      await runCli(["config", "set", "preferences", "theme", "dark"], { cwd: projectDir, configDir });
      const result = await runCli(["config", "unset", "preferences", "theme"], { cwd: projectDir, configDir });
      expect(result.exitCode).toBe(0);
      const parsed = JSON.parse(result.stdout) as { ok: boolean; removed: boolean };
      expect(parsed.ok).toBe(true);
      expect(parsed.removed).toBe(true);
      const prefsPath = join(projectDir, ".vesicle", "preferences.yaml");
      await expect(readFile(prefsPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    });
  });

  test("env-remove warns but exits 0 when key does not exist", async () => {
    await withTempProject("vesicle-config-envrm-missing-", async (projectDir, configDir) => {
      await seedProvidersConfig(configDir);
      await writeFile(join(configDir, ".env"), "KEEP_ME=value\n", "utf8");
      const result = await runCli(["config", "env-remove", "MISSING_KEY"], { cwd: projectDir, configDir });
      expect(result.exitCode).toBe(0);
      expect(result.stderr).toContain("was not set");
      const envContent = await readFile(join(configDir, ".env"), "utf8");
      expect(envContent).toContain("KEEP_ME=value");
    });
  });

  test("set providers <id>.<field> rejects unknown and protected fields", async () => {
    await withTempProject("vesicle-config-set-badfield-", async (projectDir, configDir) => {
      await seedProvidersConfig(configDir);
      const unknown = await runCli(["config", "set", "providers", "providers.local.unknownField", "x"], { cwd: projectDir, configDir });
      expect(unknown.exitCode).toBe(1);
      expect(unknown.stderr).toContain("Unknown provider field");
      const protectedField = await runCli(["config", "set", "providers", "providers.local.id", "newid"], { cwd: projectDir, configDir });
      expect(protectedField.exitCode).toBe(1);
      expect(protectedField.stderr).toContain("cannot be modified directly");
    });
  });

  test("set providers <id>.<field> does not corrupt file on cross-field constraint failure", async () => {
    await withTempProject("vesicle-config-set-nocorrupt-", async (projectDir, configDir) => {
      await seedProvidersConfig(configDir);
      const before = await readFile(join(configDir, "providers.yaml"), "utf8");
      const result = await runCli(["config", "set", "providers", "providers.local.protocol", "openai-responses"], { cwd: projectDir, configDir });
      expect(result.exitCode).toBe(1);
      const after = await readFile(join(configDir, "providers.yaml"), "utf8");
      expect(after).toBe(before);
    });
  });

  test("add-model rejects unknown JSON keys", async () => {
    await withTempProject("vesicle-config-addmodel-unknownkey-", async (projectDir, configDir) => {
      await seedProvidersConfig(configDir);
      const entry = JSON.stringify({ id: "local-extra", unknownKey: "value" });
      const result = await runCli(["config", "add-model", "local", "--json", entry], { cwd: projectDir, configDir });
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("Unknown model entry field");
    });
  });

  test("remove-provider rejects provider referenced by quality judge", async () => {
    await withTempProject("vesicle-config-rmprovider-quality-", async (projectDir, configDir) => {
      await seedProvidersConfig(configDir);
      await writeFile(join(configDir, "quality.yaml"), [
        "version: 1",
        "mode: observe",
        "providerAlias: local",
        "modelId: qwen3",
        "judgeTimeoutMs: 15000",
        "",
      ].join("\n"), "utf8");
      const result = await runCli(["config", "remove-provider", "local"], { cwd: projectDir, configDir });
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("configured as the Semantic Judge");
      const providersContent = await readFile(join(configDir, "providers.yaml"), "utf8");
      expect(providersContent).toContain("local:");
    });
  });

  test("unset settings editor preserves other fields", async () => {
    await withTempProject("vesicle-config-unset-settings-", async (projectDir, configDir) => {
      await seedProvidersConfig(configDir);
      await writeFile(join(configDir, "settings.yaml"), [
        "version: 1",
        "editor: code --wait",
        "futureField: kept",
        "",
      ].join("\n"), "utf8");
      const result = await runCli(["config", "unset", "settings", "editor"], { cwd: projectDir, configDir });
      expect(result.exitCode).toBe(0);
      const settingsContent = await readFile(join(configDir, "settings.yaml"), "utf8");
      expect(settingsContent).not.toContain("editor:");
      expect(settingsContent).toContain("futureField: kept");
    });
  });

  test("unset settings refuses an unsupported-version settings.yaml", async () => {
    await withTempProject("vesicle-config-unset-settings-v2-", async (projectDir, configDir) => {
      await seedProvidersConfig(configDir);
      const original = ["version: 2", "editor: nano", ""].join("\n");
      await writeFile(join(configDir, "settings.yaml"), original, "utf8");
      const result = await runCli(["config", "unset", "settings", "editor"], { cwd: projectDir, configDir });
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("unsupported version");
      const after = await readFile(join(configDir, "settings.yaml"), "utf8");
      expect(after).toBe(original);
    });
  });

  test("env-remove still removes a key when .env contains unparseable lines", async () => {
    await withTempProject("vesicle-config-envrm-unparseable-", async (projectDir, configDir) => {
      await seedProvidersConfig(configDir);
      await writeFile(join(configDir, ".env"), [
        "REMOVE_ME=gone",
        "bare-token-line-without-equals",
        "KEEP_ME=value",
        "",
      ].join("\n"), "utf8");
      const result = await runCli(["config", "env-remove", "REMOVE_ME"], { cwd: projectDir, configDir });
      expect(result.exitCode).toBe(0);
      const envContent = await readFile(join(configDir, ".env"), "utf8");
      expect(envContent).not.toContain("REMOVE_ME");
      expect(envContent).toContain("KEEP_ME=value");
      expect(envContent).toContain("bare-token-line-without-equals");
    });
  });

  test("remove-model refuses to delete the global default model", async () => {
    await withTempProject("vesicle-config-rmmodel-global-", async (projectDir, configDir) => {
      await seedProvidersConfig(configDir);
      // Diverge: global default.model != provider defaultModel.
      await runCli(["config", "set", "providers", "default.model", "deepseek-reasoner"], { cwd: projectDir, configDir });
      const result = await runCli(["config", "remove-model", "deepseek", "deepseek-reasoner"], { cwd: projectDir, configDir });
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("current default model");
      const providersContent = await readFile(join(configDir, "providers.yaml"), "utf8");
      expect(providersContent).toContain("deepseek-reasoner");
    });
  });

  test("set providers <id>.defaultModel syncs the global default model", async () => {
    await withTempProject("vesicle-config-set-sync-", async (projectDir, configDir) => {
      await seedProvidersConfig(configDir);
      const result = await runCli(["config", "set", "providers", "providers.deepseek.defaultModel", "deepseek-reasoner"], { cwd: projectDir, configDir });
      expect(result.exitCode).toBe(0);
      const providersContent = await readFile(join(configDir, "providers.yaml"), "utf8");
      expect(providersContent).toContain("  model: deepseek-reasoner");
    });
  });

  test("add-model rejects non-numeric JSON values for numeric fields", async () => {
    await withTempProject("vesicle-config-addmodel-nonnum-", async (projectDir, configDir) => {
      await seedProvidersConfig(configDir);
      const entry = JSON.stringify({ id: "local-extra", limits: { contextWindow: true } });
      const result = await runCli(["config", "add-model", "local", "--json", entry], { cwd: projectDir, configDir });
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("must be a positive integer");
    });
  });

  test("validate reports ok for a well-formed config", async () => {
    await withTempProject("vesicle-config-validate-", async (projectDir, configDir) => {
      await seedProvidersConfig(configDir);
      const result = await runCli(["config", "validate"], { cwd: projectDir, configDir });
      expect(result.exitCode).toBe(0);
      const parsed = JSON.parse(result.stdout) as { ok: boolean; results: Array<{ file: string; ok: boolean }> };
      expect(parsed.ok).toBe(true);
      expect(parsed.results.every((entry) => entry.ok)).toBe(true);
    });
  });
});
