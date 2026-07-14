import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadPermissionSettings } from "../src/config/permissions";
import { loadProviderRegistry, loadUserConfigEnvironment } from "../src/config/providers";
import { loadMcpConfig } from "../src/mcp/config";
import { providerIdFromBaseUrl, readSetupState, setEnvValues, writeSetupConfiguration } from "../src/setup/config-writer";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("guided Setup configuration writer", () => {
  test("derives friendly stable provider ids and preserves dotenv neighbors", () => {
    expect(providerIdFromBaseUrl("https://api.deepseek.com/v1")).toBe("deepseek");
    expect(providerIdFromBaseUrl("https://us.doro.lol/v1")).toBe("us-doro");
    expect(setEnvValues("KEEP=one\nTOKEN=old\n", { TOKEN: "new#secret", ADDED: "two" }))
      .toBe('KEEP=one\nTOKEN="new#secret"\nADDED=two\n');
  });

  test("writes a complete fresh provider, optional Tavily/MCP, permissions, and project", async () => {
    const root = await tempRoot();
    const configDir = join(root, "config");
    const projectDirectory = join(root, "Documents", "Prism Vesicle Projects", "My First Project");
    const env = { VESICLE_CONFIG_DIR: configDir };
    const result = await writeSetupConfiguration({
      baseUrl: "https://api.example.com/v1",
      apiKey: "provider#secret",
      modelIds: ["model-a", "model-b"],
      defaultModel: "model-b",
      tavilyApiKey: "tvly-secret",
      mcpServers: [{
        name: "Research Cluster",
        url: "https://mcp.example.com/mcp",
        auth: "bearer",
        secret: "mcp-secret",
        enabledEngines: ["etl", "evaluate"],
      }],
      permissionMode: "MOMENTUM",
      projectDirectory,
    }, env);

    const registry = await loadProviderRegistry(env);
    expect(registry.default).toEqual({ provider: "example", model: "model-b" });
    expect(registry.providers[0].models.map((model) => model.id)).toEqual(["model-a", "model-b"]);
    const loadedEnv = await loadUserConfigEnvironment(env);
    expect(loadedEnv.effectiveEnv.EXAMPLE_API_KEY).toBe("provider#secret");
    expect(loadedEnv.effectiveEnv.TAVILY_API_KEY).toBe("tvly-secret");
    expect(loadedEnv.effectiveEnv.MCP_RESEARCH_CLUSTER_TOKEN).toBe("mcp-secret");
    const mcp = await loadMcpConfig(env);
    expect(mcp.configured).toBe(true);
    if (mcp.configured) {
      expect(mcp.config.servers[0]).toMatchObject({
        id: "research-cluster",
        headers: { Authorization: "Bearer mcp-secret" },
        enabledEngines: ["etl", "evaluate"],
      });
    }
    expect(await loadPermissionSettings(env)).toMatchObject({ defaultMode: "MOMENTUM", shellExec: false });
    expect(await readSetupState(env)).toEqual({ version: 1, projectDirectory });
    expect((await stat(projectDirectory)).isDirectory()).toBe(true);
    expect(result.backups).toEqual([]);
  });

  test("merges with existing providers and creates backups without losing unrelated secrets", async () => {
    const root = await tempRoot();
    const configDir = join(root, "config");
    await Bun.write(join(configDir, "providers.yaml"), [
      "default:",
      "  provider: old",
      "  model: old-model",
      "",
      "providers:",
      "  old:",
      "    protocol: openai-chat-compatible",
      "    baseUrl: https://old.example/v1",
      "    apiKeyEnv: OLD_API_KEY",
      "    models:",
      "      - old-model",
      "",
    ].join("\n"));
    await writeFile(join(configDir, ".env"), "OLD_API_KEY=old-secret\nKEEP_ME=yes\n", "utf8");
    const env = { VESICLE_CONFIG_DIR: configDir };

    const result = await writeSetupConfiguration({
      baseUrl: "https://new.example/v1",
      apiKey: "new-secret",
      modelIds: ["new-model"],
      defaultModel: "new-model",
      permissionMode: "INERTIA",
      projectDirectory: join(root, "project"),
    }, env);

    const registry = await loadProviderRegistry(env);
    expect(registry.providers.map((provider) => provider.id)).toEqual(["old", "new"]);
    expect(registry.default).toEqual({ provider: "new", model: "new-model" });
    const source = await readFile(join(configDir, ".env"), "utf8");
    expect(source).toContain("KEEP_ME=yes");
    expect(source).toContain("NEW_API_KEY=new-secret");
    expect(result.backups.some((path) => path.includes("providers.yaml.backup-"))).toBe(true);
    expect(result.backups.some((path) => path.includes(".env.backup-"))).toBe(true);
  });

  test("enables an existing commented-off MCP registry when the user adds a server", async () => {
    const root = await tempRoot();
    const configDir = join(root, "config");
    await Bun.write(join(configDir, "mcp.yaml"), "enabled: false # intentionally disabled\n\nservers:\n");
    const env = { VESICLE_CONFIG_DIR: configDir };
    await writeSetupConfiguration({
      baseUrl: "https://api.example.com/v1",
      apiKey: "secret",
      modelIds: ["model"],
      defaultModel: "model",
      mcpServers: [{ name: "public", url: "https://mcp.example.com/mcp", auth: "none", enabledEngines: ["etl"] }],
      permissionMode: "MOMENTUM",
      projectDirectory: join(root, "project"),
    }, env);
    const loaded = await loadMcpConfig(env);
    expect(loaded.configured && loaded.config.enabled).toBe(true);
  });

  test("rolls back only snapshotted files and removes backups after a failed save", async () => {
    const root = await tempRoot();
    const configDir = join(root, "config");
    const providerPath = join(configDir, "providers.yaml");
    const envPath = join(configDir, ".env");
    const statePath = join(configDir, "setup-state.json");
    await mkdir(join(configDir, "permissions.yaml"), { recursive: true });
    const providerSource = [
      "default:",
      "  provider: old",
      "  model: old-model",
      "",
      "providers:",
      "  old:",
      "    protocol: openai-chat-compatible",
      "    baseUrl: https://old.example/v1",
      "    apiKeyEnv: OLD_API_KEY",
      "    models:",
      "      - old-model",
      "",
    ].join("\n");
    await writeFile(providerPath, providerSource, "utf8");
    await writeFile(envPath, "OLD_API_KEY=old-secret\n", "utf8");
    await writeFile(statePath, '{"version":1,"projectDirectory":"keep-me"}\n', "utf8");

    await expect(writeSetupConfiguration({
      baseUrl: "https://new.example/v1",
      apiKey: "new-secret",
      modelIds: ["new-model"],
      defaultModel: "new-model",
      permissionMode: "MOMENTUM",
      projectDirectory: join(root, "project"),
    }, { VESICLE_CONFIG_DIR: configDir })).rejects.toThrow();

    expect(await readFile(providerPath, "utf8")).toBe(providerSource);
    expect(await readFile(envPath, "utf8")).toBe("OLD_API_KEY=old-secret\n");
    expect(await readFile(statePath, "utf8")).toBe('{"version":1,"projectDirectory":"keep-me"}\n');
    expect((await readdir(configDir)).filter((name) => name.includes(".backup-"))).toEqual([]);
  });
});

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "vesicle-setup-"));
  roots.push(root);
  return root;
}
