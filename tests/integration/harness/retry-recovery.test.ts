import { rm, } from "node:fs/promises";
import { describe, expect, test } from "bun:test";
import { AgentManager } from "../../../src/core/agents/manager";
import { agentToolDefinitions, executeAgentTool } from "../../../src/core/agents/tools";
import {
  HarnessAdapterError,
} from "../../../src/core/harness";
import { executeToolRound } from "../../../src/core/agent-loop/tool-round-executor";
import { planToolRound } from "../../../src/core/agent-loop/tool-round-planner";
import { defaultPermissionRuntime, } from "../../../src/core/permissions";
import { getProcessManager } from "../../../src/core/process/manager";
import { createSessionStore, loadSessionRecords, } from "../../../src/core/session/store";
import type { VesicleMessage } from "../../../src/providers/shared/types";
import { delegationFixture, emptyMcp, spawnCall, testConfig, weaverOrchProfile } from "./fixtures/harness";

describe("harness delegation: retry recovery", () => {
  test("retries transient failure once and returns the successful terminal result", async () => {
    const fixture = await delegationFixture();
    let runs = 0;
    try {
      const manager = new AgentManager(fixture.store, async () => {
        runs += 1;
        if (runs === 1) throw new HarnessAdapterError("transient", "Provider temporarily unavailable.");
        return { content: "scene delivered" };
      });
      const result = await executeAgentTool({
        call: spawnCall("call-retry", "scene-writer"),
        manager,
        rootDir: fixture.root,
        parentSessionId: "parent",
        invocation: fixture.invocation,
      });
      expect(result.ok).toBe(true);
      expect(runs).toBe(2);
      expect(JSON.parse(result.content)).toMatchObject({
        content: "scene delivered",
        delegation: { attempt: 2, retryLimit: 1 },
        attempts: [
          { attempt: 1, status: "failed", errorCategory: "transient" },
          { attempt: 2, status: "completed" },
        ],
      });
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  test("does not rerun a completed delegation when terminal persistence fails", async () => {
    const fixture = await delegationFixture();
    let runs = 0;
    const save = fixture.store.save.bind(fixture.store);
    fixture.store.save = async (metadata) => {
      if (metadata.status === "completed") {
        throw new HarnessAdapterError("transient", "Terminal persistence temporarily unavailable.");
      }
      await save(metadata);
    };
    try {
      const manager = new AgentManager(fixture.store, async () => {
        runs += 1;
        return { content: "scene delivered" };
      });
      const result = await executeAgentTool({
        call: spawnCall("call-persistence-failure", "scene-writer"),
        manager,
        rootDir: fixture.root,
        parentSessionId: "parent",
        invocation: fixture.invocation,
      });
      expect(result.ok).toBe(false);
      expect(runs).toBe(1);
      expect(JSON.parse(result.content)).toMatchObject({
        error: { category: "transient", message: "Terminal persistence temporarily unavailable." },
      });
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  test("recovery does not duplicate a parent result after terminal persistence fails", async () => {
    const fixture = await delegationFixture();
    const call = spawnCall("call-persistence-recovery", "scene-writer");
    const session = await createSessionStore(fixture.root, "parent");
    await session.append({
      role: "system",
      content: "parent",
      metadata: { harness: fixture.invocation.harness?.identity },
    });
    await session.append({ role: "assistant", content: "delegating", metadata: { toolCalls: [call] } });
    const save = fixture.store.save.bind(fixture.store);
    fixture.store.save = async (metadata) => {
      if (metadata.status === "completed") {
        throw new HarnessAdapterError("transient", "Terminal persistence temporarily unavailable.");
      }
      await save(metadata);
    };
    try {
      const messages: VesicleMessage[] = [{ role: "assistant", content: "delegating", toolCalls: [call] }];
      const result = await executeToolRound({
        plan: planToolRound([call], agentToolDefinitions, defaultPermissionRuntime),
        rootDir: fixture.root,
        config: testConfig(),
        systemPrompt: "parent",
        tools: agentToolDefinitions,
        mcpRegistry: emptyMcp(),
        messages,
        parentMessagesBeforeToolCall: [],
        session,
        profile: weaverOrchProfile(),
        agentManager: new AgentManager(fixture.store, async () => ({ content: "scene delivered" })),
        processManager: getProcessManager(fixture.root),
        permission: defaultPermissionRuntime,
        harness: fixture.invocation.harness,
        assets: fixture.invocation.assets,
        trackCheckpointMutation: async () => undefined,
        markCheckpointTainted: async () => undefined,
      });
      expect(result.anyFailed).toBe(true);
      expect((await loadSessionRecords(fixture.root, "parent"))
        .filter((record) => record.role === "tool" && record.metadata?.toolCallId === call.id)).toHaveLength(1);

      fixture.store.save = save;
      expect(await fixture.store.recoverInterrupted()).toHaveLength(1);
      expect((await loadSessionRecords(fixture.root, "parent"))
        .filter((record) => record.role === "tool" && record.metadata?.toolCallId === call.id)).toHaveLength(1);
    } finally {
      fixture.store.save = save;
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

});
