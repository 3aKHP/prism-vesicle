import { rm, } from "node:fs/promises";
import { describe, expect, test } from "bun:test";
import { AgentManager } from "../../../src/core/agents/manager";
import { executeAgentTool } from "../../../src/core/agents/tools";
import { eventually } from "../../support/async/eventually";
import { delegationFixture, spawnCall, } from "./fixtures/harness";

describe("harness delegation: serialization", () => {
  test("serializes contract-bound scene delivery before the next delegation starts", async () => {
    const fixture = await delegationFixture();
    const order: string[] = [];
    let releaseFirst: () => void = () => undefined;
    try {
      const manager = new AgentManager(fixture.store, async ({ spec }) => {
        order.push(`start:${spec.profileId}`);
        if (spec.profileId === "scene-writer") await new Promise<void>((resolve) => { releaseFirst = resolve; });
        order.push(`finish:${spec.profileId}`);
        return { content: spec.profileId };
      }, { maxConcurrent: 4 });
      const first = executeAgentTool({
        call: spawnCall("call-scene", "scene-writer"),
        manager,
        rootDir: fixture.root,
        parentSessionId: "parent",
        invocation: fixture.invocation,
      });
      await eventually(() => expect(order).toEqual(["start:scene-writer"]));
      const second = executeAgentTool({
        call: spawnCall("call-continuity", "continuity-editor"),
        manager,
        rootDir: fixture.root,
        parentSessionId: "parent",
        invocation: fixture.invocation,
      });
      await Bun.sleep(10);
      expect(order).toEqual(["start:scene-writer"]);
      releaseFirst();
      expect((await first).ok).toBe(true);
      expect((await second).ok).toBe(true);
      expect(order).toEqual([
        "start:scene-writer",
        "finish:scene-writer",
        "start:continuity-editor",
        "finish:continuity-editor",
      ]);
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });
});
