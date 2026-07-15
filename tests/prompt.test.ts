import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { composeSystemPrompt, loadPromptBundle } from "../src/core/prompt/loader";
import { loadEngineProfile } from "../src/core/engine/profile";
import { AssetResolver } from "../src/core/runtime/assets";

describe("prompt loading", () => {
  test("loads the Vesicle base prompt and ETL engine prompt from the ETL profile", async () => {
    const profile = await loadEngineProfile("etl");
    const bundle = await loadPromptBundle(profile);
    const systemPrompt = composeSystemPrompt(bundle);

    expect(profile.systemPrompt).toEqual([
      "assets/prompts/shared/vesicle-base.md",
      "assets/prompts/engines/etl.md",
    ]);
    expect(bundle.sections).toHaveLength(2);
    expect(bundle.sections[0].text).toContain("Vesicle Base Contract");
    expect(bundle.sections[1].text).toContain("Prism ETL Engine");
    expect(bundle.sections[1].text).toContain("phase-confirmation");
    expect(bundle.sections[1].text).not.toContain("M0 仅 Phase 0");
    expect(systemPrompt).toContain("Prism ETL Engine");
  });

  test("composes one prompt from bundled, user, and project asset layers", async () => {
    const root = await mkdtemp(join(tmpdir(), "vesicle-layered-prompt-"));
    const project = join(root, "project");
    const config = join(root, "config");
    try {
      await mkdir(join(project, "assets", "prompts", "engines"), { recursive: true });
      await mkdir(join(config, "assets", "prompts", "shared"), { recursive: true });
      await writeFile(join(project, "assets", "prompts", "engines", "etl.md"), "Project ETL", "utf8");
      await writeFile(join(config, "assets", "prompts", "shared", "vesicle-base.md"), "User base", "utf8");
      const assets = new AssetResolver(project, {
        env: { VESICLE_CONFIG_DIR: config },
        bundledDirectory: join(import.meta.dir, "..", "assets"),
        executablePath: join(root, "missing", "vesicle"),
      });

      const profile = await loadEngineProfile("etl", project, assets);
      const bundle = await loadPromptBundle(profile, project, assets);
      expect(profile.asset.source).toBe("bundled");
      expect(bundle.sections.map((section) => section.source)).toEqual(["user", "project"]);
      expect(composeSystemPrompt(bundle)).toBe("User base\n\nProject ETL");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
