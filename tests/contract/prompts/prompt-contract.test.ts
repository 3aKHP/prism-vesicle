import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { runPrompt } from "../../../src/core/agent-loop/run";
import { loadAgentProfile } from "../../../src/core/agents/profile";
import { resolveChildTools } from "../../../src/core/agents/child-runner";
import { agentToolDefinitions } from "../../../src/core/agents/tools";
import { resolveToolSurface } from "../../../src/core/agent-loop/tool-surface";
import { engineIds, loadEngineProfile } from "../../../src/core/engine/profile";
import { getEffectivePromptToolNames } from "../../../src/cli/commands/prompt-dump";
import { createEmptyMcpRegistry } from "../../../src/mcp/registry";
import { createAssetResolver } from "../../../src/core/runtime/assets";
import { composeSystemPrompt, loadPromptBundle } from "../../../src/core/prompt/loader";

const rootDir = process.cwd();
const assets = createAssetResolver(rootDir);

describe("prompt interaction contracts", () => {
  test("profiles declare runtime interactions while compiled prompts stay host-neutral", async () => {
    const runtimeProfile = await loadEngineProfile("runtime");
    const runtimePrompt = await readAsset("assets/prompts/engines/runtime.md");

    expect(runtimeProfile.stopGates).toContain("runtime-turn");
    expect(runtimePrompt).toContain("hal://interaction/runtime.turn");
    expect(runtimePrompt).not.toContain("request_confirmation");
    expect(runtimePrompt).not.toContain("Host Adapter Binding");
  });

  test("choice checkpoints remain declarative in compiled prompts", async () => {
    for (const engine of ["dyad", "weaver", "weaver-orch"] as const) {
      const profile = await loadEngineProfile(engine);
      const prompt = await readAsset(`assets/prompts/engines/${engine}.md`);

      expect(profile.stopGates).toEqual([]);
      expect(prompt).toContain("hal://interaction/");
      expect(prompt).not.toContain("ask_user_question");
      expect(prompt).not.toContain("Host Adapter Binding");
    }
  });

  test("Stage retains the compact Phase II prose and anti-AI constraints", async () => {
    const stagePrompt = await composedPrompt("stage");

    expect(stagePrompt).toContain("## 反 AI 味约束");
    expect(stagePrompt).toContain("不是……而是……");
    expect(stagePrompt).toContain("空气中弥漫着");
    expect(stagePrompt).toContain("<!--[!Neural Chain]-->` 内部可使用结构术语");
    expect(stagePrompt).toContain("有首 beat 时");
    expect(stagePrompt).toContain("结构输出使用英文半角标点");
    expect(stagePrompt).toContain("```html\n<!--\n[!Neural Chain]");
    expect(stagePrompt).toContain("```text\n【Status】");
  });

  test("stable Harness output and checkpoint guidance reaches composed prompts", async () => {
    const [dyadPrompt, etlPrompt, orchestratorPrompt] = await Promise.all([
      composedPrompt("dyad"),
      composedPrompt("etl"),
      composedPrompt("weaver-orch"),
    ]);

    expect(dyadPrompt).toContain("每轮以 `## Turn {N}` 为分隔追加到日志");
    expect(dyadPrompt).toContain("[回应正文：200–800 字简体中文高密度叙事");
    expect(etlPrompt).toContain("完成后输出各文件路径与压缩要点摘要");
    expect(orchestratorPrompt).toContain("`Mode A` 为章节级（章节编译后）");
    expect(orchestratorPrompt).toContain("`Mode B` 为场景级（每个 Scene 后）");
  });

  test("stable Harness template corrections are available through the active asset resolver", async () => {
    const [moduleA, outline] = await Promise.all([
      readAsset("assets/templates/tpl_module_a.md"),
      readAsset("assets/templates/tpl_outline.md"),
    ]);

    expect(moduleA).toContain("- Extreme access condition:");
    expect(outline).toContain("## Volume 1: [卷名] [可选，单卷/纯章项目删除此块]");
  });

  test("stable Harness prompts reach the real provider request boundary", async () => {
    const root = await mkdtemp(join(tmpdir(), "vesicle-harness-consumer-"));
    const configDir = join(root, "config");
    const providersFile = join(configDir, "providers.yaml");
    const previousEnv = {
      VESICLE_CONFIG_DIR: process.env.VESICLE_CONFIG_DIR,
      VESICLE_PROVIDERS_FILE: process.env.VESICLE_PROVIDERS_FILE,
      VESICLE_MCP_FILE: process.env.VESICLE_MCP_FILE,
      VESICLE_HOST_ASSETS_DIR: process.env.VESICLE_HOST_ASSETS_DIR,
    };
    const originalFetch = globalThis.fetch;
    const requests: Array<{ messages?: Array<{ role?: string; content?: string }> }> = [];
    try {
      await mkdir(configDir, { recursive: true });
      await writeFile(providersFile, [
        "default:",
        "  provider: fixture",
        "  model: fixture-model",
        "providers:",
        "  fixture:",
        "    protocol: openai-chat-compatible",
        "    baseUrl: https://provider.test/v1",
        "    apiKeyEnv: HARNESS_FIXTURE_KEY",
        "    models:",
        "      - fixture-model",
        "",
      ].join("\n"), "utf8");
      await writeFile(join(configDir, ".env"), "HARNESS_FIXTURE_KEY=test-key\n", "utf8");
      process.env.VESICLE_CONFIG_DIR = configDir;
      process.env.VESICLE_PROVIDERS_FILE = providersFile;
      process.env.VESICLE_MCP_FILE = join(configDir, "missing-mcp.yaml");
      process.env.VESICLE_HOST_ASSETS_DIR = join(root, "empty-host-assets");
      globalThis.fetch = Object.assign(async (_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
        requests.push(JSON.parse(String(init?.body)) as { messages?: Array<{ role?: string; content?: string }> });
        return Response.json({
          id: `harness-consumer-${requests.length}`,
          choices: [{ message: { content: "fixture response" } }],
        });
      }, { preconnect: originalFetch.preconnect });

      for (const engine of ["dyad", "etl", "weaver-orch"] as const) {
        const result = await runPrompt({ input: `consumer boundary ${engine}`, engine, rootDir: root });
        expect(result.kind, engine).toBe("complete");
      }

      expect(requests).toHaveLength(3);
      const systems = requests.map((request) => request.messages?.[0]?.content ?? "");
      expect(systems[0]).toMatch(/^## State Navigator$/m);
      expect(systems[0]).toContain("### 三段式回应 / Prose Content");
      expect(systems[1]).toContain("完成后输出各文件路径与压缩要点摘要");
      expect(systems[2]).toContain("`Mode A` 为章节级（章节编译后）");
    } finally {
      globalThis.fetch = originalFetch;
      for (const [key, value] of Object.entries(previousEnv)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      await rm(root, { recursive: true, force: true });
    }
  });

  test("assets do not expose mismatched RooCode-era tool names", async () => {
    for (const asset of await listTextAssets("assets")) {
      const text = await readAsset(asset);
      expect(text).not.toContain("ask_followup_questions");
      expect(text).not.toContain("apply_diff");
    }
  });
});

describe("prompt audit tool surface", () => {
  test("capability snapshots match the actual Engine and Agent tool surfaces", async () => {
    const env = { ...process.env, VESICLE_MCP_FILE: join(rootDir, ".missing-test-mcp.yaml") };
    const genericHostTools = agentToolDefinitions.map((definition) => definition.function.name);

    for (const engine of engineIds) {
      const profile = await loadEngineProfile(engine);
      const actual = await resolveToolSurface(profile, true, false, "auto", { env });
      const reported = await getEffectivePromptToolNames(profile, { env });
      const names = actual.definitions.map((definition) => definition.function.name);

      expect(reported.modelVisible).toEqual(names);
      if (engine === "stage") {
        expect(names).not.toContain("list_directory");
      } else {
        expect(names.filter((name) => name === "list_directory")).toHaveLength(1);
        expect(names).not.toContain("list_files");
      }
      if (engine === "stage") {
        expect(names).toEqual([]);
      } else {
        expect(names).toContain("ask_user_question");
        expect(names).toContain("request_engine_switch");
        for (const tool of genericHostTools) expect(names).toContain(tool);
        for (const tool of ["delete_file", "move_file", "move_directory", "delete_directory"]) {
          expect(names).toContain(tool);
        }
      }
    }

    for (const agent of ["scene-writer", "continuity-editor", "chapter-reviewer"] as const) {
      const profile = await loadAgentProfile(agent);
      const tools = resolveChildTools(profile.tools, [], createEmptyMcpRegistry(), true);
      expect(tools.map((definition) => definition.function.name)).toEqual([...new Set(profile.tools)]);
      for (const tool of ["delete_file", "move_file", "move_directory", "delete_directory"]) {
        expect(profile.tools).toContain(tool);
      }
    }
  });

  test("prompt dump reports runtime-added model-visible tools", async () => {
    const env = { ...process.env, VESICLE_MCP_FILE: join(rootDir, ".missing-test-mcp.yaml") };
    const runtime = await getEffectivePromptToolNames(await loadEngineProfile("runtime"), { env });
    const dyad = await getEffectivePromptToolNames(await loadEngineProfile("dyad"), { env });
    const stage = await getEffectivePromptToolNames(await loadEngineProfile("stage"), { env }, true, "auto");

    expect(runtime.modelVisible).toContain("request_confirmation");
    expect(runtime.modelVisible).toContain("ask_user_question");
    expect(runtime.modelVisible).toContain("request_engine_switch");

    expect(dyad.modelVisible).not.toContain("request_confirmation");
    expect(dyad.modelVisible).toContain("ask_user_question");
    expect(dyad.modelVisible).toContain("request_engine_switch");
    expect(stage).toEqual({ modelVisible: [] });
  });

  test.skipIf(process.platform === "win32")("prompt audit omits unavailable launches but keeps background controls", async () => {
    const env = { ...process.env, VESICLE_MCP_FILE: join(rootDir, ".missing-test-mcp.yaml") };
    const tools = await getEffectivePromptToolNames(
      await loadEngineProfile("runtime"),
      { env },
      true,
      "powershell-7",
    );
    expect(tools.modelVisible).not.toContain("shell_exec");
    expect(tools.modelVisible).toContain("shell_output");
    expect(tools.modelVisible).toContain("shell_stop");
  });
});

async function readAsset(path: string): Promise<string> {
  return assets.readText(path);
}

async function composedPrompt(engine: (typeof engineIds)[number]): Promise<string> {
  const profile = await loadEngineProfile(engine, rootDir, assets);
  return composeSystemPrompt(await loadPromptBundle(profile, rootDir, assets));
}

async function listTextAssets(path: string): Promise<string[]> {
  return (await assets.listFiles(path, true)).filter((file) => /\.(md|yaml|yml|txt)$/.test(file));
}
