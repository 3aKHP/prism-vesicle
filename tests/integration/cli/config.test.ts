import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
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

  test("add-mcp writes mcp.yaml and creates a token env slot without accepting a secret", async () => {
    await withTempProject("vesicle-config-addmcp-fresh-", async (projectDir, configDir) => {
      await seedProvidersConfig(configDir);
      const entry = JSON.stringify({
        name: "Research Cluster",
        url: "https://mcp.example.com/mcp",
        auth: "bearer",
        enabledEngines: ["etl", "evaluate"],
      });
      const result = await runCli(["config", "add-mcp", "--json", entry], { cwd: projectDir, configDir });
      expect(result.exitCode).toBe(0);
      const parsed = JSON.parse(result.stdout) as { ok: boolean; serverId: string; createdEnvKeys: string[] };
      expect(parsed.ok).toBe(true);
      expect(parsed.serverId).toBe("research-cluster");
      expect(parsed.createdEnvKeys).toEqual(["MCP_RESEARCH_CLUSTER_TOKEN"]);

      const mcpContent = await readFile(join(configDir, "mcp.yaml"), "utf8");
      expect(mcpContent).toContain("research-cluster:");
      expect(mcpContent).toContain("url: https://mcp.example.com/mcp");
      expect(mcpContent).toContain('Authorization: "Bearer ${MCP_RESEARCH_CLUSTER_TOKEN}"');
      expect(mcpContent).not.toContain("secret");

      const envContent = await readFile(join(configDir, ".env"), "utf8");
      const slotLine = envContent.split("\n").find((line) => line.startsWith("MCP_RESEARCH_CLUSTER_TOKEN="));
      expect(slotLine).toBeDefined();
      expect(slotLine!.trim()).toMatch(/^MCP_RESEARCH_CLUSTER_TOKEN=("")?$/);
    });
  });

  test("add-mcp writes the token slot beside providers.yaml when VESICLE_MCP_FILE points elsewhere", async () => {
    await withTempProject("vesicle-config-addmcp-altfile-", async (projectDir, configDir) => {
      await seedProvidersConfig(configDir);
      const altMcpPath = join(configDir, "alternate", "mcp.yaml");
      const entry = JSON.stringify({
        name: "Alt Server",
        url: "https://alt.example/mcp",
        auth: "bearer",
      });
      const result = await runCli(["config", "add-mcp", "--json", entry], {
        cwd: projectDir,
        configDir,
        env: { VESICLE_MCP_FILE: altMcpPath },
      });
      expect(result.exitCode).toBe(0);
      expect(await readFile(altMcpPath, "utf8")).toContain("alt-server:");
      const envContent = await readFile(join(configDir, ".env"), "utf8");
      expect(envContent).toContain("MCP_ALT_SERVER_TOKEN=");
      await expect(readFile(join(dirname(altMcpPath), ".env"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    });
  });

  test("add-mcp preserves existing comments, header references, and flips a disabled registry on", async () => {
    await withTempProject("vesicle-config-addmcp-existing-", async (projectDir, configDir) => {
      await seedProvidersConfig(configDir);
      await writeFile(join(configDir, "mcp.yaml"), [
        "# keep me",
        "enabled: false # intentionally disabled",
        "",
        "servers:",
        "  # existing server comment",
        "  old-srv:",
        "    enabled: true",
        "    transport: streamable-http",
        "    url: https://old.example/mcp",
        "    negotiation: legacy",
        "    headers:",
        '      Authorization: "Bearer ${EXISTING_TOKEN}"',
        "",
      ].join("\n"), "utf8");
      await writeFile(join(configDir, ".env"), "EXISTING_TOKEN=existing-secret\n", "utf8");

      const entry = JSON.stringify({ name: "New Server", url: "https://new.example/mcp", auth: "none" });
      const result = await runCli(["config", "add-mcp", "--json", entry], { cwd: projectDir, configDir });
      expect(result.exitCode).toBe(0);

      const mcpContent = await readFile(join(configDir, "mcp.yaml"), "utf8");
      expect(mcpContent).toContain("# keep me");
      expect(mcpContent).toContain("# existing server comment");
      expect(mcpContent).toContain("old-srv:");
      expect(mcpContent).toContain('Authorization: "Bearer ${EXISTING_TOKEN}"');
      expect(mcpContent).toContain("new-server:");
      expect(mcpContent).toContain("enabled: true");

      const envContent = await readFile(join(configDir, ".env"), "utf8");
      expect(envContent).toContain("EXISTING_TOKEN=existing-secret");
    });
  });

  test("add-mcp accepts full fields and creates slots for explicit header references", async () => {
    await withTempProject("vesicle-config-addmcp-full-", async (projectDir, configDir) => {
      await seedProvidersConfig(configDir);
      const entry = JSON.stringify({
        id: "full-srv",
        url: "https://mcp.example.com/full",
        timeoutSeconds: 45,
        protocolVersion: "2025-03-26",
        toolPrefix: "fsrv",
        negotiation: "auto",
        supportedProtocolVersions: ["2026-07-28"],
        includeTools: ["search", "fetch"],
        excludeTools: ["danger"],
        enabledEngines: ["etl"],
        headers: { "X-API-Key": "${FULL_SRV_TOKEN}" },
      });
      const result = await runCli(["config", "add-mcp", "--json", entry], { cwd: projectDir, configDir });
      expect(result.exitCode).toBe(0);
      const parsed = JSON.parse(result.stdout) as { ok: boolean; serverId: string; createdEnvKeys: string[] };
      expect(parsed.ok).toBe(true);
      expect(parsed.serverId).toBe("full-srv");
      expect(parsed.createdEnvKeys).toEqual(["FULL_SRV_TOKEN"]);

      const mcpContent = await readFile(join(configDir, "mcp.yaml"), "utf8");
      expect(mcpContent).toContain("timeoutSeconds: 45");
      expect(mcpContent).toContain("toolPrefix: fsrv");
      expect(mcpContent).toContain("X-API-Key: ${FULL_SRV_TOKEN}");
      expect(mcpContent).toContain("includeTools:");
      expect(mcpContent).toContain("excludeTools:");
      expect(mcpContent).toContain("enabledEngines:");

      const envContent = await readFile(join(configDir, ".env"), "utf8");
      expect(envContent).toContain("FULL_SRV_TOKEN=");

      const validate = await runCli(["config", "validate"], { cwd: projectDir, configDir });
      expect(validate.exitCode).toBe(0);
    });
  });

  test("add-mcp rejects secret and unknown entry fields without touching mcp.yaml", async () => {
    await withTempProject("vesicle-config-addmcp-secret-", async (projectDir, configDir) => {
      await seedProvidersConfig(configDir);
      const secretEntry = JSON.stringify({
        name: "Bad Server",
        url: "https://bad.example/mcp",
        auth: "bearer",
        secret: "sk-do-not-accept",
      });
      const secretResult = await runCli(["config", "add-mcp", "--json", secretEntry], { cwd: projectDir, configDir });
      expect(secretResult.exitCode).toBe(1);
      expect(secretResult.stderr).toContain('"secret" is not accepted');
      await expect(readFile(join(configDir, "mcp.yaml"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
      await expect(readFile(join(configDir, ".env"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });

      const unknownEntry = JSON.stringify({
        name: "Bad Server",
        url: "https://bad.example/mcp",
        unknownField: "value",
      });
      const unknownResult = await runCli(["config", "add-mcp", "--json", unknownEntry], { cwd: projectDir, configDir });
      expect(unknownResult.exitCode).toBe(1);
      expect(unknownResult.stderr).toContain("Unknown MCP server entry field");

      const fallbackEntry = JSON.stringify({
        name: "Fallback Server",
        url: "https://fallback.example/mcp",
        headers: { Authorization: "Bearer ${REAL}${FAKE:-sk-do-not-accept}" },
      });
      const fallbackResult = await runCli(["config", "add-mcp", "--json", fallbackEntry], { cwd: projectDir, configDir });
      expect(fallbackResult.exitCode).toBe(1);
      expect(fallbackResult.stderr).toContain("only exact \"${NAME}\" syntax");

      const badHeaderName = JSON.stringify({
        name: "Bad Header",
        url: "https://header.example/mcp",
        headers: { "X-Token": "Bearer ${OK_TOKEN}" },
        headerName: "Bad Header Name",
      });
      const badHeaderResult = await runCli(["config", "add-mcp", "--json", badHeaderName], { cwd: projectDir, configDir });
      expect(badHeaderResult.exitCode).toBe(1);
      expect(badHeaderResult.stderr).toContain("not a valid HTTP header token");
    });
  });

  test("add-mcp rejects duplicate explicit ids and suffixes derived names", async () => {
    await withTempProject("vesicle-config-addmcp-ids-", async (projectDir, configDir) => {
      await seedProvidersConfig(configDir);
      await writeFile(join(configDir, "mcp.yaml"), [
        "enabled: true",
        "servers:",
        "  fixed:",
        "    transport: streamable-http",
        "    url: https://fixed.example/mcp",
        "  research-cluster:",
        "    transport: streamable-http",
        "    url: https://research.example/mcp",
        "",
      ].join("\n"), "utf8");

      const duplicate = await runCli(["config", "add-mcp", "--json", JSON.stringify({
        id: "fixed",
        url: "https://fixed.example/mcp",
      })], { cwd: projectDir, configDir });
      expect(duplicate.exitCode).toBe(1);
      expect(duplicate.stderr).toContain('MCP server "fixed" already exists');

      const derived = await runCli(["config", "add-mcp", "--json", JSON.stringify({
        name: "Research Cluster",
        url: "https://research.example/mcp",
      })], { cwd: projectDir, configDir });
      expect(derived.exitCode).toBe(0);
      const parsed = JSON.parse(derived.stdout) as { serverId: string };
      expect(parsed.serverId).toBe("research-cluster-2");
    });
  });

  test("add-mcp refuses to mutate a config with a missing env reference and rejects unsafe URLs/engines", async () => {
    await withTempProject("vesicle-config-addmcp-invalid-", async (projectDir, configDir) => {
      await seedProvidersConfig(configDir);
      const original = [
        "enabled: true",
        "servers:",
        "  old-srv:",
        "    transport: streamable-http",
        "    url: https://old.example/mcp",
        "    headers:",
        '      Authorization: "Bearer ${MISSING_TOKEN}"',
        "",
      ].join("\n");
      await writeFile(join(configDir, "mcp.yaml"), original, "utf8");

      const missingEnv = await runCli(["config", "add-mcp", "--json", JSON.stringify({
        name: "New Server",
        url: "https://new.example/mcp",
      })], { cwd: projectDir, configDir });
      expect(missingEnv.exitCode).toBe(1);
      expect(missingEnv.stderr).toContain("environment variable MISSING_TOKEN is not set");
      expect(await readFile(join(configDir, "mcp.yaml"), "utf8")).toBe(original);

      const credentialUrl = await runCli(["config", "add-mcp", "--json", JSON.stringify({
        name: "Bad URL",
        url: "https://user:pass@mcp.example.com/mcp",
      })], { cwd: projectDir, configDir });
      expect(credentialUrl.exitCode).toBe(1);
      expect(credentialUrl.stderr).toContain("must not contain credentials");

      const unknownEngine = await runCli(["config", "add-mcp", "--json", JSON.stringify({
        name: "Bad Engine",
        url: "https://mcp.example.com/mcp",
        enabledEngines: ["etl", "unknown-engine"],
      })], { cwd: projectDir, configDir });
      expect(unknownEngine.exitCode).toBe(1);
      expect(unknownEngine.stderr).toContain('unknown engine "unknown-engine"');
    });
  });


  test("remove-mcp deletes a non-last server and preserves surrounding comments and header references", async () => {
    await withTempProject("vesicle-config-removemcp-", async (projectDir, configDir) => {
      await seedProvidersConfig(configDir);
      await writeFile(join(configDir, "mcp.yaml"), [
        "enabled: true",
        "servers:",
        "  # keep-a docs",
        "  keep-a:",
        "    transport: streamable-http",
        "    url: https://keep.example/mcp",
        "    headers:",
        '      Authorization: "Bearer ${KEEP_TOKEN}"',
        "  # remove-me docs",
        "  remove-me:",
        "    transport: streamable-http",
        "    url: https://remove.example/mcp",
        "    # inside-remove docs",
        "    negotiation: auto",
        "",
      ].join("\n"), "utf8");
      await writeFile(join(configDir, ".env"), "KEEP_TOKEN=keep-secret\n", "utf8");

      const result = await runCli(["config", "remove-mcp", "remove-me"], { cwd: projectDir, configDir });
      expect(result.exitCode).toBe(0);
      const parsed = JSON.parse(result.stdout) as { ok: boolean; serverId: string; removedFile: boolean };
      expect(parsed.ok).toBe(true);
      expect(parsed.serverId).toBe("remove-me");
      expect(parsed.removedFile).toBe(false);

      const mcpContent = await readFile(join(configDir, "mcp.yaml"), "utf8");
      expect(mcpContent).toContain("keep-a:");
      expect(mcpContent).toContain("# keep-a docs");
      expect(mcpContent).toContain("# remove-me docs");
      expect(mcpContent).toContain('Authorization: "Bearer ${KEEP_TOKEN}"');
      expect(mcpContent).not.toContain("remove-me:");
      expect(mcpContent).not.toContain("inside-remove docs");

      const envContent = await readFile(join(configDir, ".env"), "utf8");
      expect(envContent).toContain("KEEP_TOKEN=keep-secret");
    });
  });

  test("remove-mcp deletes mcp.yaml when the target is the last server and leaves env slots", async () => {
    await withTempProject("vesicle-config-removemcp-last-", async (projectDir, configDir) => {
      await seedProvidersConfig(configDir);
      await writeFile(join(configDir, "mcp.yaml"), [
        "enabled: true",
        "servers:",
        "  only-srv:",
        "    transport: streamable-http",
        "    url: https://only.example/mcp",
        "    headers:",
        '      Authorization: "Bearer ${ONLY_TOKEN}"',
        "",
      ].join("\n"), "utf8");
      await writeFile(join(configDir, ".env"), "ONLY_TOKEN=existing-secret\n", "utf8");

      const result = await runCli(["config", "remove-mcp", "only-srv"], { cwd: projectDir, configDir });
      expect(result.exitCode).toBe(0);
      const parsed = JSON.parse(result.stdout) as { ok: boolean; removedFile: boolean };
      expect(parsed.ok).toBe(true);
      expect(parsed.removedFile).toBe(true);
      await expect(readFile(join(configDir, "mcp.yaml"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
      const envContent = await readFile(join(configDir, ".env"), "utf8");
      expect(envContent).toContain("ONLY_TOKEN=existing-secret");
    });
  });

  test("remove-mcp refuses an unknown id without touching mcp.yaml", async () => {
    await withTempProject("vesicle-config-removemcp-unknown-", async (projectDir, configDir) => {
      await seedProvidersConfig(configDir);
      const original = [
        "enabled: true",
        "servers:",
        "  keep-a:",
        "    transport: streamable-http",
        "    url: https://keep.example/mcp",
        "",
      ].join("\n");
      await writeFile(join(configDir, "mcp.yaml"), original, "utf8");

      const result = await runCli(["config", "remove-mcp", "missing"], { cwd: projectDir, configDir });
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('Unknown MCP server "missing"');
      expect(await readFile(join(configDir, "mcp.yaml"), "utf8")).toBe(original);
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

  test("add-model rejects unknown nested keys in limits", async () => {
    await withTempProject("vesicle-config-addmodel-nestedkey-", async (projectDir, configDir) => {
      await seedProvidersConfig(configDir);
      const entry = JSON.stringify({ id: "local-extra", limits: { contextWindow: 4096, contextWidnow: 1 } });
      const result = await runCli(["config", "add-model", "local", "--json", entry], { cwd: projectDir, configDir });
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("Unknown limits field");
      const providersContent = await readFile(join(configDir, "providers.yaml"), "utf8");
      expect(providersContent).not.toContain("local-extra");
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
