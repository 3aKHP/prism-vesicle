import { describe, expect, test } from "bun:test";
import type { ProviderAdapter, VesicleRequest, VesicleResponse } from "../../../src/providers/shared/types";
import {
  maxQualityJudgeCodeUnits,
  parseJudgeRules,
  parseQualityJudgeResponse,
  runQualityJudge,
  type QualityJudgeContract,
  type QualityJudgeRule,
} from "../../../src/core/quality";

const candidate = "雨水敲在铁皮棚上。空气中弥漫着淡淡的血腥味。";
const rules: QualityJudgeRule[] = parseJudgeRules({
  schema: "judge-rules/v1",
  module: "anti-ai-flavor",
  language: "zh-CN",
  rules: [{
    id: "zh-f0-air-thick-with",
    title: "环境套话",
    severity: "tier1",
    maturity: "stable",
    targets: ["narrative-prose"],
    source: "self",
    evidence: { mode: "exact-substring", minCodePoints: 1, maxCodePoints: 240 },
  }],
});
const contract: QualityJudgeContract = { rubric: "Judge only the supplied candidate.", rules };

describe("Semantic Judge contracts", () => {
  test("parses verified Judge rules and strict evidence-backed results", () => {
    expect(rules).toHaveLength(1);
    expect(parseQualityJudgeResponse(validFinding(), candidate, rules)).toMatchObject({
      verdict: "rewrite",
      confidence: 0.91,
      findings: [{
        ruleId: "zh-f0-air-thick-with",
        evidence: "空气中弥漫着",
        start: 9,
        end: 15,
        source: "judge",
        confidence: 0.94,
      }],
    });
  });

  test("rejects unknown fields, unknown rules, duplicate rules, and fake evidence", () => {
    expect(() => parseQualityJudgeResponse(JSON.stringify({
      ...JSON.parse(validFinding()), extra: true,
    }), candidate, rules)).toThrow("unknown field extra");
    expect(() => parseQualityJudgeResponse(validFinding({ ruleId: "unknown-rule" }), candidate, rules))
      .toThrow("unknown rule");
    const duplicate = JSON.parse(validFinding()) as { findings: unknown[] };
    duplicate.findings.push(duplicate.findings[0]);
    expect(() => parseQualityJudgeResponse(JSON.stringify(duplicate), candidate, rules)).toThrow("duplicates rule");
    expect(() => parseQualityJudgeResponse(validFinding({ evidence: "候选中不存在的证据" }), candidate, rules))
      .toThrow("not an exact candidate substring");
  });

  test("requires verdict and finding cardinality to agree", () => {
    expect(() => parseQualityJudgeResponse(JSON.stringify({
      schema: "quality-judge-result/v1",
      verdict: "pass",
      confidence: 0.8,
      findings: [JSON.parse(validFinding()).findings[0]],
    }), candidate, rules)).toThrow("does not match");
  });
});

describe("Semantic Judge provider service", () => {
  test("uses an isolated tool-free bounded request and records usage", async () => {
    const requests: VesicleRequest[] = [];
    const provider: ProviderAdapter = {
      id: "fixture",
      async complete(request) {
        requests.push(request);
        return response(validFinding(), { inputTokens: 100, outputTokens: 30, totalTokens: 130 });
      },
    };
    const result = await runQualityJudge({
      provider,
      providerId: "openai",
      model: "current-model",
      contract,
      candidateType: "runtime.prose",
      targetKind: "assistant-response",
      content: candidate,
    });

    expect(result).toMatchObject({
      status: "valid",
      requestCount: 1,
      usage: { inputTokens: 100, outputTokens: 30, totalTokens: 130 },
      findings: [{ ruleId: "zh-f0-air-thick-with" }],
    });
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      model: { provider: "openai", model: "current-model" },
      tools: [],
      generation: { temperature: 0, maxTokens: 2048 },
      metadata: { kind: "quality-judge" },
    });
    expect(requests[0]!.messages).toHaveLength(1);
    expect(requests[0]!.messages[0]?.role).toBe("user");
    expect(requests[0]!.system.join("\n")).toContain("Never call tools");
    expect(JSON.stringify(requests[0]!.metadata)).not.toContain(candidate);
  });

  test("allows exactly one format repair and aggregates request usage", async () => {
    const requests: VesicleRequest[] = [];
    const provider: ProviderAdapter = {
      id: "fixture",
      async complete(request) {
        requests.push(request);
        return requests.length === 1
          ? response("```json\n{}\n```", { inputTokens: 10, outputTokens: 2 })
          : response(passResult(), { inputTokens: 12, outputTokens: 3 });
      },
    };
    const result = await runQualityJudge({
      provider,
      providerId: "anthropic",
      model: "current-model",
      contract,
      candidateType: "runtime.prose",
      targetKind: "artifact-post-image",
      content: candidate,
    });
    expect(result).toMatchObject({
      status: "valid",
      requestCount: 2,
      usage: { inputTokens: 22, outputTokens: 5 },
    });
    expect(requests).toHaveLength(2);
    expect(requests[1]!.messages).toHaveLength(1);
    expect(requests[1]!.messages[0]?.content).toContain("priorInvalidResponse");
  });

  test("consumes streaming providers without exposing deltas", async () => {
    const provider: ProviderAdapter = {
      id: "stream-fixture",
      async complete() { throw new Error("non-stream path must not run"); },
      async *stream() {
        yield { type: "content_delta", delta: "private judge delta" } as const;
        yield { type: "complete", response: response(passResult()) } as const;
      },
    };
    await expect(runQualityJudge({
      provider,
      providerId: "gemini",
      model: "current-model",
      contract,
      candidateType: "runtime.prose",
      targetKind: "assistant-response",
      content: candidate,
    })).resolves.toMatchObject({ status: "valid", findings: [], requestCount: 1 });
  });

  test("returns invalid after one failed repair", async () => {
    let calls = 0;
    const provider: ProviderAdapter = {
      id: "fixture",
      async complete() {
        calls += 1;
        return response("not-json");
      },
    };
    await expect(runQualityJudge({
      provider,
      providerId: "openai",
      model: "current-model",
      contract,
      candidateType: "runtime.prose",
      targetKind: "assistant-response",
      content: candidate,
    })).resolves.toMatchObject({ status: "invalid", requestCount: 2, findings: [] });
    expect(calls).toBe(2);
  });

  test("distinguishes timeout, provider failure, cancellation, and oversize", async () => {
    const waitingProvider = (message: string): ProviderAdapter => ({
      id: "waiting",
      async complete(request) {
        return await new Promise<VesicleResponse>((_resolve, reject) => {
          request.signal?.addEventListener("abort", () => reject(request.signal?.reason ?? new Error(message)), { once: true });
        });
      },
    });
    await expect(runQualityJudge({
      provider: waitingProvider("timeout"),
      providerId: "openai",
      model: "current-model",
      contract,
      candidateType: "runtime.prose",
      targetKind: "assistant-response",
      content: candidate,
      timeoutMs: 5,
    })).resolves.toMatchObject({ status: "timed-out", requestCount: 1 });

    await expect(runQualityJudge({
      provider: { id: "broken", async complete() { throw new Error("offline"); } },
      providerId: "openai",
      model: "current-model",
      contract,
      candidateType: "runtime.prose",
      targetKind: "assistant-response",
      content: candidate,
    })).resolves.toMatchObject({ status: "unavailable", requestCount: 1 });

    const controller = new AbortController();
    const cancelled = runQualityJudge({
      provider: waitingProvider("cancelled"),
      providerId: "openai",
      model: "current-model",
      contract,
      candidateType: "runtime.prose",
      targetKind: "assistant-response",
      content: candidate,
      signal: controller.signal,
    });
    controller.abort(new DOMException("cancelled", "AbortError"));
    await expect(cancelled).rejects.toMatchObject({ name: "AbortError" });

    let oversizeCalls = 0;
    const oversize = await runQualityJudge({
      provider: { id: "unused", async complete() { oversizeCalls += 1; return response(passResult()); } },
      providerId: "openai",
      model: "current-model",
      contract,
      candidateType: "runtime.prose",
      targetKind: "assistant-response",
      content: "a".repeat(maxQualityJudgeCodeUnits + 1),
    });
    expect(oversize).toMatchObject({ status: "unavailable", requestCount: 0 });
    expect(oversizeCalls).toBe(0);
  });
});

function validFinding(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    schema: "quality-judge-result/v1",
    verdict: "rewrite",
    confidence: 0.91,
    findings: [{
      ruleId: "zh-f0-air-thick-with",
      evidence: "空气中弥漫着",
      confidence: 0.94,
      explanation: "套话替代了人物感受。",
      rewriteInstruction: "改为身体感受。",
      ...overrides,
    }],
  });
}

function passResult(): string {
  return JSON.stringify({ schema: "quality-judge-result/v1", verdict: "pass", confidence: 0.9, findings: [] });
}

function response(content: string, usage?: VesicleResponse["usage"]): VesicleResponse {
  return { id: crypto.randomUUID(), content, ...(usage ? { usage } : {}) };
}
