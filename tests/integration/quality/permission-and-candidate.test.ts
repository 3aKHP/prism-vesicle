import { readFile, } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import { resolvePermission, resumeQualityRewrite, runPrompt, type AgentLoopEvent } from "../../../src/core/agent-loop/run";
import { AgentStore } from "../../../src/core/agents/store";
import { getProcessManager } from "../../../src/core/process/manager";
import { listSessions, loadSessionRecords, loadSessionSnapshot } from "../../../src/core/session/store";
import { qualityArtifactTargetFromResult, } from "../../../src/core/quality";
import { createSessionResumeController } from "../../../src/tui/session-resume-controller";
import { harnessRuntime, literalRule, providerTool, providerTools, restoreQualityTestState, runtimeRoot } from "./fixtures/quality-runtime";

afterEach(restoreQualityTestState);

describe("quality: permission and candidate handling", () => {
  test("keeps Weaver-Orch prose-only across a same-response mutation boundary", async () => {
    expect(qualityArtifactTargetFromResult("weaver-orch", {
      callId: "call-orchestrator-write",
      ok: true,
      fileEvent: {
        kind: "file_operation",
        operation: "write",
        path: "workspace/orchestrator.md",
        changed: true,
        bytes: 1,
        sha256: "a".repeat(64),
      },
    })).toBeUndefined();

    const root = await runtimeRoot("weaver-orch", ["orchestrator-check"]);
    globalThis.fetch = (async () => providerTools("orchestrator-write-and-gate", [
      { id: "call-orchestrator-file", name: "write_file", arguments: JSON.stringify({
        path: "workspace/orchestrator.md",
        content: "空气中弥漫着编排说明里的旧例。",
      }) },
      { id: "call-orchestrator-gate", name: "request_confirmation", arguments: JSON.stringify({
        gate: "orchestrator-check",
        summary: "Review orchestration.",
      }) },
    ])) as unknown as typeof fetch;
    const result = await runPrompt({
      input: "orchestrate",
      engine: "weaver-orch",
      rootDir: root,
      messages: [{ role: "user", content: "orchestrate" }],
      harness: harnessRuntime(),
    });
    expect(result.kind).toBe("needs_user");
    const snapshot = await loadSessionSnapshot(root, result.sessionId, { synthesizeDanglingToolResults: false });
    expect(snapshot.qualityEvents).toEqual([expect.objectContaining({ decision: "pass", findingIds: [] })]);
  });

  test("withholds a failing Runtime checkpoint, rewrites through the original Engine, and persists bounded events", async () => {
    const root = await runtimeRoot("runtime", ["runtime-turn"]);
    const requests: any[] = [];
    const events: AgentLoopEvent[] = [];
    globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}"));
      requests.push(body);
      switch (requests.length) {
        case 1:
          return providerTool("write-bad", "write_file", {
            path: "workspace/runtime.md",
            content: "### Part 3 — Prose Content\n空气中弥漫着雨味。",
          });
        case 2:
          return providerTool(
            "gate-bad",
            "request_confirmation",
            { gate: "runtime-turn", summary: "Review the packet." },
            { prompt_tokens: 21, completion_tokens: 8, total_tokens: 29 },
          );
        case 3:
          return providerTool("replace-good", "replace_in_file", {
            path: "workspace/runtime.md",
            oldText: "空气中弥漫着雨味。",
            newText: "雨水顺着门轴滴到她的袖口。",
          });
        default:
          return providerTool("gate-good", "request_confirmation", { gate: "runtime-turn", summary: "Review the rewritten packet." });
      }
    }) as typeof fetch;

    const result = await runPrompt({
      input: "continue",
      engine: "runtime",
      rootDir: root,
      messages: [{ role: "user", content: "continue" }],
      harness: harnessRuntime(),
      onEvent: (event) => events.push(event),
    });

    expect(result.kind).toBe("needs_user");
    expect(requests).toHaveLength(4);
    expect(await readFile(join(root, "workspace", "runtime.md"), "utf8")).toContain("雨水顺着门轴");
    const rewriteFeedback = requests[2].messages.find((message: any) => message.role === "tool" && message.content.includes("quality_rewrite_required"));
    expect(rewriteFeedback.content).toContain("quality_rewrite_required");
    const snapshot = await loadSessionSnapshot(root, result.sessionId, { synthesizeDanglingToolResults: false });
    expect(snapshot.qualityEvents.map((event) => event.decision)).toEqual(["rewrite", "pass"]);
    expect(snapshot.qualityEvents[0]).toMatchObject({
      producer: "runtime",
      candidateType: "runtime.prose",
      findingIds: ["zh-f0-air-thick-with"],
      usage: { inputTokens: 21, outputTokens: 8, totalTokens: 29 },
    });
    expect(snapshot.messages.filter((message) => message.kind === "quality-rejected-candidate")).toHaveLength(1);
    const records = await loadSessionRecords(root, result.sessionId);
    const rejectedIndex = records.findIndex((record) => record.metadata?.kind === "quality-rejected-candidate");
    expect(records[rejectedIndex]).toMatchObject({ role: "assistant", content: "" });
    expect(records[rejectedIndex + 1]).toMatchObject({
      parentUuid: records[rejectedIndex]!.uuid,
      role: "tool",
      metadata: { toolCallId: "call-gate-bad", kind: "quality-rewrite-feedback" },
    });
    expect(events.filter((event) => event.type === "assistant_response")).toHaveLength(3);
    expect(events).toContainEqual(expect.objectContaining({ type: "quality_status", phase: "rewriting" }));
  });

  test("carries the Runtime candidate across every MANUAL permission continuation", async () => {
    const root = await runtimeRoot("runtime", ["runtime-turn"]);
    let requests = 0;
    globalThis.fetch = (async () => {
      requests += 1;
      switch (requests) {
        case 1:
          return providerTool("manual-write-bad", "write_file", {
            path: "workspace/runtime.md",
            content: "### Part 3 — Prose Content\n空气中弥漫着雨味。",
          });
        case 2:
          return providerTool("manual-gate-bad", "request_confirmation", { gate: "runtime-turn", summary: "Review." });
        case 3:
          return providerTool("manual-replace-good", "replace_in_file", {
            path: "workspace/runtime.md",
            oldText: "空气中弥漫着雨味。",
            newText: "雨水顺着门轴滴到她的袖口。",
          });
        default:
          return providerTool("manual-gate-good", "request_confirmation", { gate: "runtime-turn", summary: "Review rewrite." });
      }
    }) as unknown as typeof fetch;
    const harness = harnessRuntime();
    const first = await runPrompt({
      input: "continue",
      engine: "runtime",
      rootDir: root,
      messages: [{ role: "user", content: "continue" }],
      permission: { mode: "MANUAL" },
      harness,
    });
    if (first.kind !== "needs_permission") throw new Error("expected first permission");
    expect(first.request.qualityState).toMatchObject({ candidateParts: [], targets: [] });
    const second = await resolvePermission({
      engine: "runtime",
      rootDir: root,
      sessionId: first.sessionId,
      messages: first.messages,
      request: first.request,
      remainingToolCalls: first.remainingToolCalls,
      resolution: { decision: "allow_once", resolvedAt: new Date().toISOString() },
      permission: { mode: "MANUAL" },
      harness,
    });
    if (second.kind !== "needs_permission") throw new Error("expected rewrite permission");
    expect(second.request.qualityState).toMatchObject({ attempts: 1 });
    expect(second.request.qualityState?.candidateParts).toEqual([]);
    expect(second.request.qualityState?.targets).toEqual([
      expect.objectContaining({ path: "workspace/runtime.md", rejectedHashes: [expect.any(String)] }),
    ]);
    const final = await resolvePermission({
      engine: "runtime",
      rootDir: root,
      sessionId: second.sessionId,
      messages: second.messages,
      request: second.request,
      remainingToolCalls: second.remainingToolCalls,
      resolution: { decision: "allow_once", resolvedAt: new Date().toISOString() },
      permission: { mode: "MANUAL" },
      harness,
    });
    expect(final.kind).toBe("needs_user");
    const snapshot = await loadSessionSnapshot(root, first.sessionId, { synthesizeDanglingToolResults: false });
    expect(snapshot.qualityEvents.map((event) => event.decision)).toEqual(["rewrite", "pass"]);
    const records = await loadSessionRecords(root, first.sessionId);
    const rewritePermissionIndex = records.findIndex((record) => record.metadata?.requestId === second.request.id);
    const pendingIndex = records.findIndex((record, index) => index < rewritePermissionIndex && record.metadata?.kind === "quality-check-pending");
    expect(pendingIndex).toBeGreaterThanOrEqual(0);
  });

  test("removes only rejected mutations while carrying a mixed MANUAL round", async () => {
    const root = await runtimeRoot("runtime", ["runtime-turn"]);
    let requests = 0;
    globalThis.fetch = (async () => {
      requests += 1;
      if (requests === 1) {
        return providerTools("manual-mixed", [
          { id: "call-first-write", name: "write_file", arguments: JSON.stringify({ path: "workspace/first.md", content: "雨滴沿着第一扇窗滑落。" }) },
          { id: "call-second-write", name: "write_file", arguments: JSON.stringify({ path: "workspace/second.md", content: "空气中弥漫着第二种雨味。" }) },
        ]);
      }
      return providerTool("manual-mixed-gate", "request_confirmation", { gate: "runtime-turn", summary: "Review." });
    }) as unknown as typeof fetch;
    const harness = harnessRuntime();
    const first = await runPrompt({
      input: "continue",
      engine: "runtime",
      rootDir: root,
      messages: [{ role: "user", content: "continue" }],
      permission: { mode: "MANUAL" },
      harness,
    });
    if (first.kind !== "needs_permission") throw new Error("expected first permission");
    expect(first.request.qualityState).toMatchObject({ candidateParts: [], targets: [] });

    const second = await resolvePermission({
      engine: "runtime",
      rootDir: root,
      sessionId: first.sessionId,
      messages: first.messages,
      request: first.request,
      remainingToolCalls: first.remainingToolCalls,
      resolution: { decision: "allow_once", resolvedAt: new Date().toISOString() },
      permission: { mode: "MANUAL" },
      harness,
    });
    if (second.kind !== "needs_permission") throw new Error("expected second permission");
    expect(second.request.qualityState?.targets).toEqual([
      expect.objectContaining({ path: "workspace/first.md" }),
    ]);

    const [summary] = await listSessions(root);
    const paused = await loadSessionSnapshot(root, first.sessionId, { synthesizeDanglingToolResults: false });
    expect(paused.pendingPermission?.toolCallId).toBe(second.request.toolCallId);
    expect(paused.pendingQualityRewrite?.targets).toEqual([
      expect.objectContaining({ path: "workspace/first.md" }),
    ]);
    const restoredPermissions: unknown[] = [];
    const resumeErrors: unknown[] = [];
    const noop = (value: unknown) => value;
    const resumeController = createSessionResumeController({
      sessionId: () => summary!.sessionId,
      clearQueuedInputs: () => undefined,
      rootDir: root,
      resolveHarnessRuntime: async () => ({ harness } as any),
      dangerouslySkipPermissions: false,
      permissionSettingsReady: () => true,
      loadPermissionSettings: async () => undefined,
      processManager: getProcessManager(root),
      agentStore: new AgentStore(root),
      agentCards: () => [],
      setAgentCards: noop,
      permissionMode: () => "MANUAL",
      setPermissionMode: noop,
      applyProviderSelection: async (selection: any) => selection,
      setRestoringSession: noop,
      setSessionId: noop,
      setNextSessionParent: noop,
      setSessionPath: noop,
      setActiveEngine: noop,
      setConversation: noop,
      setLastTurnUsage: noop,
      setSessionUsage: noop,
      setOutput: noop,
      setSessionPicker: noop,
      setThinkingTier: noop,
      setReasoningDisplayMode: noop,
      setStatus: noop,
      setMessages: noop,
      setAssetDriftKey: noop,
      refreshArtifacts: async () => undefined,
      reportError: (error: unknown) => resumeErrors.push(error),
      setPendingGate: noop,
      setPendingEngineSwitch: noop,
      setPendingUserQuestion: noop,
      setPendingPermission: (value: unknown) => { restoredPermissions.push(value); return value; },
      setPendingQualityDecision: noop,
      setQualitySelected: noop,
      setQualityWarnings: noop,
      setGateFocus: noop,
      setGateFeedbackMode: noop,
      setGateFeedback: noop,
      setGateFeedbackCursor: noop,
      setGateFeedbackKillBuffer: noop,
      setQuestionSelected: noop,
      setQuestionFreeformText: noop,
      setQuestionFreeformCursor: noop,
      setQuestionFreeformKillBuffer: noop,
    } as any);
    await resumeController.resumeSession(summary!);
    expect(resumeErrors).toEqual([]);
    expect(restoredPermissions.at(-1)).toMatchObject({ request: { toolCallId: second.request.toolCallId } });
    await expect(resumeQualityRewrite({
      engine: "runtime",
      rootDir: root,
      sessionId: first.sessionId,
      harness,
    })).rejects.toThrow("Pending tool permission must be resolved");

    const final = await resolvePermission({
      engine: "runtime",
      rootDir: root,
      sessionId: second.sessionId,
      messages: second.messages,
      request: second.request,
      remainingToolCalls: second.remainingToolCalls,
      resolution: { decision: "reject", resolvedAt: new Date().toISOString() },
      permission: { mode: "MANUAL" },
      harness,
    });
    expect(final.kind).toBe("needs_user");
    expect(await readFile(join(root, "workspace", "first.md"), "utf8")).toContain("第一扇窗");
    await expect(readFile(join(root, "workspace", "second.md"), "utf8")).rejects.toThrow();
    const snapshot = await loadSessionSnapshot(root, first.sessionId, { synthesizeDanglingToolResults: false });
    expect(snapshot.qualityEvents.map((event) => event.decision)).toEqual(["pass"]);
  });

  test("does not inspect or durably resume failed mutation proposals", async () => {
    const gateRoot = await runtimeRoot("runtime", ["runtime-turn"]);
    let gateRequests = 0;
    globalThis.fetch = (async () => {
      gateRequests += 1;
      if (gateRequests === 1) {
        return providerTool("failed-write", "write_file", {
          path: "outside-runtime.md",
          content: "空气中弥漫着并未写入的雨味。",
        });
      }
      return providerTool("after-failed-write", "request_confirmation", { gate: "runtime-turn", summary: "Review." });
    }) as unknown as typeof fetch;
    const gated = await runPrompt({
      input: "continue",
      engine: "runtime",
      rootDir: gateRoot,
      messages: [{ role: "user", content: "continue" }],
      harness: harnessRuntime(),
    });
    expect(gated.kind).toBe("needs_user");
    const gatedSnapshot = await loadSessionSnapshot(gateRoot, gated.sessionId, { synthesizeDanglingToolResults: false });
    expect(gatedSnapshot.qualityEvents.map((event) => event.decision)).toEqual(["pass"]);

    const crashRoot = await runtimeRoot("runtime", ["runtime-turn"]);
    let crashRequests = 0;
    globalThis.fetch = (async () => {
      crashRequests += 1;
      if (crashRequests === 1) {
        return providerTool("failed-write-before-crash", "write_file", {
          path: "outside-runtime.md",
          content: "空气中弥漫着并未落盘的雨味。",
        });
      }
      throw new Error("provider unavailable after failed mutation");
    }) as unknown as typeof fetch;
    await expect(runPrompt({
      input: "continue",
      engine: "runtime",
      rootDir: crashRoot,
      messages: [{ role: "user", content: "continue" }],
      harness: harnessRuntime(),
    })).rejects.toThrow("provider unavailable");
    const [crashedSummary] = await listSessions(crashRoot);
    const crashed = await loadSessionSnapshot(crashRoot, crashedSummary!.sessionId, { synthesizeDanglingToolResults: false });
    expect(crashed.pendingQualityRewrite).toBeUndefined();
  });

  test.skipIf(process.platform === "win32")("persists an auto-approved mutation before a sibling permission pause", async () => {
    const root = await runtimeRoot("runtime", ["runtime-turn"]);
    globalThis.fetch = (async () => providerTools("mixed-auto-and-shell", [
      {
        id: "call-auto-write",
        name: "write_file",
        arguments: JSON.stringify({ path: "workspace/runtime.md", content: "空气中弥漫着混合调用的雨味。" }),
      },
      {
        id: "call-asked-shell",
        name: "shell_exec",
        arguments: JSON.stringify({ command: "printf pending" }),
      },
    ])) as unknown as typeof fetch;
    await expect(runPrompt({
      input: "continue",
      engine: "runtime",
      rootDir: root,
      messages: [{ role: "user", content: "continue" }],
      permission: { mode: "MOMENTUM", shellExecEnabled: true },
      harness: harnessRuntime(),
      onEvent: (event) => {
        if (event.type === "tool_result" && event.callId === "call-auto-write") {
          throw new Error("crash before permission request persistence");
        }
      },
    })).rejects.toThrow("crash before permission");
    const [summary] = await listSessions(root);
    const interrupted = await loadSessionSnapshot(root, summary!.sessionId, { synthesizeDanglingToolResults: false });
    expect(interrupted.pendingPermission).toBeUndefined();
    expect(interrupted.pendingQualityRewrite?.targets).toEqual([
      expect.objectContaining({ path: "workspace/runtime.md" }),
    ]);

    let resumedRequests = 0;
    globalThis.fetch = (async () => {
      resumedRequests += 1;
      if (resumedRequests === 1) {
        return providerTool("mixed-recovery-gate", "request_confirmation", { gate: "runtime-turn", summary: "Review." });
      }
      if (resumedRequests === 2) {
        return providerTool("mixed-recovery-replace", "replace_in_file", {
          path: "workspace/runtime.md",
          oldText: "空气中弥漫着混合调用的雨味。",
          newText: "雨水敲了三下窗框。",
        });
      }
      return providerTool("mixed-recovery-clean-gate", "request_confirmation", { gate: "runtime-turn", summary: "Review rewrite." });
    }) as unknown as typeof fetch;
    const resumed = await resumeQualityRewrite({
      engine: "runtime",
      rootDir: root,
      sessionId: summary!.sessionId,
      permission: { mode: "MOMENTUM", shellExecEnabled: true },
      harness: harnessRuntime(),
    });
    expect(resumed.kind).toBe("needs_user");
    const restored = await loadSessionSnapshot(root, summary!.sessionId);
    expect(restored.qualityEvents.map((event) => event.decision)).toEqual(["rewrite", "pass"]);
  });

  test("keeps a rejected no-tool candidate out of assistant history", async () => {
    const root = await runtimeRoot("runtime");
    let requests = 0;
    globalThis.fetch = (async () => {
      requests += 1;
      return Response.json({
        id: `no-tool-${requests}`,
        choices: [{ message: { content: requests === 1 ? "空气中弥漫着雨味。" : "雨水顺着门轴滴到她的袖口。" } }],
      });
    }) as unknown as typeof fetch;
    const result = await runPrompt({
      input: "continue",
      engine: "runtime",
      rootDir: root,
      messages: [{ role: "user", content: "continue" }],
      harness: harnessRuntime(),
    });
    expect(result.kind).toBe("complete");
    const snapshot = await loadSessionSnapshot(root, result.sessionId, { synthesizeDanglingToolResults: false });
    expect(snapshot.messages.filter((message) => message.role === "assistant").map((message) => message.content)).toEqual([
      "雨水顺着门轴滴到她的袖口。",
    ]);
    expect(snapshot.messages.some((message) => message.role === "user" && message.kind === "quality-rewrite-feedback")).toBe(true);
  });

  test("does not rewrite a malformed Runtime packet from Hidden Chain or HUD text", async () => {
    const root = await runtimeRoot("runtime");
    let requests = 0;
    globalThis.fetch = (async () => {
      requests += 1;
      return Response.json({
        id: "malformed-runtime",
        choices: [{ message: { content: [
          "### Part 1 — Hidden Neural Chain",
          "空气中弥漫着只存在于内部推演的旧例。",
          "### Part 2 — Dynamic HUD",
          "[Scene] 空气中弥漫着状态标签。",
        ].join("\n") } }],
      });
    }) as unknown as typeof fetch;
    const result = await runPrompt({
      input: "continue",
      engine: "runtime",
      rootDir: root,
      messages: [{ role: "user", content: "continue" }],
      harness: harnessRuntime(),
    });
    expect(result.kind).toBe("complete");
    expect(requests).toBe(1);
    const snapshot = await loadSessionSnapshot(root, result.sessionId);
    expect(snapshot.qualityEvents).toEqual([expect.objectContaining({ decision: "pass", findingIds: [] })]);
  });

  test("delivers advisory findings without reporting an unconditional quality pass", async () => {
    const root = await runtimeRoot("runtime");
    const harness = harnessRuntime();
    harness.quality!.rules.push({
      ...literalRule(),
      id: "zh-tier2-advisory",
      title: "advisory phrase",
      severity: "tier2",
      matcher: { kind: "literal", value: "值得一提的是", unit: "candidate" },
    });
    const phases: string[] = [];
    globalThis.fetch = (async () => Response.json({
      id: "advisory",
      choices: [{ message: { content: "值得一提的是，她把雨伞留在门外。" } }],
    })) as unknown as typeof fetch;
    const result = await runPrompt({
      input: "continue",
      engine: "runtime",
      rootDir: root,
      messages: [{ role: "user", content: "continue" }],
      harness,
      onEvent: (event) => {
        if (event.type === "quality_status") phases.push(event.phase);
      },
    });
    expect(result.kind).toBe("complete");
    if (result.kind !== "complete") throw new Error("expected complete");
    expect(result.quality).toEqual({ outcome: "findings", findingCount: 1 });
    expect(phases).toContain("findings");
    const snapshot = await loadSessionSnapshot(root, result.sessionId);
    expect(snapshot.qualityEvents.at(-1)).toMatchObject({
      decision: "pass",
      outcome: "findings",
      action: "deliver",
      targets: [expect.objectContaining({ status: "findings" })],
    });
  });
});
