import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, test } from "bun:test";
import { engineIds, loadEngineProfile } from "../src/core/engine/profile";

describe("engine profile loader", () => {
  test("loads every bundled profile without error", async () => {
    for (const id of engineIds) {
      const profile = await loadEngineProfile(id);
      expect(profile.id).toBe(id);
      expect(profile.systemPrompt.length).toBeGreaterThanOrEqual(1);
      if (id === "stage") {
        expect(profile.defaultTools).toEqual([]);
        expect(profile.stopGates).toEqual([]);
        expect(profile.validators).toEqual(["runtime-packet"]);
      } else {
        expect(profile.defaultTools).toContain("write_file");
      }
    }
  });

  test("ETL profile declares blueprint and phase stop gates", async () => {
    const etl = await loadEngineProfile("etl");
    expect(etl.stopGates).toContain("blueprint-confirmation");
    expect(etl.stopGates).toContain("phase-confirmation");
    expect(etl.displayName).toBe("Prism ETL Engine");
    expect(etl.protocolVersion).toBe("v10.1-prompt-assembly");
  });

  test("runtime profile declares the runtime-turn stop gate", async () => {
    const runtime = await loadEngineProfile("runtime");
    expect(runtime.stopGates).toContain("runtime-turn");
  });

  test("Tavily web tools are scoped to research and audit engines", async () => {
    const webTools = ["web_search", "web_fetch", "web_map", "web_crawl", "web_research"];
    const etlTools = (await loadEngineProfile("etl")).defaultTools;
    const evaluateTools = (await loadEngineProfile("evaluate")).defaultTools;
    const runtimeTools = (await loadEngineProfile("runtime")).defaultTools;
    for (const tool of webTools) {
      expect(etlTools).toContain(tool);
      expect(evaluateTools).toContain(tool);
      expect(runtimeTools).not.toContain(tool);
    }
  });

  test("rejects a profile whose id does not match the filename", async () => {
    const rootDir = await createProfileRoot(
      "dyad",
      [
        "id: etl",
        "displayName: Mismatch",
        "protocolVersion: v9.0-state-space",
        "systemPrompt:",
        "  - assets/prompts/engines/etl.md",
        "defaultTools: []",
        "validators: []",
        "stopGates: []",
        "stateRoots: []",
        "",
      ].join("\n"),
    );
    await expect(loadEngineProfile("dyad", rootDir)).rejects.toThrow(/declares id "etl" but was loaded as "dyad"/);
  });

  test("rejects a profile missing the systemPrompt list", async () => {
    const rootDir = await createProfileRoot(
      "etl",
      ["id: etl", "displayName: X", "protocolVersion: v9", "defaultTools: []", "validators: []", "stopGates: []", "stateRoots: []", ""].join("\n"),
    );
    await expect(loadEngineProfile("etl", rootDir)).rejects.toThrow(/missing required field "systemPrompt"/);
  });

  test("rejects an empty systemPrompt list", async () => {
    const rootDir = await createProfileRoot(
      "etl",
      [
        "id: etl",
        "displayName: X",
        "protocolVersion: v9",
        "systemPrompt: []",
        "defaultTools: []",
        "validators: []",
        "stopGates: []",
        "stateRoots: []",
        "",
      ].join("\n"),
    );
    await expect(loadEngineProfile("etl", rootDir)).rejects.toThrow(/must declare at least one systemPrompt path/);
  });
});

async function createProfileRoot(engine: string, profileContent: string): Promise<string> {
  const rootDir = await mkdtemp(join(tmpdir(), "vesicle-profile-"));
  const enginesDir = join(rootDir, "assets", "engines");
  await mkdir(enginesDir, { recursive: true });
  await writeFile(join(enginesDir, `${engine}.profile.yaml`), profileContent, "utf8");
  return rootDir;
}
