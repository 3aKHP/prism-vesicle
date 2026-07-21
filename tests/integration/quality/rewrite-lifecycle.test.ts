
import { afterEach, describe, expect, test } from "bun:test";
import { resolveQualityDecision, runPrompt, } from "../../../src/core/agent-loop/run";
import { listSessions, loadSessionSnapshot } from "../../../src/core/session/store";
import { harnessRuntime, restoreQualityTestState, runtimeRoot } from "./fixtures/quality-runtime";

afterEach(restoreQualityTestState);

describe("quality: rewrite lifecycle", () => {

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

});
