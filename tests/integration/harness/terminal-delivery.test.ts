import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { AgentManager } from "../../../src/core/agents/manager";
import { executeAgentTool } from "../../../src/core/agents/tools";
import { delegationFixture, spawnCall, } from "./fixtures/harness";

describe("harness delegation: terminal delivery", () => {
  test("persists fixed identity and terminal delivery for every released Agent Profile", async () => {
    const fixture = await delegationFixture();
    try {
      const manager = new AgentManager(fixture.store, async ({ spec }) => ({ content: `done:${spec.profileId}` }));
      for (const profile of ["scene-writer", "continuity-editor", "chapter-reviewer"]) {
        const result = await executeAgentTool({
          call: spawnCall(`call-${profile}`, profile),
          manager,
          rootDir: fixture.root,
          parentSessionId: "parent",
          invocation: fixture.invocation,
        });
        expect(result.ok).toBe(true);
        const content = JSON.parse(result.content) as any;
        expect(content).toMatchObject({
          profileId: profile,
          mode: "foreground",
          status: "completed",
          content: `done:${profile}`,
          delegation: { agent: profile, mode: "foreground", retryLimit: 1, attempt: 1 },
          attempts: [{ attempt: 1, status: "completed" }],
        });
        const stored = await fixture.store.resolveReference("parent", content.agent_id);
        expect(stored).toMatchObject({
          profileId: profile,
          status: "completed",
          delegation: { agent: profile, purpose: expect.any(String), retryLimit: 1, attempt: 1 },
          attempts: [{ attempt: 1, status: "completed" }],
        });
      }
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  test("keeps generic host Agents outside Driver delegation while rejecting arbitrary profiles", async () => {
    const fixture = await delegationFixture();
    let runs = 0;
    try {
      const manager = new AgentManager(fixture.store, async ({ spec }) => {
        runs += 1;
        return { content: `done:${spec.profileId}` };
      });
      const generic = await executeAgentTool({
        call: {
          id: "call-explore",
          name: "spawn_agent",
          arguments: JSON.stringify({
            profile: "explore",
            description: "Explore repository",
            prompt: "Map the repository.",
            mode: "foreground",
          }),
        },
        manager,
        rootDir: fixture.root,
        parentSessionId: "parent",
        invocation: fixture.invocation,
      });
      expect(generic.ok).toBe(true);
      expect(JSON.parse(generic.content)).toMatchObject({
        profileId: "explore",
        status: "completed",
      });
      expect(JSON.parse(generic.content).delegation).toBeUndefined();

      await writeFile(join(fixture.root, "assets", "agents", "custom.agent.yaml"), [
        "id: custom",
        "displayName: Custom",
        "description: Undeclared project Agent.",
        "systemPrompt:",
        "  - assets/prompts/agents/custom.md",
        "tools:",
        "  - read_file",
        "contextMode: fresh",
        "modelPolicy: inherit",
        "defaultMode: foreground",
        "maxTurns: 4",
        "",
      ].join("\n"), "utf8");
      await writeFile(join(fixture.root, "assets", "prompts", "agents", "custom.md"), "Custom prompt.\n", "utf8");
      const arbitrary = await executeAgentTool({
        call: spawnCall("call-custom", "custom"),
        manager,
        rootDir: fixture.root,
        parentSessionId: "parent",
        invocation: fixture.invocation,
      });
      expect(arbitrary.ok).toBe(false);
      expect(JSON.parse(arbitrary.content)).toMatchObject({
        error: { category: "invalid_request" },
      });
      expect(arbitrary.content).toContain("does not declare delegation");
      expect(runs).toBe(1);
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  test("lists profiles from the same managed asset resolver used for delegation", async () => {
    const fixture = await delegationFixture();
    try {
      const result = await executeAgentTool({
        call: { id: "call-list", name: "list_agents", arguments: "{}" },
        manager: new AgentManager(fixture.store, async () => ({ content: "unused" })),
        rootDir: fixture.root,
        parentSessionId: "parent",
        invocation: fixture.invocation,
      });
      expect(result.ok).toBe(true);
      expect((JSON.parse(result.content) as any).profiles.map((profile: any) => profile.id)).toEqual(expect.arrayContaining([
        "scene-writer",
        "continuity-editor",
        "chapter-reviewer",
      ]));
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

});
