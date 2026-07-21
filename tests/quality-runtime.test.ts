import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import { refreshQualityDecisionArtifacts, resolveGate, resolvePermission, resolveQualityDecision, resumeQualityRewrite, runPrompt, type AgentLoopEvent } from "../src/core/agent-loop/run";
import { completeProviderRound } from "../src/core/agent-loop/provider-round";
import { runChildAgent } from "../src/core/agents/child-runner";
import { AgentStore } from "../src/core/agents/store";
import type { AgentRunContext } from "../src/core/agents/types";
import type { HarnessRuntimeContext } from "../src/core/harness";
import { AssetResolver } from "../src/core/runtime/assets";
import { getProcessManager } from "../src/core/process/manager";
import { createSessionStore, listSessions, loadSessionRecords, loadSessionSnapshot } from "../src/core/session/store";
import { qualityArtifactTargetFromResult, readQualityArtifactTargets, type QualityDetectorRule, type QualityJudgeContract, type QualityRuntimeContext } from "../src/core/quality";
import { createSessionResumeController } from "../src/tui/session-resume-controller";
import { createDecisionContinuations } from "../src/tui/decision-continuations";
import { OpenAIChatCompatibleAdapter } from "../src/providers/openai-chat/adapter";
import type { ExperimentalQualityProfile } from "../src/config/quality";

const originalFetch = globalThis.fetch;
const originalProvidersFile = process.env.VESICLE_PROVIDERS_FILE;
const originalQualityFile = process.env.VESICLE_QUALITY_FILE;
const roots: string[] = [];

afterEach(async () => {
  globalThis.fetch = originalFetch;
  if (originalProvidersFile === undefined) delete process.env.VESICLE_PROVIDERS_FILE;
  else process.env.VESICLE_PROVIDERS_FILE = originalProvidersFile;
  if (originalQualityFile === undefined) delete process.env.VESICLE_QUALITY_FILE;
  else process.env.VESICLE_QUALITY_FILE = originalQualityFile;
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("Output Quality Guard runtime", () => {
  test("does not let a clean completion summary pass an unchanged bad artifact", async () => {
    const root = await runtimeRoot("runtime", ["runtime-turn"]);
    let requests = 0;
    globalThis.fetch = (async () => {
      requests += 1;
      if (requests === 1) {
        return providerTool("summary-bypass-write", "write_file", {
          path: "workspace/runtime.md",
          content: "### Part 3 - Prose Content\n空气中弥漫着雨味。",
        });
      }
      if (requests === 2) {
        return providerTool("summary-bypass-gate", "request_confirmation", { gate: "runtime-turn", summary: "Review." });
      }
      return Response.json({ id: "summary-bypass-done", choices: [{ message: { content: "已完成质量修订。" } }] });
    }) as unknown as typeof fetch;

    const result = await runPrompt({
      input: "continue",
      engine: "runtime",
      rootDir: root,
      messages: [{ role: "user", content: "continue" }],
      harness: harnessRuntime(),
    });

    expect(result.kind).toBe("needs_quality_decision");
    expect(requests).toBe(3);
    expect(await readFile(join(root, "workspace", "runtime.md"), "utf8")).toContain("空气中弥漫着");
    const snapshot = await loadSessionSnapshot(root, result.sessionId);
    expect(snapshot.qualityEvents.map((event) => event.decision)).toEqual(["rewrite", "exhausted"]);
  });

  test("checks the complete replace_in_file post-image", async () => {
    const root = await runtimeRoot("runtime", ["runtime-turn"]);
    let requests = 0;
    globalThis.fetch = (async () => {
      requests += 1;
      if (requests === 1) {
        return providerTool("partial-replace-write", "write_file", {
          path: "workspace/runtime.md",
          content: "### Part 3 - Prose Content\n空气中弥漫着雨味。\n空气中弥漫着尘味。",
        });
      }
      if (requests === 2) {
        return providerTool("partial-replace-gate", "request_confirmation", { gate: "runtime-turn", summary: "Review." });
      }
      if (requests === 3) {
        return providerTool("partial-replace-one", "replace_in_file", {
          path: "workspace/runtime.md",
          oldText: "空气中弥漫着雨味。",
          newText: "雨水沿着门框滑落。",
        });
      }
      if (requests === 4) {
        return providerTool("partial-replace-second-gate", "request_confirmation", { gate: "runtime-turn", summary: "Review rewrite." });
      }
      return Response.json({ id: "partial-replace-done", choices: [{ message: { content: "已完成质量修订。" } }] });
    }) as unknown as typeof fetch;

    const result = await runPrompt({
      input: "continue",
      engine: "runtime",
      rootDir: root,
      messages: [{ role: "user", content: "continue" }],
      harness: harnessRuntime(),
    });

    expect(result.kind).toBe("needs_quality_decision");
    expect(requests).toBe(5);
    expect(await readFile(join(root, "workspace", "runtime.md"), "utf8")).toContain("空气中弥漫着尘味");
    const snapshot = await loadSessionSnapshot(root, result.sessionId);
    expect(snapshot.qualityEvents.map((event) => event.decision)).toEqual(["rewrite", "rewrite", "exhausted"]);
  });

  test("checks the complete append_file post-image", async () => {
    const root = await runtimeRoot("runtime", ["runtime-turn"]);
    await writeFile(join(root, "workspace", "runtime.md"), "### Part 3 - Prose Content\n空气中弥漫着旧纸味。\n", "utf8");
    let requests = 0;
    globalThis.fetch = (async () => {
      requests += 1;
      if (requests === 1) {
        return providerTool("clean-append", "append_file", {
          path: "workspace/runtime.md",
          content: "她把窗推开。\n",
        });
      }
      if (requests === 2) {
        return providerTool("clean-append-gate", "request_confirmation", { gate: "runtime-turn", summary: "Review." });
      }
      return Response.json({ id: "clean-append-done", choices: [{ message: { content: "已完成质量修订。" } }] });
    }) as unknown as typeof fetch;

    const result = await runPrompt({
      input: "continue",
      engine: "runtime",
      rootDir: root,
      messages: [{ role: "user", content: "continue" }],
      harness: harnessRuntime(),
    });

    expect(result.kind).toBe("needs_quality_decision");
    expect(requests).toBe(3);
    const snapshot = await loadSessionSnapshot(root, result.sessionId);
    expect(snapshot.qualityEvents.map((event) => event.decision)).toEqual(["rewrite", "exhausted"]);
  });

  test("keeps each artifact target pending until that path is clean", async () => {
    const root = await runtimeRoot("runtime", ["runtime-turn"]);
    let requests = 0;
    globalThis.fetch = (async () => {
      requests += 1;
      if (requests === 1) {
        return providerTools("two-target-write", [
          { id: "call-two-target-clean", name: "write_file", arguments: JSON.stringify({ path: "workspace/clean.md", content: "雨水沿着门框滑落。" }) },
          { id: "call-two-target-bad", name: "write_file", arguments: JSON.stringify({ path: "workspace/bad.md", content: "空气中弥漫着尘味。" }) },
        ]);
      }
      if (requests === 2) {
        return providerTool("two-target-gate", "request_confirmation", { gate: "runtime-turn", summary: "Review." });
      }
      if (requests === 3) {
        return providerTool("two-target-rewrite-clean-only", "write_file", {
          path: "workspace/clean.md",
          content: "她把窗推得更开。",
        });
      }
      if (requests === 4) {
        return providerTool("two-target-second-gate", "request_confirmation", { gate: "runtime-turn", summary: "Review rewrite." });
      }
      return Response.json({ id: "two-target-done", choices: [{ message: { content: "已完成质量修订。" } }] });
    }) as unknown as typeof fetch;

    const result = await runPrompt({
      input: "continue",
      engine: "runtime",
      rootDir: root,
      messages: [{ role: "user", content: "continue" }],
      harness: harnessRuntime(),
    });

    expect(result.kind).toBe("needs_quality_decision");
    expect(requests).toBe(4);
    expect(await readFile(join(root, "workspace", "bad.md"), "utf8")).toContain("空气中弥漫着");
    const snapshot = await loadSessionSnapshot(root, result.sessionId);
    expect(snapshot.qualityEvents.map((event) => event.decision)).toEqual(["rewrite", "exhausted"]);
  });

  test("checks a successful mutation before allowing a same-response gate", async () => {
    const root = await runtimeRoot("runtime", ["runtime-turn"]);
    let requests = 0;
    globalThis.fetch = (async () => {
      requests += 1;
      if (requests === 1) {
        return providerTools("write-and-gate", [
          { id: "call-write-and-gate-file", name: "write_file", arguments: JSON.stringify({
            path: "workspace/runtime.md",
            content: "### Part 3 - Prose Content\n空气中弥漫着雨味。",
          }) },
          { id: "call-write-and-gate-gate", name: "request_confirmation", arguments: JSON.stringify({
            gate: "runtime-turn",
            summary: "Review.",
          }) },
        ]);
      }
      if (requests === 2) {
        return providerTool("write-and-gate-replace", "replace_in_file", {
          path: "workspace/runtime.md",
          oldText: "空气中弥漫着雨味。",
          newText: "雨水沿着门框滑落。",
        });
      }
      return providerTool("write-and-gate-clean", "request_confirmation", { gate: "runtime-turn", summary: "Review rewrite." });
    }) as unknown as typeof fetch;

    const result = await runPrompt({
      input: "continue",
      engine: "runtime",
      rootDir: root,
      messages: [{ role: "user", content: "continue" }],
      harness: harnessRuntime(),
    });

    expect(result.kind).toBe("needs_user");
    expect(requests).toBe(3);
    const snapshot = await loadSessionSnapshot(root, result.sessionId, { synthesizeDanglingToolResults: false });
    expect(snapshot.qualityEvents.map((event) => event.decision)).toEqual(["rewrite", "pass"]);
  });

  test("rereads the current post-image when the file changes after a successful mutation", async () => {
    const root = await runtimeRoot("runtime", ["runtime-turn"]);
    let requests = 0;
    globalThis.fetch = (async () => {
      requests += 1;
      if (requests === 1) {
        return providerTool("external-edit-write", "write_file", {
          path: "workspace/runtime.md",
          content: "### Part 3 - Prose Content\n雨水沿着门框滑落。",
        });
      }
      if (requests === 2) {
        await writeFile(
          join(root, "workspace", "runtime.md"),
          "### Part 3 - Prose Content\n空气中弥漫着外部写入的雨味。",
          "utf8",
        );
        return providerTool("external-edit-gate", "request_confirmation", { gate: "runtime-turn", summary: "Review." });
      }
      return Response.json({ id: "external-edit-done", choices: [{ message: { content: "已完成质量修订。" } }] });
    }) as unknown as typeof fetch;

    const result = await runPrompt({
      input: "continue",
      engine: "runtime",
      rootDir: root,
      messages: [{ role: "user", content: "continue" }],
      harness: harnessRuntime(),
    });

    expect(result.kind).toBe("needs_quality_decision");
    expect(requests).toBe(3);
    const snapshot = await loadSessionSnapshot(root, result.sessionId);
    expect(snapshot.qualityEvents.map((event) => event.decision)).toEqual(["rewrite", "exhausted"]);
  });

  test("delivers an inconclusive warning for an unreadable target and clears it after the same path is clean", async () => {
    const root = await runtimeRoot("runtime", ["runtime-turn"]);
    let requests = 0;
    globalThis.fetch = (async () => {
      requests += 1;
      if (requests === 1) return providerTool("unreadable-write", "write_file", {
        path: "workspace/runtime.md",
        content: "雨水顺着门轴滴到她的袖口。",
      });
      if (requests === 2) {
        await rm(join(root, "workspace", "runtime.md"));
        return providerTool("unreadable-gate", "request_confirmation", { gate: "runtime-turn", summary: "Review." });
      }
      if (requests === 3) return providerTool("unreadable-repair", "write_file", {
        path: "workspace/runtime.md",
        content: "雨水顺着门轴滴到她的袖口。",
      });
      return providerTool("unreadable-repaired-gate", "request_confirmation", { gate: "runtime-turn", summary: "Review repaired file." });
    }) as unknown as typeof fetch;
    const first = await runPrompt({
      input: "continue",
      engine: "runtime",
      rootDir: root,
      messages: [{ role: "user", content: "continue" }],
      harness: harnessRuntime(),
    });
    expect(first.kind).toBe("needs_user");
    if (first.kind !== "needs_user") throw new Error("expected gate");
    const warned = await loadSessionSnapshot(root, first.sessionId, { synthesizeDanglingToolResults: false });
    expect(warned.qualityEvents.at(-1)).toMatchObject({ outcome: "inconclusive", action: "deliver" });
    expect(warned.qualityWarnings).toEqual([
      expect.objectContaining({ reason: "target-unreadable", targets: [expect.objectContaining({ path: "workspace/runtime.md" })] }),
    ]);
    const resumed = await resolveGate({
      engine: "runtime",
      rootDir: root,
      sessionId: first.sessionId,
      messages: first.messages,
      toolCallId: first.toolCallId,
      gate: first.gate,
      resolution: { decision: "confirm" },
      harness: harnessRuntime(),
    });
    expect(resumed.kind).toBe("needs_user");
    const clean = await loadSessionSnapshot(root, first.sessionId, { synthesizeDanglingToolResults: false });
    expect(clean.qualityWarnings).toEqual([]);
  });

  test("records an oversize post-image as inconclusive instead of clean or failed", async () => {
    const root = await runtimeRoot("runtime", ["runtime-turn"]);
    let requests = 0;
    globalThis.fetch = (async () => {
      requests += 1;
      if (requests === 1) return providerTool("oversize-write", "write_file", {
        path: "workspace/runtime.md",
        content: "small",
      });
      await writeFile(join(root, "workspace", "runtime.md"), "x".repeat(1024 * 1024 + 1), "utf8");
      return providerTool("oversize-gate", "request_confirmation", { gate: "runtime-turn", summary: "Review." });
    }) as unknown as typeof fetch;
    const result = await runPrompt({
      input: "continue",
      engine: "runtime",
      rootDir: root,
      messages: [{ role: "user", content: "continue" }],
      harness: harnessRuntime(),
    });
    expect(result.kind).toBe("needs_user");
    const snapshot = await loadSessionSnapshot(root, result.sessionId, { synthesizeDanglingToolResults: false });
    expect(snapshot.qualityEvents.at(-1)).toMatchObject({ outcome: "inconclusive" });
    expect(snapshot.qualityWarnings[0]).toMatchObject({ reason: "target-oversize" });
  });

  test("retains an unreadable target while another target still requires rewrite", async () => {
    const root = await runtimeRoot("runtime", ["runtime-turn"]);
    let requests = 0;
    globalThis.fetch = (async () => {
      requests += 1;
      if (requests === 1) return providerTools("mixed-target-writes", [
        { id: "mixed-a", name: "write_file", arguments: JSON.stringify({ path: "workspace/a.md", content: "空气中弥漫着雨味。" }) },
        { id: "mixed-b", name: "write_file", arguments: JSON.stringify({ path: "workspace/b.md", content: "空气中弥漫着尘味。" }) },
      ]);
      if (requests === 2) {
        await rm(join(root, "workspace", "a.md"));
        return providerTool("mixed-gate", "request_confirmation", { gate: "runtime-turn", summary: "Review." });
      }
      if (requests === 3) return providerTool("mixed-repair", "replace_in_file", {
        path: "workspace/b.md",
        oldText: "空气中弥漫着尘味。",
        newText: "雨水从檐角落进石槽。",
      });
      return providerTool("mixed-clean-gate", "request_confirmation", { gate: "runtime-turn", summary: "Review repaired file." });
    }) as unknown as typeof fetch;

    const result = await runPrompt({
      input: "continue",
      engine: "runtime",
      rootDir: root,
      messages: [{ role: "user", content: "continue" }],
      harness: harnessRuntime(),
    });
    expect(result.kind).toBe("needs_user");
    const snapshot = await loadSessionSnapshot(root, result.sessionId, { synthesizeDanglingToolResults: false });
    expect(snapshot.qualityWarnings).toContainEqual(expect.objectContaining({
      reason: "target-unreadable",
      targets: [expect.objectContaining({ path: "workspace/a.md" })],
    }));
    expect(snapshot.qualityEvents.at(-1)).toMatchObject({ outcome: "inconclusive" });
    expect(snapshot.qualityEvents.at(-1)?.targets).toContainEqual(expect.objectContaining({
      path: "workspace/a.md",
      warningReason: "target-unreadable",
    }));
  });

  test("closes an exhausted decision when retry repairs one target but another is inconclusive", async () => {
    const root = await runtimeRoot("runtime", ["runtime-turn"]);
    let requests = 0;
    globalThis.fetch = (async () => {
      requests += 1;
      if (requests === 1) return providerTools("mixed-retry-writes", [
        { id: "mixed-retry-a", name: "write_file", arguments: JSON.stringify({ path: "workspace/a.md", content: "空气中弥漫着雨味。" }) },
        { id: "mixed-retry-b", name: "write_file", arguments: JSON.stringify({ path: "workspace/b.md", content: "空气中弥漫着尘味。" }) },
      ]);
      if (requests === 2) {
        await rm(join(root, "workspace", "a.md"));
        return providerTool("mixed-retry-gate-2", "request_confirmation", { gate: "runtime-turn", summary: "Review." });
      }
      if (requests === 3) {
        return providerTool(`mixed-retry-gate-${requests}`, "request_confirmation", { gate: "runtime-turn", summary: "Review." });
      }
      if (requests === 4) {
        return providerTool("mixed-retry-repair", "replace_in_file", {
          path: "workspace/b.md",
          oldText: "空气中弥漫着尘味。",
          newText: "雨水从檐角落进石槽。",
        });
      }
      return providerTool("mixed-retry-clean-gate", "request_confirmation", { gate: "runtime-turn", summary: "Review repaired file." });
    }) as unknown as typeof fetch;

    const first = await runPrompt({
      input: "continue",
      engine: "runtime",
      rootDir: root,
      messages: [{ role: "user", content: "continue" }],
      harness: harnessRuntime(),
    });
    expect(first.kind).toBe("needs_quality_decision");
    const exhausted = await loadSessionSnapshot(root, first.sessionId, { synthesizeDanglingToolResults: false });
    expect(exhausted.pendingQualityDecision?.request.targets).toEqual([
      expect.objectContaining({ path: "workspace/b.md" }),
    ]);
    expect(exhausted.qualityWarnings).toEqual([
      expect.objectContaining({ reason: "target-unreadable", targets: [expect.objectContaining({ path: "workspace/a.md" })] }),
      expect.objectContaining({ reason: "exhausted", targets: [expect.objectContaining({ path: "workspace/b.md" })] }),
    ]);
    const retried = await resolveQualityDecision({
      engine: "runtime",
      rootDir: root,
      sessionId: first.sessionId,
      resolution: "retry",
      harness: harnessRuntime(),
    });
    expect(retried.kind).toBe("needs_user");
    const snapshot = await loadSessionSnapshot(root, first.sessionId, { synthesizeDanglingToolResults: false });
    expect(snapshot.pendingQualityDecision).toBeUndefined();
    expect(snapshot.qualityWarnings).toEqual([
      expect.objectContaining({
        reason: "target-unreadable",
        targets: [expect.objectContaining({ path: "workspace/a.md" })],
      }),
    ]);
    expect(snapshot.qualityWarnings.flatMap((warning) => warning.targets).some((target) => target.path === "workspace/b.md")).toBe(false);
  });

  test("resolves an independent warning when retry leaves the decision target blocking", async () => {
    const root = await runtimeRoot("runtime", ["runtime-turn"]);
    let requests = 0;
    globalThis.fetch = (async () => {
      requests += 1;
      if (requests === 1) return providerTools("inverse-mixed-writes", [
        { id: "inverse-a", name: "write_file", arguments: JSON.stringify({ path: "workspace/a.md", content: "空气中弥漫着雨味。" }) },
        { id: "inverse-b", name: "write_file", arguments: JSON.stringify({ path: "workspace/b.md", content: "空气中弥漫着尘味。" }) },
      ]);
      if (requests === 2) {
        await rm(join(root, "workspace", "a.md"));
        return providerTool("inverse-gate-2", "request_confirmation", { gate: "runtime-turn", summary: "Review." });
      }
      if (requests === 3) return providerTool("inverse-gate-3", "request_confirmation", { gate: "runtime-turn", summary: "Review." });
      if (requests === 4) return providerTool("inverse-repair-a", "write_file", {
        path: "workspace/a.md",
        content: "雨水从檐角落进石槽。",
      });
      return providerTool("inverse-gate-5", "request_confirmation", { gate: "runtime-turn", summary: "Review repaired file." });
    }) as unknown as typeof fetch;

    const first = await runPrompt({
      input: "continue",
      engine: "runtime",
      rootDir: root,
      messages: [{ role: "user", content: "continue" }],
      harness: harnessRuntime(),
    });
    expect(first.kind).toBe("needs_quality_decision");
    const retried = await resolveQualityDecision({
      engine: "runtime",
      rootDir: root,
      sessionId: first.sessionId,
      resolution: "retry",
      harness: harnessRuntime(),
    });
    expect(retried.kind).toBe("needs_quality_decision");
    const snapshot = await loadSessionSnapshot(root, first.sessionId, { synthesizeDanglingToolResults: false });
    expect(snapshot.pendingQualityDecision?.request.targets).toEqual([
      expect.objectContaining({ path: "workspace/b.md" }),
    ]);
    expect(snapshot.qualityWarnings).toEqual([
      expect.objectContaining({ reason: "exhausted", targets: [expect.objectContaining({ path: "workspace/b.md" })] }),
    ]);
  });

  test("rereads a historically oversize target after an external edit shrinks it", async () => {
    const root = await runtimeRoot("runtime");
    const path = join(root, "workspace", "runtime.md");
    await writeFile(path, "rain", "utf8");
    const [result] = await readQualityArtifactTargets(root, [{
      id: "artifact:workspace/runtime.md",
      kind: "artifact-post-image",
      candidateType: "runtime.prose",
      path: "workspace/runtime.md",
      operation: "write",
      mutationCallIds: ["oversize-before-edit"],
      postImageHash: "a".repeat(64),
      bytes: 1024 * 1024 + 1,
      rejectedHashes: new Set(),
    }]);
    expect(result?.warningReason).toBeUndefined();
    expect(result?.content).toBe("rain");
    expect(result?.target.bytes).toBe(4);
  });

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
    expect(result.kind).toBe("needs_quality_decision");
    expect(requests).toBe(2);
    if (result.kind !== "needs_quality_decision") throw new Error("expected quality decision");
    expect(result.assistantContent).toBe("空气中弥漫着雨味。");
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
    expect(result.kind).toBe("needs_quality_decision");
    expect(requests).toBe(3);
    const snapshot = await loadSessionSnapshot(root, result.sessionId);
    expect(snapshot.qualityEvents.map((event) => event.decision)).toEqual(["rewrite", "rewrite", "exhausted"]);
  });

  test("persists an exhausted decision and resolves it only after a user-authorized clean retry", async () => {
    const root = await runtimeRoot("runtime");
    let requests = 0;
    globalThis.fetch = (async () => {
      requests += 1;
      return Response.json({
        id: `quality-decision-${requests}`,
        choices: [{ message: { content: requests < 3 ? "空气中弥漫着雨味。" : "雨水顺着门轴滴到她的袖口。" } }],
      });
    }) as unknown as typeof fetch;
    const first = await runPrompt({
      input: "continue",
      engine: "runtime",
      rootDir: root,
      messages: [{ role: "user", content: "continue" }],
      harness: harnessRuntime(),
    });
    expect(first.kind).toBe("needs_quality_decision");
    if (first.kind !== "needs_quality_decision") throw new Error("expected quality decision");
    const pending = await loadSessionSnapshot(root, first.sessionId, { synthesizeDanglingToolResults: false });
    expect(pending.pendingQualityDecision?.request).toMatchObject({ reason: "exhausted", canRetry: true });
    expect(pending.qualityWarnings).toHaveLength(1);
    expect(pending.qualityEvents.at(-1)).toMatchObject({
      outcome: "exhausted",
      action: "ask-user",
      policyVersion: "quality-policy/v1",
      targets: [expect.objectContaining({ status: "warning", findings: [expect.objectContaining({ source: "detector" })] })],
    });
    const [summary] = await listSessions(root);
    expect(summary?.pendingQuality).toMatchObject({ state: "decision", producer: "runtime", findingCount: 1 });

    const retried = await resolveQualityDecision({
      engine: "runtime",
      rootDir: root,
      sessionId: first.sessionId,
      resolution: "retry",
      harness: harnessRuntime(),
    });
    expect(retried.kind).toBe("complete");
    expect(requests).toBe(3);
    const resolved = await loadSessionSnapshot(root, first.sessionId, { synthesizeDanglingToolResults: false });
    expect(resolved.pendingQualityDecision).toBeUndefined();
    expect(resolved.pendingQualityRewrite).toBeUndefined();
    expect(resolved.qualityWarnings).toEqual([]);
    expect(resolved.records).toContainEqual(expect.objectContaining({
      metadata: expect.objectContaining({
        kind: "quality-resolution",
        qualityResolution: expect.objectContaining({ resolution: "revised-clean" }),
      }),
    }));
  });

  test("accepts or stops an exhausted response locally while retaining its warning", async () => {
    for (const resolution of ["accept", "stop"] as const) {
      const root = await runtimeRoot("runtime");
      let requests = 0;
      globalThis.fetch = (async () => {
        requests += 1;
        return Response.json({
          id: `${resolution}-${requests}`,
          choices: [{ message: { content: `空气中弥漫着${resolution}雨味。` } }],
        });
      }) as unknown as typeof fetch;
      const first = await runPrompt({
        input: "continue",
        engine: "runtime",
        rootDir: root,
        messages: [{ role: "user", content: "continue" }],
        harness: harnessRuntime(),
      });
      expect(first.kind).toBe("needs_quality_decision");
      const beforeResolution = requests;
      const settled = await resolveQualityDecision({
        engine: "runtime",
        rootDir: root,
        sessionId: first.sessionId,
        resolution,
      });
      expect(settled).toEqual({ kind: "quality_resolved", sessionId: first.sessionId, resolution });
      expect(requests).toBe(beforeResolution);
      const snapshot = await loadSessionSnapshot(root, first.sessionId, { synthesizeDanglingToolResults: false });
      expect(snapshot.pendingQualityDecision).toBeUndefined();
      expect(snapshot.qualityWarnings).toEqual([
        expect.objectContaining({
          targets: [expect.objectContaining({ resolution: resolution === "accept" ? "accepted-by-user" : "stopped-by-user" })],
        }),
      ]);
      const delivered = snapshot.messages.filter((message) => message.role === "assistant" && message.kind !== "quality-rejected-candidate");
      expect(delivered.some((message) => message.content.includes(`${resolution}雨味`))).toBe(resolution === "accept");
    }
  });

  test("keeps quality choice ahead of a gate and restores the gate after explicit acceptance", async () => {
    const root = await runtimeRoot("runtime", ["runtime-turn"]);
    let requests = 0;
    globalThis.fetch = (async () => {
      requests += 1;
      if (requests === 1) return providerTool("quality-gate-write", "write_file", {
        path: "workspace/runtime.md",
        content: "### Part 3 - Prose Content\n空气中弥漫着雨味。",
      });
      return providerTool(`quality-gate-${requests}`, "request_confirmation", { gate: "runtime-turn", summary: "Review." });
    }) as unknown as typeof fetch;
    const first = await runPrompt({
      input: "continue",
      engine: "runtime",
      rootDir: root,
      messages: [{ role: "user", content: "continue" }],
      harness: harnessRuntime(),
    });
    expect(first.kind).toBe("needs_quality_decision");
    const settled = await resolveQualityDecision({
      engine: "runtime",
      rootDir: root,
      sessionId: first.sessionId,
      resolution: "accept",
    });
    expect(settled.kind).toBe("quality_resolved");
    expect(requests).toBe(3);
    const snapshot = await loadSessionSnapshot(root, first.sessionId, { synthesizeDanglingToolResults: false });
    expect(snapshot.pendingQualityDecision).toBeUndefined();
    expect(snapshot.pendingGate?.gate.gate).toBe("runtime-turn");
    expect(snapshot.qualityWarnings[0]?.targets[0]).toMatchObject({
      path: "workspace/runtime.md",
      resolution: "accepted-by-user",
    });
  });

  test("rechecks an externally edited artifact before settling its old quality decision", async () => {
    const root = await runtimeRoot("runtime", ["runtime-turn"]);
    let requests = 0;
    globalThis.fetch = (async () => {
      requests += 1;
      if (requests === 1) return providerTool("decision-edit-write", "write_file", {
        path: "workspace/runtime.md",
        content: "空气中弥漫着雨味。",
      });
      return providerTool(`decision-edit-gate-${requests}`, "request_confirmation", { gate: "runtime-turn", summary: "Review." });
    }) as unknown as typeof fetch;
    const first = await runPrompt({
      input: "continue",
      engine: "runtime",
      rootDir: root,
      messages: [{ role: "user", content: "continue" }],
      harness: harnessRuntime(),
    });
    expect(first.kind).toBe("needs_quality_decision");
    await writeFile(join(root, "workspace", "runtime.md"), "雨水沿着门框滑落。", "utf8");

    const settled = await resolveQualityDecision({
      engine: "runtime",
      rootDir: root,
      sessionId: first.sessionId,
      resolution: "accept",
      harness: harnessRuntime(),
    });
    expect(settled).toEqual({ kind: "quality_resolved", sessionId: first.sessionId, resolution: "accept" });
    expect(requests).toBe(3);
    const snapshot = await loadSessionSnapshot(root, first.sessionId, { synthesizeDanglingToolResults: false });
    expect(snapshot.pendingQualityDecision).toBeUndefined();
    expect(snapshot.qualityWarnings).toEqual([]);
    expect(snapshot.qualityEvents.at(-1)).toMatchObject({ outcome: "clean", action: "deliver" });
    expect(snapshot.records.some((record) =>
      (record.metadata?.qualityResolution as { resolution?: unknown } | undefined)?.resolution === "accepted-by-user"
    )).toBe(false);
  });

  test("updates an old decision to inconclusive when its artifact becomes unreadable", async () => {
    const root = await runtimeRoot("runtime", ["runtime-turn"]);
    let requests = 0;
    globalThis.fetch = (async () => {
      requests += 1;
      if (requests === 1) return providerTool("decision-unreadable-write", "write_file", {
        path: "workspace/runtime.md",
        content: "空气中弥漫着雨味。",
      });
      return providerTool(`decision-unreadable-gate-${requests}`, "request_confirmation", { gate: "runtime-turn", summary: "Review." });
    }) as unknown as typeof fetch;
    const first = await runPrompt({
      input: "continue",
      engine: "runtime",
      rootDir: root,
      messages: [{ role: "user", content: "continue" }],
      harness: harnessRuntime(),
    });
    expect(first.kind).toBe("needs_quality_decision");
    await rm(join(root, "workspace", "runtime.md"));

    await resolveQualityDecision({
      engine: "runtime",
      rootDir: root,
      sessionId: first.sessionId,
      resolution: "accept",
      harness: harnessRuntime(),
    });
    const snapshot = await loadSessionSnapshot(root, first.sessionId, { synthesizeDanglingToolResults: false });
    expect(snapshot.pendingQualityDecision).toBeUndefined();
    expect(snapshot.qualityWarnings).toEqual([
      expect.objectContaining({ reason: "target-unreadable", targets: [expect.objectContaining({ path: "workspace/runtime.md" })] }),
    ]);
    expect(snapshot.records.some((record) =>
      (record.metadata?.qualityResolution as { resolution?: unknown } | undefined)?.resolution === "revised-clean"
    )).toBe(false);
  });

  test("does not append external-refresh records while an unreadable target is unchanged", async () => {
    const root = await runtimeRoot("runtime", ["runtime-turn"]);
    const sessionId = await createMixedExhaustedSession(root, "unchanged-unreadable");
    const before = await loadSessionSnapshot(root, sessionId, { synthesizeDanglingToolResults: false });

    const after = await refreshQualityDecisionArtifacts(root, sessionId, harnessRuntime().quality!);
    expect(after.records).toHaveLength(before.records.length);
    expect(after.pendingQualityDecision?.request.targets).toEqual([
      expect.objectContaining({ path: "workspace/b.md" }),
    ]);
  });

  test("rechecks an unreadable target restored with its previous blocking hash", async () => {
    const root = await runtimeRoot("runtime", ["runtime-turn"]);
    const sessionId = await createMixedExhaustedSession(root, "restored-same-hash");
    await writeFile(join(root, "workspace", "a.md"), "空气中弥漫着雨味。", "utf8");

    const refreshed = await refreshQualityDecisionArtifacts(root, sessionId, harnessRuntime().quality!);
    expect(refreshed.pendingQualityDecision?.request.targets).toEqual([
      expect.objectContaining({ path: "workspace/a.md" }),
      expect.objectContaining({ path: "workspace/b.md" }),
    ]);
    expect(refreshed.qualityWarnings).toEqual([
      expect.objectContaining({
        reason: "exhausted",
        targets: [
          expect.objectContaining({ path: "workspace/a.md" }),
          expect.objectContaining({ path: "workspace/b.md" }),
        ],
      }),
    ]);
  });

  test("durably closes every unanswered interaction call when a quality decision stops", async () => {
    const root = await runtimeRoot("runtime", ["runtime-turn"]);
    let requests = 0;
    globalThis.fetch = (async () => {
      requests += 1;
      if (requests === 1) return providerTool("multi-interaction-write", "write_file", {
        path: "workspace/runtime.md",
        content: "空气中弥漫着雨味。",
      });
      return providerTools(`multi-interaction-${requests}`, [
        { id: `multi-gate-${requests}`, name: "request_confirmation", arguments: JSON.stringify({ gate: "runtime-turn", summary: "Review." }) },
        { id: `multi-question-${requests}`, name: "ask_user_question", arguments: JSON.stringify({ header: "Choose", question: "Continue?", options: [{ label: "Yes", description: "Continue." }, { label: "No", description: "Stop." }] }) },
      ]);
    }) as unknown as typeof fetch;
    const first = await runPrompt({
      input: "continue",
      engine: "runtime",
      rootDir: root,
      messages: [{ role: "user", content: "continue" }],
      harness: harnessRuntime(),
    });
    expect(first.kind).toBe("needs_quality_decision");
    if (first.kind !== "needs_quality_decision") throw new Error("expected quality decision");
    const pending = await loadSessionSnapshot(root, first.sessionId, { synthesizeDanglingToolResults: false });
    const callIds = pending.pendingQualityDecision?.candidate.toolCalls.map((call) => call.id) ?? [];
    expect(callIds).toHaveLength(2);
    await resolveQualityDecision({
      engine: "runtime",
      rootDir: root,
      sessionId: first.sessionId,
      resolution: "stop",
    });
    const snapshot = await loadSessionSnapshot(root, first.sessionId, { synthesizeDanglingToolResults: false });
    const durableResults = new Set(snapshot.records.flatMap((record) =>
      record.role === "tool" && typeof record.metadata?.toolCallId === "string"
        ? [record.metadata.toolCallId]
        : []
    ));
    for (const callId of callIds) expect(durableResults.has(callId)).toBe(true);
    expect(snapshot.pendingGate).toBeUndefined();
    expect(snapshot.pendingUserQuestion).toBeUndefined();
  });

  test("retains the same quality decision after retry provider failure", async () => {
    const root = await runtimeRoot("runtime");
    let requests = 0;
    globalThis.fetch = (async () => {
      requests += 1;
      if (requests <= 2) return Response.json({
        id: `retry-failure-${requests}`,
        choices: [{ message: { content: "空气中弥漫着雨味。" } }],
      });
      throw new Error("retry provider unavailable");
    }) as unknown as typeof fetch;
    const first = await runPrompt({
      input: "continue",
      engine: "runtime",
      rootDir: root,
      messages: [{ role: "user", content: "continue" }],
      harness: harnessRuntime(),
    });
    expect(first.kind).toBe("needs_quality_decision");
    const warningId = first.kind === "needs_quality_decision" ? first.decision.id : "";
    await expect(resolveQualityDecision({
      engine: "runtime",
      rootDir: root,
      sessionId: first.sessionId,
      resolution: "retry",
      harness: harnessRuntime(),
    })).rejects.toThrow("retry provider unavailable");
    const snapshot = await loadSessionSnapshot(root, first.sessionId, { synthesizeDanglingToolResults: false });
    expect(snapshot.pendingQualityDecision?.request.id).toBe(warningId);
    expect(snapshot.qualityWarnings).toHaveLength(1);
  });

  test("lets the user end an interrupted automatic rewrite without another provider request", async () => {
    const root = await runtimeRoot("runtime");
    let requests = 0;
    const controller = new AbortController();
    globalThis.fetch = (async () => {
      requests += 1;
      return Response.json({ id: "interrupted-quality", choices: [{ message: { content: "空气中弥漫着雨味。" } }] });
    }) as unknown as typeof fetch;
    await expect(runPrompt({
      input: "continue",
      engine: "runtime",
      rootDir: root,
      messages: [{ role: "user", content: "continue" }],
      harness: harnessRuntime(),
      signal: controller.signal,
      onEvent: (event) => {
        if (event.type === "quality_status" && event.phase === "rewriting") controller.abort();
      },
    })).rejects.toThrow();
    const [summary] = await listSessions(root);
    const beforeResolution = requests;
    const settled = await resolveQualityDecision({
      engine: "runtime",
      rootDir: root,
      sessionId: summary!.sessionId,
      resolution: "stop",
    });
    expect(settled.kind).toBe("quality_resolved");
    expect(requests).toBe(beforeResolution);
    const snapshot = await loadSessionSnapshot(root, summary!.sessionId, { synthesizeDanglingToolResults: false });
    expect(snapshot.pendingQualityRewrite).toBeUndefined();
    expect(snapshot.qualityWarnings[0]).toMatchObject({
      reason: "user-abandoned",
      targets: [expect.objectContaining({ resolution: "stopped-by-user" })],
    });
  });

  test("drops a persisted artifact target without mutation provenance", async () => {
    const root = await runtimeRoot("runtime");
    globalThis.fetch = (async () => Response.json({
      id: "invalid-target-base",
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
          packVersion: "10.1.0-rc.1",
          manifestSha256: "a".repeat(64),
          ruleVersion: "0.2.1",
          ruleSourceHash: "b".repeat(64),
          attempts: 1,
          rejectedHashes: [],
          candidateParts: [],
          targets: [{
            id: "artifact:workspace/runtime.md",
            kind: "artifact-post-image",
            candidateType: "runtime.prose",
            path: "workspace/runtime.md",
            operation: "write",
            mutationCallIds: [],
            postImageHash: "c".repeat(64),
            bytes: 8,
            rejectedHashes: [],
          }],
        },
      },
    });

    const snapshot = await loadSessionSnapshot(root, initial.sessionId, { synthesizeDanglingToolResults: false });
    expect(snapshot.pendingQualityRewrite?.targets).toEqual([]);
  });

  test("closes an unanswered gate when an interrupted rewrite is stopped", async () => {
    const root = await runtimeRoot("runtime", ["runtime-turn"]);
    globalThis.fetch = (async () => Response.json({
      id: "interrupted-gate-base",
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
    const call = {
      id: "interrupted-pending-gate",
      name: "request_confirmation",
      arguments: JSON.stringify({ gate: "runtime-turn", summary: "Review interrupted work." }),
    };
    const candidate = { responseId: "interrupted-pending-response", content: "", toolCalls: [call] };
    await session.appendMany([
      { role: "assistant", content: "", metadata: { providerResponseId: candidate.responseId, toolCalls: [call] } },
      {
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
            attempts: 1,
            rejectedHashes: [],
            candidateParts: [],
            targets: [{
              id: "artifact:workspace/runtime.md",
              kind: "artifact-post-image",
              candidateType: "runtime.prose",
              path: "workspace/runtime.md",
              operation: "write",
              mutationCallIds: ["interrupted-write"],
              postImageHash: "c".repeat(64),
              bytes: 8,
              rejectedHashes: ["c".repeat(64)],
            }],
            candidate,
          },
        },
      },
    ]);
    const before = await loadSessionSnapshot(root, initial.sessionId, { synthesizeDanglingToolResults: false });
    expect(before.pendingQualityRewrite).toBeDefined();
    expect(before.pendingGate?.toolCallId).toBe(call.id);

    await resolveQualityDecision({
      engine: "runtime",
      rootDir: root,
      sessionId: initial.sessionId,
      resolution: "stop",
    });
    const after = await loadSessionSnapshot(root, initial.sessionId, { synthesizeDanglingToolResults: false });
    expect(after.pendingQualityRewrite).toBeUndefined();
    expect(after.pendingGate).toBeUndefined();
    expect(after.records).toContainEqual(expect.objectContaining({
      role: "tool",
      metadata: expect.objectContaining({
        kind: "quality-decision-stopped-tool",
        toolCallId: call.id,
      }),
    }));
  });

  test("routes retry, accept, and stop through the real TUI decision continuation", async () => {
    for (const resolution of ["retry", "accept", "stop"] as const) {
      const root = await runtimeRoot("runtime");
      let requests = 0;
      globalThis.fetch = (async () => {
        requests += 1;
        return Response.json({
          id: `tui-${resolution}-${requests}`,
          choices: [{ message: { content: requests < 3 ? "空气中弥漫着雨味。" : "雨水顺着门轴滴到她的袖口。" } }],
        });
      }) as unknown as typeof fetch;
      const result = await runPrompt({
        input: "continue",
        engine: "runtime",
        rootDir: root,
        messages: [{ role: "user", content: "continue" }],
        harness: harnessRuntime(),
      });
      if (result.kind !== "needs_quality_decision") throw new Error("expected quality decision");
      const pending = { ...result, engine: "runtime" as const };
      const handled: unknown[] = [];
      const resumed: string[] = [];
      const pendingUpdates: unknown[] = [];
      const before = requests;
      const continuations = createDecisionContinuations({
        rootDir: root,
        busy: () => false,
        queuedSendAfterInterrupt: () => false,
        pendingQualityDecision: () => pending,
        setPendingQualityDecision: (value: unknown) => { pendingUpdates.push(value); return value; },
        setQualitySelected: (value: number) => value,
        setBusy: (value: boolean) => value,
        setQueuedInputReady: (value: boolean) => value,
        setStatus: (value: string) => value,
        recordActivity: () => undefined,
        setMessages: (value: unknown) => value,
        beginUsageTurn: () => undefined,
        activeProviderSelection: () => ({ provider: "test", model: "test-model" }),
        activeGeneration: () => undefined,
        permissionContext: () => ({ mode: "MANUAL", shellExecEnabled: false, shellInterpreter: "auto" }),
        handleAgentEvent: () => undefined,
        agentManager: () => undefined as any,
        permissionBroker: undefined as any,
        runCancellable: async (operation: (signal: AbortSignal) => Promise<unknown>) => ({
          kind: "complete" as const,
          value: await operation(new AbortController().signal),
        }),
        handleResult: (value: unknown) => { handled.push(value); },
        handleInterruptedTurn: () => undefined,
        refreshQualityWarnings: async () => undefined,
        resumeQualitySession: async (sessionId: string) => { resumed.push(sessionId); },
        resolveQualityDecision: (options: any) => resolveQualityDecision({ ...options, harness: harnessRuntime() }),
        reportError: (error: unknown) => { throw error; },
      } as any);
      await continuations.submitQualityDecision(resolution);
      expect(pendingUpdates[0]).toBeNull();
      if (resolution === "retry") {
        expect(requests).toBe(before + 1);
        expect(handled.at(-1)).toMatchObject({ kind: "complete" });
      } else {
        expect(requests).toBe(before);
        expect(resumed).toEqual([result.sessionId]);
      }
    }
  });

  test("restores the TUI quality panel after retry cancellation or provider failure", async () => {
    for (const failure of ["cancel", "provider"] as const) {
      const root = await runtimeRoot("runtime");
      let requests = 0;
      globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
        requests += 1;
        if (requests <= 2) return Response.json({
          id: `tui-${failure}-${requests}`,
          choices: [{ message: { content: "空气中弥漫着雨味。" } }],
        });
        if (failure === "provider") throw new Error("quality retry provider failure");
        return await new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
        });
      }) as unknown as typeof fetch;
      const result = await runPrompt({
        input: "continue",
        engine: "runtime",
        rootDir: root,
        messages: [{ role: "user", content: "continue" }],
        harness: harnessRuntime(),
      });
      if (result.kind !== "needs_quality_decision") throw new Error("expected quality decision");
      const pending = { ...result, engine: "runtime" as const };
      const pendingUpdates: unknown[] = [];
      const errors: unknown[] = [];
      const controller = new AbortController();
      const continuations = createDecisionContinuations({
        rootDir: root,
        busy: () => false,
        queuedSendAfterInterrupt: () => false,
        pendingQualityDecision: () => pending,
        setPendingQualityDecision: (value: unknown) => { pendingUpdates.push(value); return value; },
        setQualitySelected: (value: number) => value,
        setBusy: (value: boolean) => value,
        setQueuedInputReady: (value: boolean) => value,
        setStatus: (value: string) => value,
        recordActivity: () => undefined,
        setMessages: (value: unknown) => value,
        beginUsageTurn: () => undefined,
        activeProviderSelection: () => ({ provider: "test", model: "test-model" }),
        activeGeneration: () => undefined,
        permissionContext: () => ({ mode: "MANUAL", shellExecEnabled: false, shellInterpreter: "auto" }),
        handleAgentEvent: (event: AgentLoopEvent) => {
          if (failure === "cancel" && event.type === "provider_request") controller.abort(new DOMException("cancel quality retry", "AbortError"));
        },
        agentManager: () => undefined as any,
        permissionBroker: undefined as any,
        runCancellable: async (operation: (signal: AbortSignal) => Promise<unknown>) => {
          try {
            return { kind: "complete" as const, value: await operation(controller.signal) };
          } catch (error) {
            if (controller.signal.aborted) return { kind: "interrupted" as const };
            throw error;
          }
        },
        handleResult: () => undefined,
        handleInterruptedTurn: () => undefined,
        refreshQualityWarnings: async () => undefined,
        resumeQualitySession: async () => undefined,
        resolveQualityDecision: (options: any) => resolveQualityDecision({ ...options, harness: harnessRuntime() }),
        reportError: (error: unknown) => { errors.push(error); },
      } as any);
      await continuations.submitQualityDecision("retry");
      expect(pendingUpdates[0]).toBeNull();
      expect(pendingUpdates.at(-1)).toMatchObject({ decision: { id: result.decision.id } });
      expect(errors).toHaveLength(failure === "provider" ? 1 : 0);
      const snapshot = await loadSessionSnapshot(root, result.sessionId, { synthesizeDanglingToolResults: false });
      expect(snapshot.pendingQualityDecision?.request.id).toBe(result.decision.id);
    }
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

    await writeFile(
      join(root, "workspace", "Scene_003.md"),
      "空气中弥漫着雨味。\n空气中弥漫着尘味。",
      "utf8",
    );
    childRequests = 0;
    globalThis.fetch = (async () => {
      childRequests += 1;
      if (childRequests === 1) {
        return providerTool("child-partial-scene", "replace_in_file", {
          path: "workspace/Scene_003.md",
          oldText: "空气中弥漫着雨味。",
          newText: "雨水沿着门框滑落。",
        });
      }
      return Response.json({ id: "child-partial-done", choices: [{ message: { content: "Scene revised." } }] });
    }) as unknown as typeof fetch;
    const partialScene = await runChildAgent(childContext(root, "scene-writer"));
    const partialRecords = await loadSessionRecords(root, partialScene.childSessionId!);
    expect(partialRecords.find((record) => record.metadata?.kind === "quality-event")?.metadata?.qualityEvent)
      .toMatchObject({ producer: "scene-writer", decision: "observe", findingIds: ["zh-f0-air-thick-with"] });
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

  test("observes Semantic Judge findings without entering Runtime rewrite or persisting private responses", async () => {
    const root = await runtimeRoot("runtime");
    const requests: Array<Record<string, unknown>> = [];
    const delivered = "她不知道，三年前这里烧掉了半条街。雨水还在敲窗。";
    const judgeResponse = JSON.stringify({
      schema: "quality-judge-result/v1",
      verdict: "rewrite",
      confidence: 0.92,
      findings: [{
        ruleId: "zh-f1-pov-leak",
        evidence: "她不知道",
        confidence: 0.95,
        explanation: "叙述超出角色当下认知。",
        rewriteInstruction: "只保留角色可感知的信息。",
      }],
    });
    globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
      requests.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return requests.length === 1
        ? Response.json({ id: "runtime", choices: [{ message: { content: delivered } }] })
        : Response.json({
            id: "judge",
            choices: [{ message: { content: judgeResponse } }],
            usage: { prompt_tokens: 120, completion_tokens: 40, total_tokens: 160 },
          });
    }) as unknown as typeof fetch;
    const events: AgentLoopEvent[] = [];
    const result = await runPrompt({
      input: "continue",
      engine: "runtime",
      rootDir: root,
      messages: [{ role: "user", content: "continue" }],
      harness: harnessRuntime({ judge: true }),
      experimentalQuality: experimentalJudge("observe"),
      onEvent: (event) => events.push(event),
    });

    expect(result).toMatchObject({ kind: "complete", quality: { outcome: "findings", findingCount: 1 } });
    expect(requests).toHaveLength(2);
    const judgeRequest = requests[1] as { messages?: Array<{ role?: string; content?: string }>; tools?: unknown };
    expect(judgeRequest.tools).toBeUndefined();
    expect(judgeRequest.messages).toHaveLength(2);
    expect(judgeRequest.messages?.map((message) => message.role)).toEqual(["system", "user"]);
    expect(judgeRequest.messages?.[0]?.content).toContain("Never call tools");
    expect(judgeRequest.messages?.[1]?.content).toContain(delivered);
    expect(events).toContainEqual(expect.objectContaining({
      type: "quality_status", phase: "observed", attempt: 0, findingCount: 1,
    }));

    const snapshot = await loadSessionSnapshot(root, result.sessionId);
    expect(snapshot.qualityEvents.at(-1)).toMatchObject({
      decision: "pass",
      outcome: "findings",
      action: "observe",
      judgeStatus: "valid",
      judgeProvider: "judge-fixture",
      judgeModel: "judge-model",
      judgeRequestCount: 1,
      experimentalJudge: { mode: "observe", providerId: "judge-fixture", modelId: "judge-model" },
      judgeUsage: { inputTokens: 120, outputTokens: 40, totalTokens: 160 },
      targets: [{ findings: [{ ruleId: "zh-f1-pov-leak", source: "judge", evidence: "她不知道", confidence: 0.95 }] }],
    });
    const qualityRecord = (await loadSessionRecords(root, result.sessionId))
      .find((record) => record.metadata?.kind === "quality-event");
    const persistedQuality = JSON.stringify(qualityRecord?.metadata);
    expect(persistedQuality).not.toContain(delivered);
    expect(persistedQuality).not.toContain("叙述超出角色当下认知");
    expect(persistedQuality).not.toContain("只保留角色可感知的信息");
    expect(persistedQuality).not.toContain(judgeResponse);
  });

  test("keeps the Semantic Judge off until a user explicitly configures a profile", async () => {
    const root = await runtimeRoot("runtime");
    let requests = 0;
    globalThis.fetch = (async () => {
      requests += 1;
      return Response.json({ id: "runtime", choices: [{ message: { content: "她不知道，雨水还在敲窗。" } }] });
    }) as unknown as typeof fetch;
    const result = await runPrompt({
      input: "continue", engine: "runtime", rootDir: root,
      messages: [{ role: "user", content: "continue" }], harness: harnessRuntime({ judge: true }),
    });
    expect(result.kind).toBe("complete");
    expect(requests).toBe(1);
    const snapshot = await loadSessionSnapshot(root, result.sessionId);
    expect(snapshot.qualityEvents.at(-1)?.judgeStatus).toBeUndefined();
  });

  test("uses an explicitly selected independent Judge to enter the existing bounded rewrite lifecycle", async () => {
    const root = await runtimeRoot("runtime");
    let engineRequests = 0;
    let judgeRequests = 0;
    globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { messages?: Array<{ content?: string }> };
      if (body.messages?.[0]?.content?.includes("quality-judge-result/v1")) {
        judgeRequests += 1;
        return Response.json({ id: `judge-${judgeRequests}`, choices: [{ message: { content: JSON.stringify(
          judgeRequests === 1
            ? { schema: "quality-judge-result/v1", verdict: "rewrite", confidence: 0.9, findings: [{ ruleId: "zh-f1-pov-leak", evidence: "她不知道", confidence: 0.9, explanation: "POV leak", rewriteInstruction: "Use observable detail." }] }
            : { schema: "quality-judge-result/v1", verdict: "pass", confidence: 0.9, findings: [] },
        ) } }] });
      }
      engineRequests += 1;
      return Response.json({ id: `runtime-${engineRequests}`, choices: [{ message: { content: engineRequests === 1 ? "她不知道，雨水还在敲窗。" : "雨水敲在窗沿上。" } }] });
    }) as unknown as typeof fetch;
    const result = await runPrompt({
      input: "continue", engine: "runtime", rootDir: root,
      messages: [{ role: "user", content: "continue" }], harness: harnessRuntime({ judge: true }),
      experimentalQuality: experimentalJudge("rewrite"),
    });
    expect(result).toMatchObject({ kind: "complete", response: { content: "雨水敲在窗沿上。" } });
    expect({ engineRequests, judgeRequests }).toEqual({ engineRequests: 2, judgeRequests: 2 });
    const snapshot = await loadSessionSnapshot(root, result.sessionId);
    expect(snapshot.qualityEvents.map((event) => event.decision)).toEqual(["rewrite", "pass"]);
    expect(snapshot.qualityEvents[0]).toMatchObject({ experimentalJudge: { mode: "rewrite", providerId: "judge-fixture" } });
    expect(snapshot.qualityEvents).toEqual(expect.not.arrayContaining([
      expect.objectContaining({ targets: expect.arrayContaining([expect.objectContaining({ warningReason: "judge-unavailable" })]) }),
    ]));
    expect(snapshot.qualityWarnings).toEqual([]);
  });

  test("rejects a Semantic Judge retry when its resolved provider endpoint drifts", async () => {
    const root = await runtimeRoot("runtime");
    const configDirectory = join(root, "quality-config");
    const providersPath = join(configDirectory, "providers.yaml");
    const qualityPath = join(configDirectory, "quality.yaml");
    await mkdir(configDirectory, { recursive: true });
    await writeFile(providersPath, qualityProviderConfig("https://judge.example.test/v1"), "utf8");
    await writeFile(join(configDirectory, ".env"), "JUDGE_KEY=test-key\n", "utf8");
    await writeFile(qualityPath, [
      "version: 1", "mode: rewrite", "providerAlias: judge", "modelId: judge-model", "judgeTimeoutMs: 15000", "",
    ].join("\n"), "utf8");
    process.env.VESICLE_PROVIDERS_FILE = providersPath;
    process.env.VESICLE_QUALITY_FILE = qualityPath;

    let engineRequests = 0;
    globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { messages?: Array<{ content?: string }> };
      if (body.messages?.[0]?.content?.includes("quality-judge-result/v1")) {
        return Response.json({ id: "judge", choices: [{ message: { content: JSON.stringify({
          schema: "quality-judge-result/v1", verdict: "rewrite", confidence: 0.9, findings: [{
            ruleId: "zh-f1-pov-leak", evidence: "她不知道", confidence: 0.9, explanation: "POV leak", rewriteInstruction: "Use observable detail.",
          }],
        }) } }] });
      }
      engineRequests += 1;
      return Response.json({ id: `runtime-${engineRequests}`, choices: [{ message: { content: `她不知道，雨水敲窗第${engineRequests}次。` } }] });
    }) as unknown as typeof fetch;

    const initial = await runPrompt({
      input: "continue", engine: "runtime", rootDir: root,
      messages: [{ role: "user", content: "continue" }], harness: harnessRuntime({ judge: true }),
    });
    expect(initial.kind).toBe("needs_quality_decision");
    await writeFile(providersPath, qualityProviderConfig("https://drifted.example.test/v1"), "utf8");

    await expect(resolveQualityDecision({
      engine: "runtime", rootDir: root, sessionId: initial.sessionId,
      harness: harnessRuntime({ judge: true }), resolution: "retry",
    })).rejects.toThrow("quality profile configuration drift");
  });

  test("persists invalid Judge output as inconclusive after one repair", async () => {
    const root = await runtimeRoot("runtime");
    let requests = 0;
    const events: AgentLoopEvent[] = [];
    globalThis.fetch = (async () => {
      requests += 1;
      return requests === 1
        ? Response.json({ id: "runtime", choices: [{ message: { content: "雨水敲在铁皮棚上。" } }] })
        : Response.json({ id: `judge-${requests}`, choices: [{ message: { content: "not-json" } }] });
    }) as unknown as typeof fetch;
    const result = await runPrompt({
      input: "continue",
      engine: "runtime",
      rootDir: root,
      messages: [{ role: "user", content: "continue" }],
      harness: harnessRuntime({ judge: true }),
      experimentalQuality: experimentalJudge("observe"),
      onEvent: (event) => events.push(event),
    });
    expect(result).toMatchObject({ kind: "complete", quality: { outcome: "inconclusive", findingCount: 0 } });
    expect(requests).toBe(3);
    const snapshot = await loadSessionSnapshot(root, result.sessionId);
    expect(snapshot.qualityEvents.at(-1)).toMatchObject({ judgeStatus: "invalid", judgeRequestCount: 2 });
    expect(snapshot.qualityWarnings).toMatchObject([{ reason: "judge-invalid" }]);
    expect(events).toContainEqual(expect.objectContaining({
      type: "quality_status", phase: "inconclusive", attempt: 0, findingCount: 0,
    }));
  });

  test("skips Semantic Judge until deterministic Runtime rewrite is clean", async () => {
    const root = await runtimeRoot("runtime");
    let engineRequests = 0;
    let judgeRequests = 0;
    globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { messages?: Array<{ role?: string; content?: string }> };
      const isJudge = body.messages?.[0]?.content?.includes("quality-judge-result/v1") === true;
      if (isJudge) {
        judgeRequests += 1;
        return Response.json({ id: "judge", choices: [{ message: { content: JSON.stringify({
          schema: "quality-judge-result/v1", verdict: "pass", confidence: 0.9, findings: [],
        }) } }] });
      }
      engineRequests += 1;
      return Response.json({
        id: `runtime-${engineRequests}`,
        choices: [{ message: { content: engineRequests === 1 ? "空气中弥漫着雨味。" : "雨水顺着门轴滴到袖口。" } }],
      });
    }) as unknown as typeof fetch;
    const result = await runPrompt({
      input: "continue",
      engine: "runtime",
      rootDir: root,
      messages: [{ role: "user", content: "continue" }],
      harness: harnessRuntime({ judge: true }),
      experimentalQuality: experimentalJudge("observe"),
    });
    expect(result.kind).toBe("complete");
    expect(engineRequests).toBe(2);
    expect(judgeRequests).toBe(1);
    const snapshot = await loadSessionSnapshot(root, result.sessionId);
    expect(snapshot.qualityEvents.map((event) => ({ decision: event.decision, judgeStatus: event.judgeStatus })))
      .toEqual([{ decision: "rewrite", judgeStatus: undefined }, { decision: "pass", judgeStatus: "valid" }]);
  });

  test("marks an over-budget Semantic Judge target inconclusive without a Judge request", async () => {
    const root = await runtimeRoot("runtime");
    let requests = 0;
    globalThis.fetch = (async () => {
      requests += 1;
      return Response.json({ id: "runtime", choices: [{ message: { content: "a".repeat(30_001) } }] });
    }) as unknown as typeof fetch;
    const result = await runPrompt({
      input: "continue",
      engine: "runtime",
      rootDir: root,
      messages: [{ role: "user", content: "continue" }],
      harness: harnessRuntime({ judge: true }),
      experimentalQuality: experimentalJudge("observe"),
    });
    expect(result).toMatchObject({ kind: "complete", quality: { outcome: "inconclusive" } });
    expect(requests).toBe(1);
    const snapshot = await loadSessionSnapshot(root, result.sessionId);
    expect(snapshot.qualityEvents.at(-1)).toMatchObject({
      judgeStatus: "unavailable",
      judgeRequestCount: 0,
      targets: [{ status: "warning", warningReason: "target-oversize" }],
    });
    expect(snapshot.qualityWarnings).toMatchObject([{ reason: "target-oversize" }]);
  });

  test("keeps a sibling warning inconclusive when a readable target has Judge findings", async () => {
    const root = await runtimeRoot("runtime", ["runtime-turn"]);
    let engineRequests = 0;
    let judgeRequests = 0;
    globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { messages?: Array<{ content?: string }> };
      if (body.messages?.[0]?.content?.includes("quality-judge-result/v1")) {
        judgeRequests += 1;
        expect(body.messages?.at(-1)?.content).toContain("雨水敲在铁皮棚上");
        return Response.json({ id: "judge", choices: [{ message: { content: JSON.stringify({
          schema: "quality-judge-result/v1", verdict: "rewrite", confidence: 0.9, findings: [{
            ruleId: "zh-f1-pov-leak",
            evidence: "雨水敲在铁皮棚上",
            confidence: 0.8,
            explanation: "The sentence leaks viewpoint knowledge.",
            rewriteInstruction: "Keep the description externally observable.",
          }],
        }) } }] });
      }
      engineRequests += 1;
      if (engineRequests === 1) return providerTools("partial-judge-writes", [
        { id: "partial-judge-a", name: "write_file", arguments: JSON.stringify({ path: "workspace/a.md", content: "风停了。" }) },
        { id: "partial-judge-b", name: "write_file", arguments: JSON.stringify({ path: "workspace/b.md", content: "雨水敲在铁皮棚上。" }) },
      ]);
      await rm(join(root, "workspace", "a.md"));
      return providerTool("partial-judge-gate", "request_confirmation", { gate: "runtime-turn", summary: "Review." });
    }) as unknown as typeof fetch;
    const result = await runPrompt({
      input: "continue",
      engine: "runtime",
      rootDir: root,
      messages: [{ role: "user", content: "continue" }],
      harness: harnessRuntime({ judge: true }),
      experimentalQuality: experimentalJudge("observe"),
    });
    expect(result.kind).toBe("needs_user");
    expect(engineRequests).toBe(2);
    expect(judgeRequests).toBe(1);
    const snapshot = await loadSessionSnapshot(root, result.sessionId);
    expect(snapshot.qualityEvents.at(-1)).toMatchObject({
      outcome: "inconclusive",
      judgeStatus: "valid",
      targets: [
        { id: "artifact:workspace/a.md", status: "warning", warningReason: "target-unreadable" },
        {
          id: "artifact:workspace/b.md",
          status: "findings",
          findings: [{ ruleId: "zh-f1-pov-leak", source: "judge", evidence: "雨水敲在铁皮棚上" }],
        },
      ],
    });
    expect(snapshot.qualityWarnings).toMatchObject([{ reason: "target-unreadable" }]);
  });
});

async function createMixedExhaustedSession(root: string, prefix: string): Promise<string> {
  let requests = 0;
  globalThis.fetch = (async () => {
    requests += 1;
    if (requests === 1) return providerTools(`${prefix}-writes`, [
      { id: `${prefix}-a`, name: "write_file", arguments: JSON.stringify({ path: "workspace/a.md", content: "空气中弥漫着雨味。" }) },
      { id: `${prefix}-b`, name: "write_file", arguments: JSON.stringify({ path: "workspace/b.md", content: "空气中弥漫着尘味。" }) },
    ]);
    if (requests === 2) {
      await rm(join(root, "workspace", "a.md"));
    }
    return providerTool(`${prefix}-gate-${requests}`, "request_confirmation", { gate: "runtime-turn", summary: "Review." });
  }) as unknown as typeof fetch;
  const result = await runPrompt({
    input: "continue",
    engine: "runtime",
    rootDir: root,
    messages: [{ role: "user", content: "continue" }],
    harness: harnessRuntime(),
  });
  if (result.kind !== "needs_quality_decision") throw new Error("expected mixed exhausted quality decision");
  return result.sessionId;
}

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
    "  - append_file",
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
      "  - write_file",
      "  - replace_in_file",
      "  - append_file",
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

function harnessRuntime(options: { judge?: boolean } = {}): HarnessRuntimeContext {
  return {
    packId: "prism-engine-v10",
    packVersion: "10.0.1-alpha.1",
    sourceCommit: "fixture",
    manifestSha256: "a".repeat(64),
    driver: { schema: "prism-driver-contract/v1", id: "fixture", version: "1.0.0", engines: {}, agents: {} },
    adapter: { schema: "prism-host-adapter/v1", id: "fixture", version: "1.0.0", targetHost: "prism-vesicle", operationBindings: {}, interactionBindings: {} },
    quality: qualityRuntime(options),
  };
}

function qualityRuntime(options: { judge?: boolean } = {}): QualityRuntimeContext {
  const judge: QualityJudgeContract = {
    rubric: "Judge only the supplied candidate and return JSON.",
    rules: [{
      id: "zh-f1-pov-leak",
      title: "POV leak",
      severity: "tier2",
      maturity: "stable",
      targets: ["narrative-prose"],
      source: "self",
      evidence: { mode: "exact-substring", minCodePoints: 1, maxCodePoints: 240 },
    }],
  };
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
      projectionCounts: { guidance: 0, detector: 1, judge: options.judge ? 1 : 0, replacement: 0 },
      requiredCapabilities: [
        "quality-guard/anti-ai-flavor@1",
        ...(options.judge ? ["quality-judge/anti-ai-flavor@1"] : []),
      ],
      preprocessing: {
        line_endings: "LF",
        unicode_normalization: "NFC",
        offset_basis: "normalized-candidate",
        protected_regions: ["markdown-fenced-code", "markdown-blockquote", "html-comment", "prism-hud", "host-provided-ranges"],
      },
      artifacts: {},
    },
    rules: [literalRule()],
    ...(options.judge ? { judge } : {}),
    engineModes: { runtime: "rewrite", weaver: "observe", "weaver-orch": "observe", dyad: "observe", evaluate: "analyze", etl: "off" },
    agentModes: { "scene-writer": "observe", "chapter-reviewer": "analyze", "continuity-editor": "off" },
  };
}

function experimentalJudge(mode: "observe" | "rewrite"): ExperimentalQualityProfile {
  return {
    mode,
    provider: new OpenAIChatCompatibleAdapter({
      provider: "openai-chat-compatible",
      providerId: "judge-fixture",
      baseUrl: "https://example.test/v1",
      model: "judge-model",
      apiKey: "test-key",
    }),
    providerId: "judge-fixture",
    modelId: "judge-model",
    protocol: "openai-chat-compatible",
    judgeTimeoutMs: 15_000,
    configIdentity: "e".repeat(64),
    settingsPath: "/fixture/quality.yaml",
    temperatureSupported: true,
    reasoningTierSupported: false,
  };
}

function qualityProviderConfig(baseUrl: string): string {
  return [
    "default:", "  provider: judge", "  model: judge-model", "providers:",
    "  judge:", "    protocol: openai-chat-compatible", `    baseUrl: ${baseUrl}`, "    apiKeyEnv: JUDGE_KEY", "    models:", "      - judge-model", "",
  ].join("\n");
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
