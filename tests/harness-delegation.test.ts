import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { AgentManager } from "../src/core/agents/manager";
import { AgentStore } from "../src/core/agents/store";
import { executeAgentTool } from "../src/core/agents/tools";
import { agentToolDefinitions } from "../src/core/agents/tools";
import type { AgentInvocationContext } from "../src/core/agents/types";
import {
  bindHarnessDelegation,
  HarnessAdapterError,
  harnessDelegationFailureInteraction,
  parseHarnessDriverContract,
  parseHarnessHostAdapter,
  normalizeHarnessAdapterError,
  validateHarnessDelegationContract,
  type HarnessRuntimeContext,
} from "../src/core/harness";
import { AssetResolver } from "../src/core/runtime/assets";
import { executeToolRound } from "../src/core/agent-loop/tool-round-executor";
import { appendHarnessDelegationDecision } from "../src/core/agent-loop/delegation-decision";
import { planToolRound } from "../src/core/agent-loop/tool-round-planner";
import { defaultPermissionRuntime, ToolPermissionBroker } from "../src/core/permissions";
import { getProcessManager } from "../src/core/process/manager";
import { createSessionStore, listSessions, loadSessionRecords, loadSessionSnapshot } from "../src/core/session/store";
import type { VesicleMessage } from "../src/providers/shared/types";
import { resolvePermission, resolveUserQuestion, runPrompt } from "../src/core/agent-loop/run";
import { ProviderError } from "../src/providers/shared/errors";
import { runChildAgent } from "../src/core/agents/child-runner";
import { FileCheckpointManager } from "../src/core/checkpoints/file-history";

describe("contract-bound Harness delegation", () => {
  test("binds all three Weaver-Orch mappings to their fixed contract", () => {
    const runtime = harnessRuntime();
    expect([
      bindHarnessDelegation(runtime, "weaver-orch", "scene-writer"),
      bindHarnessDelegation(runtime, "weaver-orch", "continuity-editor"),
      bindHarnessDelegation(runtime, "weaver-orch", "chapter-reviewer"),
    ]).toEqual([
      expect.objectContaining({ id: "weaver-orch.scene-writer", mode: "foreground", retryLimit: 1 }),
      expect.objectContaining({ id: "weaver-orch.continuity", mode: "foreground", retryLimit: 1 }),
      expect.objectContaining({ id: "weaver-orch.chapter-review", mode: "foreground", retryLimit: 1 }),
    ]);
  });

  test("rejects undeclared parents, profiles, ambiguity, and mode escalation", () => {
    const runtime = harnessRuntime();
    expect(() => bindHarnessDelegation(runtime, "etl", "scene-writer")).toThrow("does not declare Engine");
    expect(() => bindHarnessDelegation(runtime, "weaver-orch", "missing-agent")).toThrow("does not declare delegation");
    expect(() => bindHarnessDelegation(runtime, "weaver-orch", "scene-writer", "background")).toThrow("fixes mode");

    const ambiguous = harnessRuntime();
    ambiguous.driver.engines["weaver-orch"]!.delegations.push({
      id: "weaver-orch.scene-writer-duplicate",
      agent: "scene-writer",
      mode: "foreground",
      purpose: "Duplicate mapping.",
      retryLimit: 1,
    });
    try {
      bindHarnessDelegation(ambiguous, "weaver-orch", "scene-writer");
      throw new Error("expected ambiguous binding to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(HarnessAdapterError);
      expect((error as HarnessAdapterError).category).toBe("conflict");
    }
  });

  test("normalizes Driver ABI error categories at the Adapter boundary", () => {
    expect(normalizeHarnessAdapterError(new Error("Permission denied by the user.")).category).toBe("denied");
    expect(normalizeHarnessAdapterError(new Error("Asset not found.")).category).toBe("not_found");
    expect(normalizeHarnessAdapterError(new Error("Concurrent write conflict.")).category).toBe("conflict");
    expect(normalizeHarnessAdapterError(new Error("Provider temporarily unavailable.")).category).toBe("transient");
    expect(normalizeHarnessAdapterError(new Error("Unsupported operation.")).category).toBe("unsupported");
    expect(normalizeHarnessAdapterError(new Error("Invalid request.")).category).toBe("invalid_request");
    expect(normalizeHarnessAdapterError(new Error("Child terminated unexpectedly.")).category).toBe("failed");
    expect(normalizeHarnessAdapterError(new ProviderError("Unauthorized provider.", {
      kind: "http_error",
      status: 401,
      retryable: true,
    })).category).toBe("denied");
    expect(normalizeHarnessAdapterError(new ProviderError("Missing credentials for provider.", {
      kind: "missing_credentials",
      retryable: true,
    })).category).toBe("failed");
    expect(normalizeHarnessAdapterError(new ProviderError("Malformed provider response.", {
      kind: "malformed_response",
      retryable: true,
    })).category).toBe("failed");
    expect(normalizeHarnessAdapterError(new ProviderError("Provider network failure.", {
      kind: "network_error",
      retryable: true,
    })).category).toBe("transient");
    for (const status of [408, 429, 500, 503]) {
      expect(normalizeHarnessAdapterError(new ProviderError(`Provider HTTP ${status}.`, {
        kind: "http_error",
        status,
      })).category).toBe("transient");
    }
  });

  test("fails closed on unsupported retry and failure-decision shapes", () => {
    const excessiveRetry = structuredClone(harnessRuntime().driver) as any;
    excessiveRetry.engines["weaver-orch"].delegations[0].retryLimit = 4;
    expect(() => parseHarnessDriverContract(excessiveRetry)).toThrow("host maximum of 3");

    const duplicateInteraction = structuredClone(harnessRuntime().driver) as any;
    duplicateInteraction.engines["weaver-orch"].interactions.push(
      structuredClone(duplicateInteraction.engines["weaver-orch"].interactions[0]),
    );
    expect(() => parseHarnessDriverContract(duplicateInteraction)).toThrow("duplicate interaction id");

    const duplicateOption = structuredClone(harnessRuntime().driver) as any;
    duplicateOption.engines["weaver-orch"].interactions[0].options[1].id = "retry";
    expect(() => parseHarnessDriverContract(duplicateOption)).toThrow("duplicate option ids");

    const missingRetry = harnessRuntime();
    missingRetry.driver.engines["weaver-orch"]!.interactions[0]!.options[0]!.id = "try-again";
    expect(() => validateHarnessDelegationContract(
      missingRetry.driver,
      missingRetry.adapter,
      ["weaver-orch"],
      ["scene-writer", "continuity-editor", "chapter-reviewer"],
    )).toThrow("must declare the retry option");

    const excessiveOptions = harnessRuntime();
    excessiveOptions.driver.engines["weaver-orch"]!.interactions[0]!.options.push(
      { id: "later", label: "Later", description: "Defer the decision." },
      { id: "skip", label: "Skip", description: "Skip the failed step." },
    );
    expect(() => validateHarnessDelegationContract(
      excessiveOptions.driver,
      excessiveOptions.adapter,
      ["weaver-orch"],
      ["scene-writer", "continuity-editor", "chapter-reviewer"],
    )).toThrow("must declare the weaver-orch.agent-failure user decision point");

    const wrongSelectBinding = harnessRuntime();
    wrongSelectBinding.adapter.operationBindings["interaction.select"] = {
      kind: "interaction-tool",
      tool: "request_confirmation",
    };
    expect(() => validateHarnessDelegationContract(
      wrongSelectBinding.driver,
      wrongSelectBinding.adapter,
      ["weaver-orch"],
      ["scene-writer", "continuity-editor", "chapter-reviewer"],
    )).toThrow("interaction.select must bind to ask_user_question");
  });

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
    await session.append({ role: "system", content: "parent" });
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
      await session.append({ role: "system", content: "parent" });
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
      await session.append({ role: "system", content: "parent", metadata: { engine: "weaver-orch" } });
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
      await session.append({ role: "system", content: "parent", metadata: { engine: "weaver-orch" } });
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
      await session.append({ role: "system", content: "parent", metadata: { engine: "weaver-orch" } });
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

  test("keeps released child tools reduced and brokers MANUAL mutation through the parent", async () => {
    const fixture = await delegationFixture();
    const originalProvidersFile = process.env.VESICLE_PROVIDERS_FILE;
    const originalFetch = globalThis.fetch;
    try {
      await configureFixtureProvider(fixture.root);
      const broker = new ToolPermissionBroker();
      const visibleTools: string[][] = [];

      async function runCase(path: string, decision: "allow_once" | "reject") {
        globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
          const body = JSON.parse(String(init?.body));
          visibleTools.push((body.tools ?? []).map((tool: any) => tool.function.name));
          if (!body.messages.some((message: any) => message.role === "tool")) {
            return Response.json({
              id: `child-${decision}-tool`,
              choices: [{ message: {
                content: "",
                tool_calls: [{
                  id: `call-${decision}-write`,
                  type: "function",
                  function: {
                    name: "write_file",
                    arguments: JSON.stringify({ path, content: decision }),
                  },
                }],
              } }],
            });
          }
          return Response.json({ id: `child-${decision}-done`, choices: [{ message: { content: `${decision} handled` } }] });
        }) as typeof fetch;

        const manager = new AgentManager(fixture.store, runChildAgent);
        const execution = executeAgentTool({
          call: spawnCall(`call-${decision}-child`, "scene-writer"),
          manager,
          rootDir: fixture.root,
          parentSessionId: "parent",
          invocation: {
            ...fixture.invocation,
            providerSelection: { provider: "test", model: "test-model" },
            parentToolDefinitions: agentToolDefinitions,
            permission: { mode: "MANUAL" },
            permissionBroker: broker,
          },
        });
        await eventually(() => expect(broker.active()).toMatchObject({
          toolName: "write_file",
          agent: expect.objectContaining({ parentSessionId: "parent" }),
        }));
        const request = broker.active()!;
        expect(broker.resolve(request.id, {
          decision,
          resolvedAt: new Date().toISOString(),
          ...(decision === "reject" ? { feedback: "Do not write this file." } : {}),
        })).toBe(true);
        const result = await execution;
        expect(result.ok).toBe(true);
        const publicResult = JSON.parse(result.content) as { agent_id: string };
        const stored = await fixture.store.resolveReference("parent", publicResult.agent_id);
        const records = await loadSessionRecords(fixture.root, stored!.childSessionId!);
        expect(records.some((record) => record.metadata?.kind === "permission-request")).toBe(true);
        expect(records).toContainEqual(expect.objectContaining({
          metadata: expect.objectContaining({
            kind: "permission-resolution",
            decision,
            decisionSource: "user",
          }),
        }));
      }

      await runCase("workspace/allowed.md", "allow_once");
      expect(await Bun.file(join(fixture.root, "workspace", "allowed.md")).exists()).toBe(true);
      await runCase("workspace/denied.md", "reject");
      expect(await Bun.file(join(fixture.root, "workspace", "denied.md")).exists()).toBe(false);
      for (const tools of visibleTools) {
        expect(tools).toContain("write_file");
        expect(tools).not.toContain("spawn_agent");
        expect(tools).not.toContain("ask_user_question");
        expect(tools).not.toContain("shell_exec");
      }
    } finally {
      globalThis.fetch = originalFetch;
      if (originalProvidersFile === undefined) delete process.env.VESICLE_PROVIDERS_FILE;
      else process.env.VESICLE_PROVIDERS_FILE = originalProvidersFile;
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  test("normalizes a parent MANUAL denial of Harness spawn as ABI denied", async () => {
    const fixture = await delegationFixture();
    const originalProvidersFile = process.env.VESICLE_PROVIDERS_FILE;
    const originalFetch = globalThis.fetch;
    let runnerCalls = 0;
    let providerCalls = 0;
    try {
      await configureFixtureProvider(fixture.root);
      globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
        providerCalls += 1;
        const body = JSON.parse(String(init?.body));
        if (providerCalls === 1) {
          return Response.json({
            id: "parent-manual-delegation",
            choices: [{ message: {
              content: "",
              tool_calls: [{
                id: "call-manual-delegation",
                type: "function",
                function: {
                  name: "spawn_agent",
                  arguments: spawnCall("ignored", "scene-writer").arguments,
                },
              }],
            } }],
          });
        }
        const denied = body.messages.find((message: any) => message.role === "tool");
        const envelope = JSON.parse(String(denied?.content ?? "{}"));
        expect(JSON.parse(envelope.result ?? "{}")).toMatchObject({
          error: { category: "denied", message: expect.stringContaining("Do not delegate") },
        });
        return Response.json({ id: "parent-after-denial", choices: [{ message: { content: "denial handled" } }] });
      }) as typeof fetch;
      const manager = new AgentManager(fixture.store, async () => {
        runnerCalls += 1;
        return { content: "must not run" };
      });
      const paused = await runPrompt({
        input: "delegate",
        engine: "weaver-orch",
        rootDir: fixture.root,
        providerSelection: { provider: "test", model: "test-model" },
        permission: { mode: "MANUAL" },
        harness: fixture.invocation.harness,
        assets: fixture.invocation.assets,
        agentManager: manager,
      });
      if (paused.kind !== "needs_permission") throw new Error("expected permission pause");
      const resumed = await resolvePermission({
        engine: "weaver-orch",
        rootDir: fixture.root,
        sessionId: paused.sessionId,
        messages: paused.messages,
        request: paused.request,
        remainingToolCalls: paused.remainingToolCalls,
        resolution: {
          decision: "reject",
          resolvedAt: new Date().toISOString(),
          feedback: "Do not delegate.",
        },
        providerSelection: { provider: "test", model: "test-model" },
        permission: { mode: "MANUAL" },
        harness: fixture.invocation.harness,
        assets: fixture.invocation.assets,
        agentManager: manager,
      });
      expect(resumed.kind).toBe("complete");
      expect(runnerCalls).toBe(0);
      expect(providerCalls).toBe(2);
    } finally {
      globalThis.fetch = originalFetch;
      if (originalProvidersFile === undefined) delete process.env.VESICLE_PROVIDERS_FILE;
      else process.env.VESICLE_PROVIDERS_FILE = originalProvidersFile;
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  test("crash recovery preserves contract identity and attempt state in the repaired tool result", async () => {
    const fixture = await delegationFixture();
    try {
      const session = await createSessionStore(fixture.root, "parent");
      const call = spawnCall("call-recovered-delegation", "scene-writer");
      await session.append({ role: "system", content: "parent" });
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

async function delegationFixture(): Promise<{
  root: string;
  store: AgentStore;
  invocation: AgentInvocationContext;
}> {
  const root = await mkdtemp(join(tmpdir(), "vesicle-harness-delegation-"));
  await mkdir(join(root, "assets", "agents"), { recursive: true });
  await mkdir(join(root, "assets", "prompts", "agents"), { recursive: true });
  await mkdir(join(root, "assets", "prompts", "shared"), { recursive: true });
  await mkdir(join(root, "assets", "prompts", "engines"), { recursive: true });
  await mkdir(join(root, "assets", "engines"), { recursive: true });
  await writeFile(join(root, "assets", "prompts", "agents", "base.md"), "base", "utf8");
  await writeFile(join(root, "assets", "prompts", "shared", "vesicle-base.md"), "base", "utf8");
  await writeFile(join(root, "assets", "prompts", "engines", "weaver-orch.md"), "weaver orch", "utf8");
  await writeFile(join(root, "assets", "engines", "weaver-orch.profile.yaml"), [
    "id: weaver-orch",
    "displayName: Weaver-Orch",
    "protocolVersion: v10",
    "systemPrompt:",
    "  - assets/prompts/shared/vesicle-base.md",
    "  - assets/prompts/engines/weaver-orch.md",
    "defaultTools:",
    "  - read_file",
    "validators: []",
    "stopGates: []",
    "stateRoots:",
    "  - workspace",
    "  - novels",
    "  - reports",
    "",
  ].join("\n"), "utf8");
  await mkdir(join(root, "workspace"), { recursive: true });
  for (const profile of ["scene-writer", "continuity-editor", "chapter-reviewer"]) {
    await writeFile(join(root, "assets", "prompts", "agents", `${profile}.md`), profile, "utf8");
    await writeFile(join(root, "assets", "agents", `${profile}.agent.yaml`), [
      `id: ${profile}`,
      `displayName: ${profile}`,
      `description: ${profile}`,
      "systemPrompt:",
      "  - assets/prompts/agents/base.md",
      `  - assets/prompts/agents/${profile}.md`,
      "tools:",
      "  - read_file",
      ...(profile === "scene-writer" ? ["  - write_file"] : []),
      "contextMode: fresh",
      "modelPolicy: inherit",
      "defaultMode: foreground",
      "maxTurns: 4",
      "",
    ].join("\n"), "utf8");
  }
  const assets = new AssetResolver(root);
  return {
    root,
    store: new AgentStore(root),
    invocation: {
      rootDir: root,
      parentEngine: "weaver-orch",
      parentToolDefinitions: [],
      parentSystemPrompt: "parent",
      parentMessages: [],
      harness: harnessRuntime(),
      assets,
    },
  };
}

async function configureFixtureProvider(root: string): Promise<void> {
  const config = join(root, "providers.yaml");
  await writeFile(config, [
    "default:",
    "  provider: test",
    "  model: test-model",
    "providers:",
    "  test:",
    "    protocol: openai-chat-compatible",
    "    baseUrl: https://provider.test/v1",
    "    apiKeyEnv: TEST_PROVIDER_KEY",
    "    models:",
    "      - test-model",
    "",
  ].join("\n"), "utf8");
  await writeFile(join(root, ".env"), "TEST_PROVIDER_KEY=test-key\n", "utf8");
  process.env.VESICLE_PROVIDERS_FILE = config;
}

function testConfig() {
  return {
    provider: "openai-chat-compatible" as const,
    providerId: "test",
    baseUrl: "https://provider.test/v1",
    model: "test-model",
  };
}

function emptyMcp() {
  return {
    definitions: [],
    statuses: [],
    hasTool: () => false,
    execute: async () => { throw new Error("unexpected MCP call"); },
  };
}

function weaverOrchProfile() {
  return {
    id: "weaver-orch" as const,
    displayName: "Weaver-Orch",
    protocolVersion: "v10",
    systemPrompt: [],
    defaultTools: [],
    validators: [],
    stopGates: [],
    stateRoots: ["workspace", "novels", "reports"],
    asset: { path: "assets/engines/weaver-orch.profile.yaml", source: "project" as const },
  };
}

function harnessRuntime(): HarnessRuntimeContext {
  return {
    packId: "prism-engine-v10",
    packVersion: "10.0.1-alpha.1",
    sourceCommit: "fixture-source",
    manifestSha256: "a".repeat(64),
    driver: parseHarnessDriverContract({
      schema: "prism-driver-contract/v1",
      id: "prism-engine-v10",
      version: "10.0.1-alpha.1",
      agents: Object.fromEntries(["scene-writer", "continuity-editor", "chapter-reviewer"].map((agent) => [agent, {
        operations: ["artifact.inspect"],
        defaultMode: "foreground",
      }])),
      engines: {
        "weaver-orch": {
          operations: ["agent.delegate", "interaction.select"],
          delegations: [
            { id: "weaver-orch.scene-writer", agent: "scene-writer", mode: "foreground", purpose: "Write one scene.", retryLimit: 1 },
            { id: "weaver-orch.continuity", agent: "continuity-editor", mode: "foreground", purpose: "Synchronize state.", retryLimit: 1 },
            { id: "weaver-orch.chapter-review", agent: "chapter-reviewer", mode: "foreground", purpose: "Review one chapter.", retryLimit: 1 },
          ],
          interactions: [{
            id: "weaver-orch.agent-failure",
            operation: "interaction.select",
            purpose: "Choose how to recover after the declared retry limit is exhausted.",
            options: [
              { id: "retry", label: "Retry", description: "Authorize one more attempt." },
              { id: "manual-repair", label: "Manual repair", description: "Wait for user repairs." },
              { id: "abort", label: "Abort chapter", description: "Stop the current chapter." },
            ],
          }],
        },
      },
    }),
    adapter: parseHarnessHostAdapter({
      schema: "prism-host-adapter/v1",
      id: "vesicle-v1",
      version: "1.0.0",
      targetHost: "Prism Vesicle",
      operationBindings: {
        "agent.delegate": { kind: "interaction-tool", tool: "spawn_agent" },
        "interaction.select": { kind: "interaction-tool", tool: "ask_user_question" },
      },
      interactionBindings: {
        "weaver-orch.agent-failure": { header: "Subtask failure" },
      },
    }),
  };
}

function spawnCall(id: string, profile: string) {
  return {
    id,
    name: "spawn_agent",
    arguments: JSON.stringify({
      profile,
      description: `Delegate ${profile}`,
      prompt: `Complete ${profile} deliverable.`,
      mode: "foreground",
    }),
  };
}

async function eventually(assertion: () => void | Promise<void>): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      await assertion();
      return;
    } catch (error) {
      lastError = error;
      await Bun.sleep(5);
    }
  }
  throw lastError;
}
