import { describe, expect, test } from "bun:test";
import { composeSystemPrompt, loadPromptBundle } from "../src/core/prompt/loader";
import { loadEngineProfile } from "../src/core/engine/profile";

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
});
