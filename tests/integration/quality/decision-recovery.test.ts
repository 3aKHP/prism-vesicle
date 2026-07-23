
import { afterEach, describe, expect, test } from "bun:test";
import { resolveQualityDecision, runPrompt, } from "../../../src/core/agent-loop/run";
import { createSessionStore, listSessions, loadSessionSnapshot } from "../../../src/core/session/store";
import { harnessRuntime, restoreQualityTestState, runtimeRoot } from "./fixtures/quality-runtime";

afterEach(restoreQualityTestState);

describe("quality: decision recovery", () => {
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

});
