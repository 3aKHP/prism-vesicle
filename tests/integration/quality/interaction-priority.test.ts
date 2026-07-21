import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import { refreshQualityDecisionArtifacts, resolveQualityDecision, runPrompt, } from "../../../src/core/agent-loop/run";
import { loadSessionSnapshot } from "../../../src/core/session/store";
import { createMixedExhaustedSession, harnessRuntime, providerTool, providerTools, restoreQualityTestState, runtimeRoot } from "./fixtures/quality-runtime";

afterEach(restoreQualityTestState);

describe("quality: interaction priority", () => {
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

});
