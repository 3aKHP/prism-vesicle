import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { AgentManager } from "../../../src/core/agents/manager";
import { agentToolDefinitions, executeAgentTool } from "../../../src/core/agents/tools";
import {
  HarnessAdapterError,
} from "../../../src/core/harness";
import { executeToolRound } from "../../../src/core/agent-loop/tool-round-executor";
import { appendHarnessDelegationDecision } from "../../../src/core/agent-loop/delegation-decision";
import { planToolRound } from "../../../src/core/agent-loop/tool-round-planner";
import { defaultPermissionRuntime, } from "../../../src/core/permissions";
import { getProcessManager } from "../../../src/core/process/manager";
import { createSessionStore, listSessions, loadSessionRecords, loadSessionSnapshot } from "../../../src/core/session/store";
import type { VesicleMessage } from "../../../src/providers/shared/types";
import { resolveUserQuestion, } from "../../../src/core/agent-loop/run";
import { FileCheckpointManager } from "../../../src/core/checkpoints/file-history";
import { configureFixtureProvider, delegationFixture, emptyMcp, spawnCall, testConfig, weaverOrchProfile } from "./fixtures/harness";

describe("harness delegation: decision resume", () => {
  test("exhausts transient retries and returns the declared user decision point", async () => {
    const fixture = await delegationFixture();
    let runs = 0;
    try {
      const manager = new AgentManager(fixture.store, async () => {
        runs += 1;
        throw new HarnessAdapterError("transient", "Provider temporarily unavailable.");
      });
      const result = await executeAgentTool({
        call: spawnCall("call-exhaust", "scene-writer"),
        manager,
        rootDir: fixture.root,
        parentSessionId: "parent",
        invocation: fixture.invocation,
      });
      expect(result.ok).toBe(false);
      expect(runs).toBe(2);
      expect(result.delegationDecision).toMatchObject({
        interactionId: "weaver-orch.agent-failure",
        failed: {
          runId: expect.stringMatching(/^run_/),
          delegation: { id: "weaver-orch.scene-writer", attempt: 2 },
          errorCategory: "transient",
        },
        question: expect.objectContaining({
          header: "Subtask failure",
          options: [
            expect.objectContaining({ label: "Retry" }),
            expect.objectContaining({ label: "Manual repair" }),
            expect.objectContaining({ label: "Abort chapter" }),
          ],
        }),
      });
      expect(JSON.parse(result.content)).toMatchObject({
        status: "failed",
        errorCategory: "transient",
        delegation: { attempt: 2, retryLimit: 1 },
        attempts: [
          { attempt: 1, status: "failed", errorCategory: "transient" },
          { attempt: 2, status: "failed", errorCategory: "transient" },
        ],
      });
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  test("persists retry exhaustion as a paired and resumable host decision point", async () => {
    const fixture = await delegationFixture();
    try {
      const manager = new AgentManager(fixture.store, async () => {
        throw new HarnessAdapterError("transient", "Provider temporarily unavailable.");
      });
      const call = spawnCall("call-persisted-exhaustion", "scene-writer");
      const session = await createSessionStore(fixture.root, "parent");
      await session.append({
        role: "system",
        content: "parent",
        metadata: { harness: fixture.invocation.harness?.identity },
      });
      await session.append({ role: "assistant", content: "delegating", metadata: { toolCalls: [call] } });
      const messages: VesicleMessage[] = [{ role: "assistant", content: "delegating", toolCalls: [call] }];
      const result = await executeToolRound({
        plan: planToolRound([call], agentToolDefinitions, defaultPermissionRuntime),
        rootDir: fixture.root,
        config: {
          provider: "openai-chat-compatible",
          providerId: "test",
          baseUrl: "https://provider.test/v1",
          model: "test-model",
        },
        systemPrompt: "parent",
        tools: agentToolDefinitions,
        mcpRegistry: {
          definitions: [],
          statuses: [],
          hasTool: () => false,
          execute: async () => { throw new Error("unexpected MCP call"); },
        },
        messages,
        parentMessagesBeforeToolCall: [],
        session,
        profile: {
          id: "weaver-orch",
          displayName: "Weaver-Orch",
          protocolVersion: "v10",
          systemPrompt: [],
          defaultTools: [],
          validators: [],
          stopGates: [],
          stateRoots: ["workspace", "novels", "reports"],
          asset: { path: "assets/engines/weaver-orch.profile.yaml", source: "project" },
        },
        agentManager: manager,
        processManager: getProcessManager(fixture.root),
        permission: defaultPermissionRuntime,
        harness: fixture.invocation.harness,
        assets: fixture.invocation.assets,
        trackCheckpointMutation: async () => undefined,
        markCheckpointTainted: async () => undefined,
      });
      expect(result.delegationPause).toMatchObject({
        question: { header: "Subtask failure" },
        toolCallId: expect.stringContaining("delegation-decision_"),
      });
      expect(result.delegationPause?.question.options).toHaveLength(3);
      expect(result.delegationPause?.question.options.map((option) => option.id)).toEqual([
        "retry",
        "manual-repair",
        "abort",
      ]);
      expect(messages.map((message) => message.role)).toEqual(["assistant", "tool", "assistant"]);
      const snapshot = await loadSessionSnapshot(fixture.root, "parent", { synthesizeDanglingToolResults: false });
      expect(snapshot.pendingUserQuestion).toMatchObject({
        toolCallId: result.delegationPause?.toolCallId,
        question: { header: "Subtask failure" },
      });
      expect(snapshot.pendingUserQuestion?.delegationDecision).toMatchObject({
        interactionId: "weaver-orch.agent-failure",
        failed: { delegation: { id: "weaver-orch.scene-writer", attempt: 2 } },
      });
      expect(snapshot.pendingDelegationDecisionRecovery).toBeUndefined();
      expect(snapshot.messages.filter((message) => message.role === "tool" && message.toolCallId === call.id)).toHaveLength(1);
      expect(snapshot.messages.at(-1)).toMatchObject({
        role: "assistant",
        toolCalls: [expect.objectContaining({ id: result.delegationPause?.toolCallId, name: "ask_user_question" })],
      });
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  test("restores a decision point when a failed result persisted before its question", async () => {
    const fixture = await delegationFixture();
    try {
      const call = spawnCall("call-orphaned-decision", "scene-writer");
      const failed = await executeAgentTool({
        call,
        manager: new AgentManager(fixture.store, async () => {
          throw new HarnessAdapterError("transient", "Provider temporarily unavailable.");
        }),
        rootDir: fixture.root,
        parentSessionId: "parent",
        invocation: fixture.invocation,
      });
      if (!failed.delegationDecision) throw new Error("expected delegation decision");
      const session = await createSessionStore(fixture.root, "parent");
      await session.append({
        role: "system",
        content: "parent",
        metadata: { engine: "weaver-orch", harness: fixture.invocation.harness?.identity },
      });
      await session.append({ role: "assistant", content: "delegating", metadata: { toolCalls: [call] } });
      await session.append({
        role: "tool",
        content: JSON.stringify({ ok: false, result: failed.content }),
        metadata: {
          name: "spawn_agent",
          ok: false,
          toolCallId: call.id,
          delegationDecision: failed.delegationDecision,
        },
      });

      const interrupted = await loadSessionSnapshot(fixture.root, "parent", { synthesizeDanglingToolResults: false });
      expect(interrupted.pendingDelegationDecisionRecovery).toMatchObject({
        interactionId: "weaver-orch.agent-failure",
        failed: { runId: failed.delegationDecision.failed.runId },
      });
      expect((await listSessions(fixture.root))[0]?.pendingUserQuestion).toMatchObject({
        header: "Subtask failure",
      });

      await appendHarnessDelegationDecision({
        decision: interrupted.pendingDelegationDecisionRecovery!,
        messages: [],
        session,
        engine: "weaver-orch",
      });
      const restored = await loadSessionSnapshot(fixture.root, "parent", { synthesizeDanglingToolResults: false });
      expect(restored.pendingDelegationDecisionRecovery).toBeUndefined();
      expect(restored.pendingUserQuestion?.delegationDecision).toMatchObject({
        failed: { runId: failed.delegationDecision.failed.runId },
      });
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  test("resumes a persisted Retry decision as exactly one bound extra attempt", async () => {
    const fixture = await delegationFixture();
    const originalProvidersFile = process.env.VESICLE_PROVIDERS_FILE;
    const originalFetch = globalThis.fetch;
    try {
      await configureFixtureProvider(fixture.root);
      const failing = new AgentManager(fixture.store, async () => {
        throw new HarnessAdapterError("transient", "Provider temporarily unavailable.");
      });
      const call = spawnCall("call-resumable-retry", "scene-writer");
      const session = await createSessionStore(fixture.root, "parent");
      await session.append({
        role: "system",
        content: "parent",
        metadata: { engine: "weaver-orch", harness: fixture.invocation.harness?.identity },
      });
      const user = await session.append({ role: "user", content: "delegate" });
      await new FileCheckpointManager(fixture.root, session, user.uuid).createSnapshot();
      await session.append({ role: "assistant", content: "delegating", metadata: { toolCalls: [call] } });
      const messages: VesicleMessage[] = [{ role: "assistant", content: "delegating", toolCalls: [call] }];
      const exhausted = await executeToolRound({
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
        agentManager: failing,
        processManager: getProcessManager(fixture.root),
        permission: defaultPermissionRuntime,
        harness: fixture.invocation.harness,
        assets: fixture.invocation.assets,
        trackCheckpointMutation: async () => undefined,
        markCheckpointTainted: async () => undefined,
      });
      if (!exhausted.delegationPause) throw new Error("expected delegation pause");

      let authorizedRuns = 0;
      const resumedManager = new AgentManager(fixture.store, async ({ spec, invocation }) => {
        authorizedRuns += 1;
        expect(spec.delegation).toMatchObject({
          id: "weaver-orch.scene-writer",
          attempt: 3,
          retryLimit: 1,
        });
        await invocation?.beforeMutation?.(["workspace/authorized-retry.md"]);
        await writeFile(join(fixture.root, "workspace", "authorized-retry.md"), "authorized\n", "utf8");
        return { content: "authorized retry delivered" };
      });
      globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body));
        const retryResult = body.messages.find((message: any) =>
          message.role === "tool" && String(message.content).includes("authorized retry delivered")
        );
        expect(retryResult).toBeDefined();
        return Response.json({ id: "parent-after-retry", choices: [{ message: { content: "retry integrated" } }] });
      }) as typeof fetch;

      await expect(resolveUserQuestion({
        engine: "weaver-orch",
        rootDir: fixture.root,
        sessionId: "parent",
        messages,
        toolCallId: exhausted.delegationPause.toolCallId,
        question: exhausted.delegationPause.question,
        delegationDecision: exhausted.delegationPause.decision,
        answer: {
          selectedIndex: 0,
          optionId: "retry",
          label: "Retry",
          description: "Authorize one more attempt.",
          kind: "model",
        },
        providerSelection: { provider: "test", model: "test-model" },
        harness: { ...fixture.invocation.harness!, packVersion: "10.0.1-drifted" },
        assets: fixture.invocation.assets,
        agentManager: resumedManager,
      })).rejects.toThrow("active Harness no longer matches");
      expect((await loadSessionRecords(fixture.root, "parent")).some((record) =>
        record.metadata?.kind === "delegation-decision-resolution"
      )).toBe(false);

      const resumed = await resolveUserQuestion({
        engine: "weaver-orch",
        rootDir: fixture.root,
        sessionId: "parent",
        messages,
        toolCallId: exhausted.delegationPause.toolCallId,
        question: exhausted.delegationPause.question,
        delegationDecision: exhausted.delegationPause.decision,
        answer: {
          selectedIndex: 0,
          optionId: "retry",
          label: "Retry",
          description: "Authorize one more attempt.",
          kind: "model",
        },
        providerSelection: { provider: "test", model: "test-model" },
        harness: fixture.invocation.harness,
        assets: fixture.invocation.assets,
        agentManager: resumedManager,
      });
      expect(resumed.kind).toBe("complete");
      expect(authorizedRuns).toBe(1);
      const records = await fixture.store.listByParent("parent");
      expect(records.find((record) => record.description === "Delegate scene-writer" && record.delegation?.attempt === 3))
        .toMatchObject({ status: "completed", attempts: [{ attempt: 3, status: "completed" }] });
      const snapshot = await loadSessionSnapshot(fixture.root, "parent", { synthesizeDanglingToolResults: false });
      expect(snapshot.pendingUserQuestion).toBeUndefined();
      expect(snapshot.pendingDelegationRetry).toBeUndefined();
      expect(snapshot.messages.filter((message) => message.role === "tool")).toHaveLength(3);
      const checkpoint = (await loadSessionRecords(fixture.root, "parent"))
        .filter((record) => record.metadata?.kind === "file-history-snapshot")
        .at(-1)?.metadata?.snapshot as any;
      expect(checkpoint.files["workspace/authorized-retry.md"]).toMatchObject({
        backup: null,
        kind: "absent",
      });
    } finally {
      globalThis.fetch = originalFetch;
      if (originalProvidersFile === undefined) delete process.env.VESICLE_PROVIDERS_FILE;
      else process.env.VESICLE_PROVIDERS_FILE = originalProvidersFile;
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  test("persists an authorized retry intent when retry run creation is interrupted", async () => {
    const fixture = await delegationFixture();
    const originalProvidersFile = process.env.VESICLE_PROVIDERS_FILE;
    try {
      await configureFixtureProvider(fixture.root);
      const initialCall = spawnCall("call-interrupted-retry-source", "scene-writer");
      const failed = await executeAgentTool({
        call: initialCall,
        manager: new AgentManager(fixture.store, async () => {
          throw new HarnessAdapterError("transient", "Provider temporarily unavailable.");
        }),
        rootDir: fixture.root,
        parentSessionId: "parent",
        invocation: fixture.invocation,
      });
      if (!failed.delegationDecision) throw new Error("expected delegation decision");
      const session = await createSessionStore(fixture.root, "parent");
      await session.append({
        role: "system",
        content: "parent",
        metadata: { engine: "weaver-orch", harness: fixture.invocation.harness?.identity },
      });
      const messages: VesicleMessage[] = [];
      const pause = await appendHarnessDelegationDecision({
        decision: failed.delegationDecision,
        messages,
        session,
        engine: "weaver-orch",
      });

      const save = fixture.store.save.bind(fixture.store);
      fixture.store.save = async (metadata) => {
        if (metadata.status === "created" && metadata.delegation?.attempt === 3) {
          throw new Error("retry run persistence unavailable");
        }
        await save(metadata);
      };
      await expect(resolveUserQuestion({
        engine: "weaver-orch",
        rootDir: fixture.root,
        sessionId: "parent",
        messages,
        toolCallId: pause.toolCallId,
        question: pause.question,
        delegationDecision: pause.decision,
        answer: {
          selectedIndex: 0,
          optionId: "retry",
          label: "Retry",
          description: "Authorize one more attempt.",
          kind: "model",
        },
        providerSelection: { provider: "test", model: "test-model" },
        harness: fixture.invocation.harness,
        assets: fixture.invocation.assets,
        agentManager: new AgentManager(fixture.store, async () => ({ content: "must not run" })),
      })).rejects.toThrow("retry run persistence unavailable");
      fixture.store.save = save;

      const snapshot = await loadSessionSnapshot(fixture.root, "parent", { synthesizeDanglingToolResults: false });
      expect(snapshot.pendingUserQuestion).toBeUndefined();
      const retryCallId = snapshot.pendingDelegationRetry?.retryCallId;
      expect(snapshot.pendingDelegationRetry).toMatchObject({
        interactionId: "weaver-orch.agent-failure",
        failedRunId: failed.delegationDecision.failed.runId,
        delegationId: "weaver-orch.scene-writer",
        attempt: 3,
        retryCallId,
      });
      expect(retryCallId).toStartWith("delegation-retry_");
      await session.append({
        role: "tool",
        content: JSON.stringify({ ok: false, result: "Recovered interrupted retry." }),
        metadata: {
          kind: "subagent-result",
          name: "spawn_agent",
          ok: false,
          toolCallId: retryCallId,
        },
      });
      expect((await loadSessionSnapshot(fixture.root, "parent", { synthesizeDanglingToolResults: false }))
        .pendingDelegationRetry).toBeUndefined();
    } finally {
      if (originalProvidersFile === undefined) delete process.env.VESICLE_PROVIDERS_FILE;
      else process.env.VESICLE_PROVIDERS_FILE = originalProvidersFile;
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

});
