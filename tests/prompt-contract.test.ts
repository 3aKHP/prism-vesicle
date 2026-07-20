import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { loadAgentProfile } from "../src/core/agents/profile";
import { resolveChildTools } from "../src/core/agents/child-runner";
import { agentToolDefinitions } from "../src/core/agents/tools";
import { resolveToolSurface } from "../src/core/agent-loop/tool-surface";
import { engineIds, loadEngineProfile } from "../src/core/engine/profile";
import { getEffectivePromptToolNames } from "../src/cli/commands/prompt-dump";
import { createEmptyMcpRegistry } from "../src/mcp/registry";
import { createAssetResolver } from "../src/core/runtime/assets";

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
    const stagePrompt = await readAsset("assets/prompts/engines/stage.md");

    expect(stagePrompt).toContain("## 反 AI 味约束");
    expect(stagePrompt).toContain("不是……而是……");
    expect(stagePrompt).toContain("空气中弥漫着");
    expect(stagePrompt).toContain("<!--[!Neural Chain]-->` 内部可使用结构术语");
    expect(stagePrompt).toContain("有首 beat 时");
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
        expect(names).toEqual([]);
        expect(reported.hostContracts).toEqual([]);
      } else {
        expect(names).toContain("ask_user_question");
        expect(names).toContain("request_engine_switch");
        for (const tool of genericHostTools) expect(names).toContain(tool);
      }
    }

    for (const agent of ["scene-writer", "continuity-editor", "chapter-reviewer"] as const) {
      const profile = await loadAgentProfile(agent);
      const tools = resolveChildTools(profile.tools, [], createEmptyMcpRegistry(), true);
      expect(tools.map((definition) => definition.function.name)).toEqual(profile.tools);
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
    expect(runtime.hostContracts).toEqual([]);

    expect(dyad.modelVisible).not.toContain("request_confirmation");
    expect(dyad.modelVisible).toContain("ask_user_question");
    expect(dyad.modelVisible).toContain("request_engine_switch");
    expect(stage).toEqual({ modelVisible: [], hostContracts: [] });
  });

  test("prompt audit omits unavailable launches but keeps background controls", async () => {
    if (process.platform === "win32") return;
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

async function listTextAssets(path: string): Promise<string[]> {
  return (await assets.listFiles(path, true)).filter((file) => /\.(md|yaml|yml|txt)$/.test(file));
}
