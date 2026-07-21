import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const originalFetch = globalThis.fetch;
const originalEnv = { ...process.env };
const providerConfigDirs: string[] = [];

export async function restoreAgentLoopTestState(): Promise<void> {
  globalThis.fetch = originalFetch;
  process.env = { ...originalEnv };
  const dirs = providerConfigDirs.splice(0);
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })));
}
export async function createPromptRoot(options: { stopGates?: string[]; validators?: string[] } = {}): Promise<string> {
  const rootDir = await mkdtemp(join(tmpdir(), "vesicle-agent-loop-"));
  const sharedDir = join(rootDir, "assets", "prompts", "shared");
  const engineDir = join(rootDir, "assets", "prompts", "engines");
  const enginesDir = join(rootDir, "assets", "engines");

  await mkdir(sharedDir, { recursive: true });
  await mkdir(engineDir, { recursive: true });
  await mkdir(enginesDir, { recursive: true });
  await mkdir(join(rootDir, "workspace"), { recursive: true });
  await mkdir(join(rootDir, "source_materials"), { recursive: true });
  await writeFile(join(sharedDir, "vesicle-base.md"), "base\n", "utf8");
  await writeFile(join(engineDir, "etl.md"), "etl\n", "utf8");

  const stopGatesBlock = (options.stopGates ?? []).length > 0
    ? `stopGates:\n${(options.stopGates ?? []).map((g) => `  - ${g}`).join("\n")}\n`
    : "stopGates: []\n";

  const validatorsBlock = (options.validators ?? []).length > 0
    ? `validators:\n${(options.validators ?? []).map((name) => `  - ${name}`).join("\n")}`
    : "validators: []";

  const profileYaml = [
    "id: etl",
    "displayName: Test ETL",
    "protocolVersion: v9.0-state-space",
    "systemPrompt:",
    "  - assets/prompts/shared/vesicle-base.md",
    "  - assets/prompts/engines/etl.md",
    "defaultTools:",
    "  - config.load",
    "  - prompt.load",
    "  - session.write",
    "  - stat_path",
    "  - list_files",
    "  - grep_files",
    "  - read_file",
    "  - view_image",
    "  - write_file",
    validatorsBlock,
    stopGatesBlock,
    "stateRoots:",
    "  - workspace",
    "",
  ].join("\n");
  await writeFile(join(enginesDir, "etl.profile.yaml"), profileYaml, "utf8");

  return rootDir;
}

export async function configureTestProviderEnv(options: { models?: string[]; vision?: boolean } = {}): Promise<void> {
  const configDir = await mkdtemp(join(tmpdir(), "vesicle-agent-provider-"));
  providerConfigDirs.push(configDir);
  const configPath = join(configDir, "providers.yaml");
  await writeFile(configPath, [
    "default:",
    "  provider: test",
    "  model: test-model",
    "providers:",
    "  test:",
    "    protocol: openai-chat-compatible",
    "    baseUrl: https://provider.test/v1",
    "    apiKeyEnv: TEST_PROVIDER_API_KEY",
    "    models:",
    ...(options.models ?? (options.vision
      ? [
          "      - id: test-model",
          "        capabilities:",
          "          vision: true",
        ]
      : ["      - test-model"])),
    "",
  ].join("\n"), "utf8");
  await writeFile(join(configDir, ".env"), "TEST_PROVIDER_API_KEY=test-key\n", "utf8");
  process.env.VESICLE_PROVIDERS_FILE = configPath;
  delete process.env.TEST_PROVIDER_API_KEY;
  delete process.env.VESICLE_API_KEY;
  delete process.env.VESICLE_PROVIDER;
  delete process.env.VESICLE_BASE_URL;
  delete process.env.VESICLE_MODEL;
}

export function testPng(): Uint8Array {
  return Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
}

export async function cleanupProviderConfigDirs(): Promise<void> {
  const dirs = providerConfigDirs.splice(0);
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })));
}
