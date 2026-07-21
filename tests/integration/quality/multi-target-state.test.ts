import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import { resolveGate, resolveQualityDecision, runPrompt, } from "../../../src/core/agent-loop/run";
import { loadSessionSnapshot } from "../../../src/core/session/store";
import { readQualityArtifactTargets, } from "../../../src/core/quality";
import { harnessRuntime, providerTool, providerTools, restoreQualityTestState, runtimeRoot } from "./fixtures/quality-runtime";

afterEach(restoreQualityTestState);

describe("quality: multi-target state", () => {
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

});
