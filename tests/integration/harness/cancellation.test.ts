import { rm, } from "node:fs/promises";
import { describe, expect, test } from "bun:test";
import { AgentManager } from "../../../src/core/agents/manager";
import { executeAgentTool } from "../../../src/core/agents/tools";
import {
  bindHarnessDelegation,
  harnessDelegationFailureInteraction,
} from "../../../src/core/harness";
import { createSessionStore, loadSessionSnapshot } from "../../../src/core/session/store";
import { eventually } from "../../support/async/eventually";
import { delegationFixture, harnessRuntime, spawnCall, } from "./fixtures/harness";

describe("harness delegation: cancellation", () => {
  test("crash recovery preserves contract identity and attempt state in the repaired tool result", async () => {
    const fixture = await delegationFixture();
    try {
      const session = await createSessionStore(fixture.root, "parent");
      const call = spawnCall("call-recovered-delegation", "scene-writer");
      await session.append({
        role: "system",
        content: "parent",
        metadata: { harness: fixture.invocation.harness?.identity },
      });
      await session.append({ role: "assistant", content: "delegating", metadata: { toolCalls: [call] } });
      const now = new Date().toISOString();
      const bound = bindHarnessDelegation(harnessRuntime(), "weaver-orch", "scene-writer");
      await fixture.store.save({
        profileId: "scene-writer",
        description: "Recovered scene",
        prompt: "Write scene.",
        mode: "foreground",
        parentSessionId: "parent",
        parentToolCallId: call.id,
        delegation: { ...bound, attempt: 2 },
        delegationFailure: harnessDelegationFailureInteraction(harnessRuntime(), "weaver-orch"),
        attempts: [{
          attempt: 1,
          status: "failed",
          errorCategory: "transient",
          error: "Provider unavailable.",
          finishedAt: now,
        }],
        runId: "run_recovered_delegation",
        handle: "scene-writer-1",
        status: "running",
        createdAt: now,
        updatedAt: now,
      });

      expect(await fixture.store.recoverInterrupted()).toHaveLength(1);
      const snapshot = await loadSessionSnapshot(fixture.root, "parent", { synthesizeDanglingToolResults: false });
      const repaired = snapshot.messages.find((message) => message.role === "tool" && message.toolCallId === call.id);
      const envelope = JSON.parse(repaired?.content ?? "{}") as { result?: string };
      expect(JSON.parse(envelope.result ?? "{}")).toMatchObject({
        status: "failed",
        delegation: { id: "weaver-orch.scene-writer", attempt: 2, retryLimit: 1 },
        attempts: [
          { attempt: 1, status: "failed", errorCategory: "transient" },
          { attempt: 2, status: "failed", errorCategory: "failed" },
        ],
        errorCategory: "failed",
      });
      expect(snapshot.pendingDelegationDecisionRecovery).toMatchObject({
        interactionId: "weaver-orch.agent-failure",
        failed: {
          runId: "run_recovered_delegation",
          delegation: { id: "weaver-orch.scene-writer", attempt: 2 },
          errorCategory: "failed",
        },
      });
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  test("cancellation is terminal and does not open the retry-exhaustion decision", async () => {
    const fixture = await delegationFixture();
    try {
      const manager = new AgentManager(fixture.store, async ({ signal }) => new Promise((_, reject) => {
        if (signal.aborted) reject(signal.reason);
        else signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      }));
      const execution = executeAgentTool({
        call: spawnCall("call-cancel", "scene-writer"),
        manager,
        rootDir: fixture.root,
        parentSessionId: "parent",
        invocation: fixture.invocation,
      });
      await eventually(() => expect(manager.listActive("parent")[0]?.status).toBe("running"));
      expect(await manager.interrupt("scene-writer-1", "parent")).toBe(true);
      const result = await execution;
      expect(result.ok).toBe(false);
      expect(result.delegationDecision).toBeUndefined();
      expect(JSON.parse(result.content)).toMatchObject({ status: "cancelled" });
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

});
