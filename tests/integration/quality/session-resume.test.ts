
import { afterEach, describe, expect, test } from "bun:test";
import { resumeQualityRewrite, runPrompt, } from "../../../src/core/agent-loop/run";
import { AgentStore } from "../../../src/core/agents/store";
import { getProcessManager } from "../../../src/core/process/manager";
import { createSessionStore, listSessions, loadSessionSnapshot } from "../../../src/core/session/store";
import { createSessionResumeController } from "../../../src/tui/session-resume-controller";
import { harnessRuntime, providerTool, restoreQualityTestState, runtimeRoot } from "./fixtures/quality-runtime";

afterEach(restoreQualityTestState);

describe("quality: session resume", () => {
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
    const restoredQuality: unknown[] = [];
    const noop = (value: unknown) => value;
    const harness = harnessRuntime();
    let harnessLoadError: Error | undefined;
    const controllerForResume = createSessionResumeController({
      sessionId: () => summary!.sessionId,
      clearQueuedInputs: () => undefined,
      rootDir: root,
      resolveHarnessRuntime: async () => {
        if (harnessLoadError) throw harnessLoadError;
        return { harness } as any;
      },
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
      setPendingPermission: noop,
      setPendingQualityDecision: (value: unknown) => { restoredQuality.push(value); return value; },
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
    await controllerForResume.resumeSession(summary!);
    expect(resumeErrors).toEqual([]);
    expect(restoredQuality.at(-1)).toMatchObject({ decision: { reason: "interrupted", canRetry: true } });
    const originalRuleHash = harness.quality!.ruleManifest.sourceHash;
    harness.quality!.ruleManifest.sourceHash = "f".repeat(64);
    await controllerForResume.resumeSession(summary!);
    expect(resumeErrors).toEqual([]);
    expect(restoredQuality.at(-1)).toMatchObject({
      decision: {
        canRetry: false,
        blockedReason: expect.stringContaining("prism-engine-v10@10.0.1-alpha.1"),
      },
    });
    harness.quality!.ruleManifest.sourceHash = originalRuleHash;

    harnessLoadError = new Error("recorded Harness pack is missing");
    await controllerForResume.resumeSession(summary!);
    expect(resumeErrors).toEqual([]);
    expect(restoredQuality.at(-1)).toMatchObject({
      decision: {
        canRetry: false,
        blockedReason: expect.stringContaining("cannot be loaded"),
      },
    });
    harnessLoadError = undefined;

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

  test("resumes an artifact target after cancellation only when the same path is repaired", async () => {
    const root = await runtimeRoot("runtime", ["runtime-turn"]);
    const controller = new AbortController();
    let requests = 0;
    globalThis.fetch = (async () => {
      requests += 1;
      if (requests === 1) {
        return providerTool("cancelled-target-write", "write_file", {
          path: "workspace/runtime.md",
          content: "### Part 3 - Prose Content\n空气中弥漫着雨味。",
        });
      }
      if (requests === 2) {
        return providerTool("cancelled-target-gate", "request_confirmation", { gate: "runtime-turn", summary: "Review." });
      }
      throw controller.signal.reason;
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
          controller.abort(new DOMException("cancel artifact rewrite", "AbortError"));
        }
      },
    })).rejects.toThrow();
    const [summary] = await listSessions(root);
    const interrupted = await loadSessionSnapshot(root, summary!.sessionId, { synthesizeDanglingToolResults: false });
    expect(interrupted.pendingQualityRewrite?.targets).toEqual([
      expect.objectContaining({ path: "workspace/runtime.md", rejectedHashes: [expect.any(String)] }),
    ]);

    let resumedRequests = 0;
    globalThis.fetch = (async () => {
      resumedRequests += 1;
      if (resumedRequests === 1) {
        return providerTool("cancelled-target-replace", "replace_in_file", {
          path: "workspace/runtime.md",
          oldText: "空气中弥漫着雨味。",
          newText: "雨水沿着门框滑落。",
        });
      }
      return providerTool("cancelled-target-clean-gate", "request_confirmation", { gate: "runtime-turn", summary: "Review rewrite." });
    }) as unknown as typeof fetch;
    const resumed = await resumeQualityRewrite({
      engine: "runtime",
      rootDir: root,
      sessionId: summary!.sessionId,
      harness: harnessRuntime(),
    });
    expect(resumed.kind).toBe("needs_user");
    const restored = await loadSessionSnapshot(root, summary!.sessionId);
    expect(restored.qualityEvents.map((event) => event.decision)).toEqual(["rewrite", "pass"]);
  });

  test("resumes legacy candidateParts through the actual Guard", async () => {
    const root = await runtimeRoot("runtime");
    globalThis.fetch = (async () => Response.json({
      id: "legacy-baseline",
      choices: [{ message: { content: "雨水沿着门框滑落。" } }],
    })) as unknown as typeof fetch;
    const initial = await runPrompt({
      input: "continue",
      engine: "runtime",
      rootDir: root,
      messages: [{ role: "user", content: "continue" }],
      harness: harnessRuntime(),
    });
    const session = await createSessionStore(root, initial.sessionId);
    await session.append({
      role: "system",
      content: "",
      metadata: {
        kind: "quality-check-pending",
        qualityRewrite: {
          producer: "runtime",
          packId: "prism-engine-v10",
          packVersion: "10.0.1-alpha.1",
          manifestSha256: "a".repeat(64),
          ruleVersion: "0.2.1",
          ruleSourceHash: "b".repeat(64),
          attempts: 0,
          rejectedHashes: [],
          candidateParts: ["空气中弥漫着旧 session 的雨味。"],
        },
      },
    });

    let resumedRequests = 0;
    globalThis.fetch = (async () => {
      resumedRequests += 1;
      return Response.json({
        id: `legacy-resume-${resumedRequests}`,
        choices: [{ message: { content: "雨水敲了三下窗框。" } }],
      });
    }) as unknown as typeof fetch;
    const resumed = await resumeQualityRewrite({
      engine: "runtime",
      rootDir: root,
      sessionId: initial.sessionId,
      harness: harnessRuntime(),
    });
    expect(resumed.kind).toBe("complete");
    expect(resumedRequests).toBe(2);
    const restored = await loadSessionSnapshot(root, initial.sessionId);
    expect(restored.qualityEvents.map((event) => event.decision).slice(-2)).toEqual(["rewrite", "pass"]);
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
    expect(interrupted.pendingQualityRewrite).toMatchObject({
      attempts: 1,
      candidateParts: [],
      rejectedHashes: [],
      targets: [expect.objectContaining({
        path: "workspace/runtime.md",
        rejectedHashes: [expect.any(String)],
      })],
    });

    let resumedRequests = 0;
    globalThis.fetch = (async () => {
      resumedRequests += 1;
      if (resumedRequests === 1) {
        return providerTool("tool-feedback-replace", "replace_in_file", {
          path: "workspace/runtime.md",
          oldText: "空气中弥漫着工具边界的雨味。",
          newText: "雨水从檐角落进石槽。",
        });
      }
      return providerTool("tool-feedback-clean-gate", "request_confirmation", { gate: "runtime-turn", summary: "Review rewrite." });
    }) as unknown as typeof fetch;
    const resumed = await resumeQualityRewrite({
      engine: "runtime",
      rootDir: root,
      sessionId: summary!.sessionId,
      harness: harnessRuntime(),
    });
    expect(resumed.kind).toBe("needs_user");
    const restored = await loadSessionSnapshot(root, summary!.sessionId);
    expect(restored.qualityEvents.map((event) => event.decision)).toEqual(["rewrite", "pass"]);
  });

  test("reconstructs a pending Runtime target when interruption occurs after mutation but before the checkpoint", async () => {
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
    expect(interrupted.pendingQualityRewrite?.targets).toEqual([
      expect.objectContaining({ path: "workspace/runtime.md" }),
    ]);

    let resumedRequests = 0;
    globalThis.fetch = (async () => {
      resumedRequests += 1;
      if (resumedRequests === 1) {
        return providerTool("replace-after-crash", "replace_in_file", {
          path: "workspace/runtime.md",
          oldText: "空气中弥漫着雨味。",
          newText: "雨水顺着门轴滴到她的袖口。",
        });
      }
      return providerTool("gate-after-crash", "request_confirmation", { gate: "runtime-turn", summary: "Review." });
    }) as unknown as typeof fetch;
    const resumed = await resumeQualityRewrite({
      engine: "runtime",
      rootDir: root,
      sessionId: summary!.sessionId,
      harness: harnessRuntime(),
    });
    expect(resumed.kind).toBe("needs_user");
    const restored = await loadSessionSnapshot(root, summary!.sessionId);
    expect(restored.pendingQualityRewrite).toBeUndefined();
    expect(restored.qualityEvents.map((event) => event.decision)).toEqual(["pass"]);
  });

});
