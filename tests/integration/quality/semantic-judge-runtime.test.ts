import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import { resolveQualityDecision, runPrompt, type AgentLoopEvent } from "../../../src/core/agent-loop/run";
import { loadSessionRecords, loadSessionSnapshot } from "../../../src/core/session/store";
import { experimentalJudge, harnessRuntime, providerTool, providerTools, qualityProviderConfig, restoreQualityTestState, runtimeRoot } from "./fixtures/quality-runtime";

afterEach(restoreQualityTestState);

describe("quality: semantic judge runtime", () => {
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
