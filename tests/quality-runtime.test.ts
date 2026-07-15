import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import { resolvePermission, resumeQualityRewrite, runPrompt, type AgentLoopEvent } from "../src/core/agent-loop/run";
import { completeProviderRound } from "../src/core/agent-loop/provider-round";
import { runChildAgent } from "../src/core/agents/child-runner";
import { AgentStore } from "../src/core/agents/store";
import type { AgentRunContext } from "../src/core/agents/types";
import type { HarnessRuntimeContext } from "../src/core/harness";
import { AssetResolver } from "../src/core/runtime/assets";
import { getProcessManager } from "../src/core/process/manager";
import { createSessionStore, listSessions, loadSessionRecords, loadSessionSnapshot } from "../src/core/session/store";
import type { QualityDetectorRule, QualityRuntimeContext } from "../src/core/quality";
import { createSessionResumeController } from "../src/tui/session-resume-controller";

const originalFetch = globalThis.fetch;
const originalProvidersFile = process.env.VESICLE_PROVIDERS_FILE;
const roots: string[] = [];

afterEach(async () => {
  globalThis.fetch = originalFetch;
  if (originalProvidersFile === undefined) delete process.env.VESICLE_PROVIDERS_FILE;
  else process.env.VESICLE_PROVIDERS_FILE = originalProvidersFile;
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("Output Quality Guard runtime", () => {
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
    expect(first.request.qualityState?.candidateParts.join("\n")).toContain("空气中弥漫着");
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
    expect(second.request.qualityState?.candidateParts.join("\n")).toContain("雨水顺着门轴");
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
    expect(first.request.qualityState?.candidateParts.join("\n")).toContain("第一扇窗");
    expect(first.request.qualityState?.candidateParts.join("\n")).toContain("第二种雨味");

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
    expect(second.request.qualityState?.candidateParts.join("\n")).toContain("第一扇窗");
    expect(second.request.qualityState?.candidateParts.join("\n")).toContain("第二种雨味");

    const [summary] = await listSessions(root);
    const paused = await loadSessionSnapshot(root, first.sessionId, { synthesizeDanglingToolResults: false });
    expect(paused.pendingPermission?.toolCallId).toBe(second.request.toolCallId);
    expect(paused.pendingQualityRewrite?.candidateParts.join("\n")).toContain("第一扇窗");
    const restoredPermissions: unknown[] = [];
    const resumeErrors: unknown[] = [];
    const noop = (value: unknown) => value;
    const resumeController = createSessionResumeController({
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

  test("persists an auto-approved mutation before a sibling permission pause", async () => {
    if (process.platform === "win32") return;
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
    expect(interrupted.pendingQualityRewrite?.candidateParts.join("\n")).toContain("混合调用的雨味");

    let resumedRequests = 0;
    globalThis.fetch = (async () => {
      resumedRequests += 1;
      if (resumedRequests === 1) {
        return providerTool("mixed-recovery-gate", "request_confirmation", { gate: "runtime-turn", summary: "Review." });
      }
      return Response.json({ id: "mixed-recovery-clean", choices: [{ message: { content: "雨水敲了三下窗框。" } }] });
    }) as unknown as typeof fetch;
    const resumed = await resumeQualityRewrite({
      engine: "runtime",
      rootDir: root,
      sessionId: summary!.sessionId,
      permission: { mode: "MOMENTUM", shellExecEnabled: true },
      harness: harnessRuntime(),
    });
    expect(resumed.kind).toBe("complete");
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

  test("stops Runtime rewriting when the provider repeats the same candidate hash", async () => {
    const root = await runtimeRoot("runtime", ["runtime-turn"]);
    let requests = 0;
    globalThis.fetch = (async () => {
      requests += 1;
      return Response.json({
        id: `bad-${requests}`,
        choices: [{ finish_reason: "stop", message: { content: "空气中弥漫着雨味。" } }],
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
    expect(requests).toBe(2);
    if (result.kind !== "complete") throw new Error("expected complete");
    expect(result.response.content).toBe("空气中弥漫着雨味。");
    const snapshot = await loadSessionSnapshot(root, result.sessionId);
    expect(snapshot.qualityEvents.map((event) => event.decision)).toEqual(["rewrite", "exhausted"]);
  });

  test("exhausts Runtime delivery after exactly two distinct rewrite attempts", async () => {
    const root = await runtimeRoot("runtime", ["runtime-turn"]);
    let requests = 0;
    globalThis.fetch = (async () => {
      requests += 1;
      return Response.json({
        id: `bad-${requests}`,
        choices: [{ finish_reason: "stop", message: { content: `空气中弥漫着第${requests}版雨味。` } }],
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
    expect(requests).toBe(3);
    const snapshot = await loadSessionSnapshot(root, result.sessionId);
    expect(snapshot.qualityEvents.map((event) => event.decision)).toEqual(["rewrite", "rewrite", "exhausted"]);
  });

  test("resumes a durable Runtime rewrite only under the same Harness identity", async () => {
    const root = await runtimeRoot("runtime", ["runtime-turn"]);
    let requests = 0;
    const controller = new AbortController();
    globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
      requests += 1;
      if (requests === 1) {
        return Response.json({ id: "bad", choices: [{ message: { content: "空气中弥漫着雨味。" } }] });
      }
      if (init?.signal?.aborted) throw init.signal.reason;
      throw new Error("provider continued without expected cancellation");
    }) as unknown as typeof fetch;

    await expect(runPrompt({
      input: "continue",
      engine: "runtime",
      rootDir: root,
      messages: [{ role: "user", content: "continue" }],
      harness: harnessRuntime(),
      signal: controller.signal,
      onEvent: (event) => {
        if (event.type === "quality_status" && event.phase === "rewriting") {
          controller.abort(new DOMException("cancel quality rewrite", "AbortError"));
        }
      },
    })).rejects.toThrow();
    const [summary] = await listSessions(root);
    const interrupted = await loadSessionSnapshot(root, summary!.sessionId, { synthesizeDanglingToolResults: false });
    expect(interrupted.pendingQualityRewrite).toMatchObject({ producer: "runtime", attempts: 1 });

    const resumeErrors: unknown[] = [];
    const harness = harnessRuntime();
    const controllerForResume = createSessionResumeController({
      rootDir: root,
      resolveHarnessRuntime: async () => ({ harness } as any),
      permissionSettingsReady: () => true,
      setRestoringSession: () => undefined,
      reportError: (error: unknown) => resumeErrors.push(error),
    } as any);
    await controllerForResume.resumeSession(summary!);
    expect(String(resumeErrors[0])).toContain("Output Quality Guard continuation pending");

    const manifestDrift = harnessRuntime();
    manifestDrift.manifestSha256 = "e".repeat(64);
    manifestDrift.quality!.manifestSha256 = "e".repeat(64);
    await expect(resumeQualityRewrite({
      engine: "runtime",
      rootDir: root,
      sessionId: summary!.sessionId,
      harness: manifestDrift,
    })).rejects.toThrow("same verified Harness and Rule Pack identity");
    const ruleDrift = harnessRuntime();
    ruleDrift.quality!.ruleManifest.sourceHash = "f".repeat(64);
    await expect(resumeQualityRewrite({
      engine: "runtime",
      rootDir: root,
      sessionId: summary!.sessionId,
      harness: ruleDrift,
    })).rejects.toThrow("same verified Harness and Rule Pack identity");

    globalThis.fetch = (async () => Response.json({
      id: "rewritten",
      choices: [{ message: { content: "雨水顺着门轴滴到她的袖口。" } }],
    })) as unknown as typeof fetch;
    const resumed = await resumeQualityRewrite({
      engine: "runtime",
      rootDir: root,
      sessionId: summary!.sessionId,
      harness: harnessRuntime(),
    });
    expect(resumed.kind).toBe("complete");
    const restored = await loadSessionSnapshot(root, summary!.sessionId);
    expect(restored.pendingQualityRewrite).toBeUndefined();
    expect(restored.qualityEvents.map((event) => event.decision)).toEqual(["rewrite", "pass"]);
  });

  test("restores tool-boundary rewrite attempts before generic failed-tool filtering", async () => {
    const root = await runtimeRoot("runtime", ["runtime-turn"]);
    let requests = 0;
    globalThis.fetch = (async () => {
      requests += 1;
      if (requests === 1) {
        return providerTool("tool-feedback-write", "write_file", {
          path: "workspace/runtime.md",
          content: "空气中弥漫着工具边界的雨味。",
        });
      }
      if (requests === 2) {
        return providerTool("tool-feedback-gate", "request_confirmation", { gate: "runtime-turn", summary: "Review." });
      }
      throw new Error("provider unavailable after tool-boundary feedback");
    }) as unknown as typeof fetch;
    await expect(runPrompt({
      input: "continue",
      engine: "runtime",
      rootDir: root,
      messages: [{ role: "user", content: "continue" }],
      harness: harnessRuntime(),
    })).rejects.toThrow("tool-boundary feedback");
    const [summary] = await listSessions(root);
    const interrupted = await loadSessionSnapshot(root, summary!.sessionId, { synthesizeDanglingToolResults: false });
    expect(interrupted.pendingQualityRewrite).toMatchObject({ attempts: 1, candidateParts: [] });
    expect(interrupted.pendingQualityRewrite?.rejectedHashes).toHaveLength(1);

    globalThis.fetch = (async () => Response.json({
      id: "tool-feedback-clean",
      choices: [{ message: { content: "雨水从檐角落进石槽。" } }],
    })) as unknown as typeof fetch;
    const resumed = await resumeQualityRewrite({
      engine: "runtime",
      rootDir: root,
      sessionId: summary!.sessionId,
      harness: harnessRuntime(),
    });
    expect(resumed.kind).toBe("complete");
    const restored = await loadSessionSnapshot(root, summary!.sessionId);
    expect(restored.qualityEvents.map((event) => event.decision)).toEqual(["rewrite", "pass"]);
  });

  test("reconstructs a pending Runtime candidate when interruption occurs after mutation but before the checkpoint", async () => {
    const root = await runtimeRoot("runtime", ["runtime-turn"]);
    let requests = 0;
    globalThis.fetch = (async () => {
      requests += 1;
      if (requests === 1) {
        return providerTool("write-before-crash", "write_file", {
          path: "workspace/runtime.md",
          content: "### Part 3 — Prose Content\n空气中弥漫着雨味。",
        });
      }
      throw new Error("provider failed before checkpoint");
    }) as unknown as typeof fetch;
    await expect(runPrompt({
      input: "continue",
      engine: "runtime",
      rootDir: root,
      messages: [{ role: "user", content: "continue" }],
      harness: harnessRuntime(),
    })).rejects.toThrow("before checkpoint");
    const [summary] = await listSessions(root);
    const interrupted = await loadSessionSnapshot(root, summary!.sessionId, { synthesizeDanglingToolResults: false });
    expect(interrupted.pendingQualityRewrite).toMatchObject({ producer: "runtime", attempts: 0 });
    expect(interrupted.pendingQualityRewrite?.candidateParts.join("\n")).toContain("空气中弥漫着");

    let resumedRequests = 0;
    globalThis.fetch = (async () => {
      resumedRequests += 1;
      if (resumedRequests === 1) {
        return providerTool("gate-after-crash", "request_confirmation", { gate: "runtime-turn", summary: "Review." });
      }
      return Response.json({ id: "good-after-crash", choices: [{ message: { content: "雨水顺着门轴滴到她的袖口。" } }] });
    }) as unknown as typeof fetch;
    const resumed = await resumeQualityRewrite({
      engine: "runtime",
      rootDir: root,
      sessionId: summary!.sessionId,
      harness: harnessRuntime(),
    });
    expect(resumed.kind).toBe("complete");
    const restored = await loadSessionSnapshot(root, summary!.sessionId);
    expect(restored.pendingQualityRewrite).toBeUndefined();
    expect(restored.qualityEvents.map((event) => event.decision)).toEqual(["rewrite", "pass"]);
  });

  test("persists every declared Engine observe path and excludes Evaluate analyze output", async () => {
    for (const engine of ["dyad", "weaver", "weaver-orch", "evaluate"] as const) {
      const root = await runtimeRoot(engine);
      let requests = 0;
      globalThis.fetch = (async () => {
        requests += 1;
        const content = engine === "dyad"
          ? "### Part 3 — Prose Content\n空气中弥漫着旧纸味。\n\n### Part 4 — HUD\n[State] stable\n\n### Part 3 — Prose Content\n她把旧纸压进抽屉。"
          : "空气中弥漫着旧纸味。";
        return Response.json({ id: engine, choices: [{ message: { content } }] });
      }) as unknown as typeof fetch;
      const result = await runPrompt({
        input: "draft",
        engine,
        rootDir: root,
        messages: [{ role: "user", content: "draft" }],
        harness: harnessRuntime(),
      });
      expect(result.kind).toBe("complete");
      expect(requests).toBe(1);
      const snapshot = await loadSessionSnapshot(root, result.sessionId);
      if (engine === "evaluate") expect(snapshot.qualityEvents).toEqual([]);
      else expect(snapshot.qualityEvents).toEqual([expect.objectContaining({
        producer: engine,
        mode: "observe",
        decision: "observe",
        findingIds: ["zh-f0-air-thick-with"],
      })]);
    }
  });

  test("observes successful artifact prose instead of tool-call planning text", async () => {
    const root = await runtimeRoot("weaver");
    let requests = 0;
    globalThis.fetch = (async () => {
      requests += 1;
      if (requests === 1) {
        const response = await providerTool("weaver-clean-scene", "write_file", {
          path: "workspace/Scene_001.md",
          content: "雨滴沿着窗框滑到她的指节。",
        }).json() as any;
        response.choices[0].message.content = "空气中弥漫着计划中的旧例。";
        return Response.json(response);
      }
      return Response.json({ id: "weaver-done", choices: [{ message: { content: "Scene written." } }] });
    }) as unknown as typeof fetch;
    const result = await runPrompt({
      input: "write",
      engine: "weaver",
      rootDir: root,
      messages: [{ role: "user", content: "write" }],
      harness: harnessRuntime(),
    });
    const snapshot = await loadSessionSnapshot(root, result.sessionId);
    expect(snapshot.qualityEvents).toEqual([expect.objectContaining({ decision: "pass", findingIds: [] })]);
  });

  test("observes Scene Writer before child completion and excludes Chapter Reviewer analyze output", async () => {
    const root = await childRoot();
    let responseContent = "空气中弥漫着旧木头味。";
    globalThis.fetch = (async () => Response.json({ id: "child", choices: [{ message: { content: responseContent } }] })) as unknown as typeof fetch;

    const scene = await runChildAgent(childContext(root, "scene-writer"));
    const sceneRecords = await loadSessionRecords(root, scene.childSessionId!);
    const qualityIndex = sceneRecords.findIndex((record) => record.metadata?.kind === "quality-event");
    expect(qualityIndex).toBeGreaterThan(0);
    expect(sceneRecords[qualityIndex]!.metadata?.qualityEvent).toMatchObject({ producer: "scene-writer", decision: "observe" });

    responseContent = "空气中弥漫着报告里的旧例。";
    const reviewer = await runChildAgent(childContext(root, "chapter-reviewer"));
    const reviewerRecords = await loadSessionRecords(root, reviewer.childSessionId!);
    expect(reviewerRecords.some((record) => record.metadata?.kind === "quality-event")).toBe(false);

    let childRequests = 0;
    globalThis.fetch = (async () => {
      childRequests += 1;
      if (childRequests === 1) {
        const response = await providerTool("child-clean-scene", "write_file", {
          path: "workspace/Scene_002.md",
          content: "她把湿透的袖口卷到肘上。",
        }).json() as any;
        response.choices[0].message.content = "空气中弥漫着计划里的旧例。";
        return Response.json(response);
      }
      return Response.json({ id: "child-done", choices: [{ message: { content: "Scene written." } }] });
    }) as unknown as typeof fetch;
    const artifactScene = await runChildAgent(childContext(root, "scene-writer"));
    const artifactRecords = await loadSessionRecords(root, artifactScene.childSessionId!);
    expect(artifactRecords.find((record) => record.metadata?.kind === "quality-event")?.metadata?.qualityEvent)
      .toMatchObject({ producer: "scene-writer", decision: "pass", findingIds: [] });
  });

  test("buffers streamed prose while rewrite enforcement is active", async () => {
    const root = await baseRoot();
    const session = await createSessionStore(root, "buffered");
    await session.append({ role: "system", content: "system" });
    const events: AgentLoopEvent[] = [];
    const provider = {
      id: "fixture",
      complete: async () => ({ id: "unused", content: "unused" }),
      async *stream() {
        yield { type: "content_delta" as const, delta: "空气中弥漫着" };
        yield { type: "complete" as const, response: { id: "streamed", content: "空气中弥漫着雨味。" } };
      },
    };
    const response = await completeProviderRound({
      rootDir: root,
      provider,
      providerId: "fixture",
      model: "fixture",
      visionEnabled: false,
      systemPrompt: "system",
      tools: [],
      messages: [{ role: "user", content: "continue" }],
      session,
      processManager: getProcessManager(root),
      iteration: 0,
      bufferAssistant: true,
      onEvent: (event) => events.push(event),
    });
    expect(response.content).toContain("空气中弥漫着");
    expect(events.some((event) => event.type === "assistant_delta")).toBe(false);
  });
});

function providerTool(id: string, name: string, args: Record<string, unknown>, usage?: Record<string, number>): Response {
  return Response.json({
    id,
    choices: [{
      finish_reason: "tool_calls",
      message: {
        content: "",
        tool_calls: [{ id: `call-${id}`, type: "function", function: { name, arguments: JSON.stringify(args) } }],
      },
    }],
    ...(usage ? { usage } : {}),
  });
}

function providerTools(id: string, calls: Array<{ id: string; name: string; arguments: string }>): Response {
  return Response.json({
    id,
    choices: [{
      finish_reason: "tool_calls",
      message: {
        content: "",
        tool_calls: calls.map((call) => ({
          id: call.id,
          type: "function",
          function: { name: call.name, arguments: call.arguments },
        })),
      },
    }],
  });
}

async function runtimeRoot(engine: "runtime" | "dyad" | "weaver" | "weaver-orch" | "evaluate", stopGates: string[] = []): Promise<string> {
  const root = await baseRoot();
  await mkdir(join(root, "assets", "prompts", "engines"), { recursive: true });
  await mkdir(join(root, "assets", "engines"), { recursive: true });
  await writeFile(join(root, "assets", "prompts", "engines", `${engine}.md`), engine, "utf8");
  await writeFile(join(root, "assets", "engines", `${engine}.profile.yaml`), [
    `id: ${engine}`,
    `displayName: ${engine}`,
    "protocolVersion: v10",
    "systemPrompt:",
    "  - assets/prompts/shared/vesicle-base.md",
    `  - assets/prompts/engines/${engine}.md`,
    "defaultTools:",
    "  - write_file",
    "  - replace_in_file",
    "validators: []",
    ...(stopGates.length ? ["stopGates:", ...stopGates.map((gate) => `  - ${gate}`)] : ["stopGates: []"]),
    "stateRoots:",
    "  - workspace",
    "",
  ].join("\n"), "utf8");
  return root;
}

async function childRoot(): Promise<string> {
  const root = await baseRoot();
  await mkdir(join(root, "assets", "agents"), { recursive: true });
  await mkdir(join(root, "assets", "prompts", "agents"), { recursive: true });
  for (const profile of ["scene-writer", "chapter-reviewer"]) {
    await writeFile(join(root, "assets", "prompts", "agents", `${profile}.md`), profile, "utf8");
    await writeFile(join(root, "assets", "agents", `${profile}.agent.yaml`), [
      `id: ${profile}`,
      `displayName: ${profile}`,
      `description: ${profile}`,
      "systemPrompt:",
      `  - assets/prompts/agents/${profile}.md`,
      "tools:",
      "  - read_file",
      "contextMode: fresh",
      "modelPolicy: inherit",
      "defaultMode: foreground",
      "maxTurns: 2",
      "",
    ].join("\n"), "utf8");
  }
  return root;
}

async function baseRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "vesicle-quality-runtime-"));
  roots.push(root);
  await mkdir(join(root, "assets", "prompts", "shared"), { recursive: true });
  await mkdir(join(root, "workspace"), { recursive: true });
  await writeFile(join(root, "assets", "prompts", "shared", "vesicle-base.md"), "base", "utf8");
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
  return root;
}

function childContext(root: string, profileId: "scene-writer" | "chapter-reviewer"): AgentRunContext {
  return {
    runId: `run-${profileId}`,
    handle: `${profileId}-1`,
    spec: {
      profileId,
      description: profileId,
      prompt: "write",
      mode: "foreground",
      parentSessionId: "parent",
      parentToolCallId: `call-${profileId}`,
    },
    signal: new AbortController().signal,
    invocation: {
      rootDir: root,
      parentEngine: "weaver-orch",
      providerSelection: { provider: "test", model: "test-model" },
      parentToolDefinitions: [],
      parentSystemPrompt: "parent",
      parentMessages: [],
      assets: new AssetResolver(root),
      harness: harnessRuntime(),
    },
    onProgress: () => undefined,
    takeMessages: () => [],
    claimMutation: async () => undefined,
    registerChildSession: async () => undefined,
  };
}

function harnessRuntime(): HarnessRuntimeContext {
  return {
    packId: "prism-engine-v10",
    packVersion: "10.0.1-alpha.1",
    sourceCommit: "fixture",
    manifestSha256: "a".repeat(64),
    driver: { schema: "prism-driver-contract/v1", id: "fixture", version: "1.0.0", engines: {}, agents: {} },
    adapter: { schema: "prism-host-adapter/v1", id: "fixture", version: "1.0.0", targetHost: "prism-vesicle", operationBindings: {}, interactionBindings: {} },
    quality: qualityRuntime(),
  };
}

function qualityRuntime(): QualityRuntimeContext {
  return {
    packDirectory: "/fixture",
    packId: "prism-engine-v10",
    packVersion: "10.0.1-alpha.1",
    sourceCommit: "fixture",
    manifestSha256: "a".repeat(64),
    ruleManifest: {
      schema: "rule-pack/v1",
      module: "anti-ai-flavor",
      version: "0.2.1",
      primaryLanguage: "zh-CN",
      sourceRepository: "fixture",
      sourceCommit: "fixture",
      sourceState: "clean",
      sourceHash: "b".repeat(64),
      moduleInputHash: "c".repeat(64),
      compilerHash: "d".repeat(64),
      ruleCount: 1,
      projectionCounts: { guidance: 0, detector: 1, judge: 0, replacement: 0 },
      requiredCapabilities: ["quality-guard/anti-ai-flavor@1"],
      preprocessing: {
        line_endings: "LF",
        unicode_normalization: "NFC",
        offset_basis: "normalized-candidate",
        protected_regions: ["markdown-fenced-code", "markdown-blockquote", "html-comment", "prism-hud", "host-provided-ranges"],
      },
      artifacts: {},
    },
    rules: [literalRule()],
    engineModes: { runtime: "rewrite", weaver: "observe", "weaver-orch": "observe", dyad: "observe", evaluate: "analyze", etl: "off" },
    agentModes: { "scene-writer": "observe", "chapter-reviewer": "analyze", "continuity-editor": "off" },
  };
}

function literalRule(): QualityDetectorRule {
  return {
    id: "zh-f0-air-thick-with",
    tier: "F0",
    lang: "zh-CN",
    title: "air thick with",
    severity: "tier1",
    maturity: "stable",
    targets: ["narrative-prose"],
    matcher: { kind: "literal", value: "空气中弥漫着", unit: "candidate" },
    source: "self",
  };
}
