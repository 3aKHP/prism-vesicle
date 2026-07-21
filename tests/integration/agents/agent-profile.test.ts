import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { listAgentProfiles, loadAgentProfile, loadAgentSystemPrompt } from "../../../src/core/agents/profile";

describe("agent profile registry", () => {
  test("loads every bundled profile independently of engine ids", async () => {
    const profiles = await listAgentProfiles();
    expect(profiles.map((profile) => profile.id)).toEqual([
      "chapter-reviewer",
      "continuity-editor",
      "explore",
      "general",
      "plan",
      "research",
      "reviewer",
      "scene-writer",
    ]);
    expect(profiles.find((profile) => profile.id === "explore")).toMatchObject({
      contextMode: "fresh",
      defaultMode: "background",
    });
    expect(await loadAgentSystemPrompt(await loadAgentProfile("plan"))).toContain("planning agent");
  });

  test("accepts a sparse project custom profile", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "vesicle-agent-profile-"));
    try {
      await write(join(rootDir, "assets", "agents", "continuity.agent.yaml"), [
        "id: continuity",
        "displayName: Continuity Editor",
        "description: Check continuity.",
        "systemPrompt:",
        "  - assets/prompts/agents/continuity.md",
        "tools:",
        "  - read_file",
        "contextMode: summary",
        "modelPolicy: inherit",
        "defaultMode: background",
        "maxTurns: 12",
        "",
      ].join("\n"));
      await write(join(rootDir, "assets", "prompts", "agents", "continuity.md"), "Check continuity.");
      const profile = await loadAgentProfile("continuity", rootDir);
      expect(profile.id).toBe("continuity");
      expect(profile.asset.source).toBe("project");
      expect(profile.tools).toEqual(["read_file"]);
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  test("rejects prompt paths outside the agent prompt namespace", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "vesicle-agent-profile-invalid-"));
    try {
      await write(join(rootDir, "assets", "agents", "bad.agent.yaml"), [
        "id: bad",
        "displayName: Bad",
        "description: Bad path.",
        "systemPrompt:",
        "  - assets/prompts/engines/etl.md",
        "tools:",
        "  - read_file",
        "contextMode: fresh",
        "modelPolicy: inherit",
        "defaultMode: foreground",
        "maxTurns: 1",
      ].join("\n"));
      await expect(loadAgentProfile("bad", rootDir)).rejects.toThrow("must stay under assets/prompts/agents");
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });
});

async function write(path: string, content: string): Promise<void> {
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, content, "utf8");
}
