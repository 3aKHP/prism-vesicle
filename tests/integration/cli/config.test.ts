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
      expect(result.stdout).toContain("VESICLE_PROVIDER_PROXY=http://<credentials>@proxy.example.com:8080");
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
