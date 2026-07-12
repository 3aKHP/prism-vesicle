import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { loadEngineProfile } from "../src/core/engine/profile";
import { getEffectivePromptToolNames } from "../src/cli/commands/prompt-dump";

const rootDir = process.cwd();

describe("prompt interaction contracts", () => {
  test("base prompt describes the current Vesicle interaction contract", async () => {
    const base = await readAsset("assets/prompts/shared/vesicle-base.md");

    expect(base).toContain("Current Interaction Contract");
    expect(base).toContain("ask_user_question");
    expect(base).toContain("request_engine_switch");
    expect(base).toContain("request_confirmation");
    expect(base).toContain("web captures may be created or edited under `source_materials/`");
    expect(base).toContain("`web_search` for source discovery");
    expect(base).toContain("`web_research` when the user needs a cited synthesis");
    expect(base).toContain("`mcp_<prefix>_<tool>`");
    expect(base).toContain("short handle such as `explore-1`");
    expect(base).not.toContain("M0 Interaction");
    expect(base).not.toContain("after M0");
  });

  test("runtime prompt binds its declared turn stop gate to request_confirmation", async () => {
    const runtimeProfile = await loadEngineProfile("runtime");
    const runtimePrompt = await readAsset("assets/prompts/engines/runtime.md");

    expect(runtimeProfile.stopGates).toContain("runtime-turn");
    expect(runtimePrompt).toContain("request_confirmation");
    expect(runtimePrompt).toContain('"runtime-turn"');
  });

  test("choice checkpoints use ask_user_question when no stop gate is declared", async () => {
    for (const engine of ["dyad", "weaver", "weaver-orch"] as const) {
      const profile = await loadEngineProfile(engine);
      const prompt = await readAsset(`assets/prompts/engines/${engine}.md`);

      expect(profile.stopGates).toEqual([]);
      expect(prompt).toContain("ask_user_question");
      expect(prompt).not.toContain("request_confirmation");
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
  test("prompt dump reports runtime-added model-visible tools", async () => {
    const env = { ...process.env, VESICLE_MCP_FILE: join(rootDir, ".missing-test-mcp.yaml") };
    const runtime = await getEffectivePromptToolNames(await loadEngineProfile("runtime"), { env });
    const dyad = await getEffectivePromptToolNames(await loadEngineProfile("dyad"), { env });

    expect(runtime.modelVisible).toContain("request_confirmation");
    expect(runtime.modelVisible).toContain("ask_user_question");
    expect(runtime.modelVisible).toContain("request_engine_switch");
    expect(runtime.hostContracts).toEqual(["config.load", "prompt.load", "session.write"]);

    expect(dyad.modelVisible).not.toContain("request_confirmation");
    expect(dyad.modelVisible).toContain("ask_user_question");
    expect(dyad.modelVisible).toContain("request_engine_switch");
  });
});

async function readAsset(path: string): Promise<string> {
  return readFile(join(rootDir, path), "utf8");
}

async function listTextAssets(path: string): Promise<string[]> {
  const entries = await readdir(join(rootDir, path), { withFileTypes: true });
  const paths = await Promise.all(entries.map(async (entry) => {
    const child = `${path}/${entry.name}`;
    if (entry.isDirectory()) return listTextAssets(child);
    if (/\.(md|yaml|yml|txt)$/.test(entry.name)) return [child];
    return [];
  }));
  return paths.flat();
}
