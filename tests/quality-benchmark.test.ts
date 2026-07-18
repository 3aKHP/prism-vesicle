import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProviderAdapter, VesicleRequest, VesicleResponse } from "../src/providers/shared/types";
import {
  runQualityBenchmark,
  type QualityBenchmarkCase,
  type QualityBenchmarkModel,
  type QualityBenchmarkPolicy,
  type QualityRuntimeContext,
} from "../src/core/quality";

const cases: QualityBenchmarkCase[] = [
  caseFor("pass-case", "清洁正文", "pass", []),
  caseFor("rewrite-case", "坏味道正文", "rewrite", ["zh-f1-style"]),
];

describe("quality benchmark runner", () => {
  test("records a privacy-safe append-only run, resumes idempotently, and reports Wilson metrics", async () => {
    const directory = await mkdtemp(join(tmpdir(), "vesicle-quality-benchmark-"));
    const outputPath = join(directory, "events.jsonl");
    try {
      let calls = 0;
      const options = benchmarkOptions(outputPath, [model("openai-chat-completions", async (request) => {
        calls += 1;
        return response(request.messages[0]!.content.includes("坏味道") ? rewriteResult() : passResult(), { inputTokens: 12, outputTokens: 4, totalTokens: 16 });
      })]);
      const first = await runQualityBenchmark(options);
      expect(first.evaluations).toHaveLength(4);
      expect(calls).toBe(4);
      expect(first.report.models[0]).toMatchObject({
        sampleCounts: { cases: 2, evaluations: 4, requests: 4, pass: 2, rewrite: 2 },
        metrics: {
          expectedRewriteRecall: { value: 1, numerator: 2, denominator: 2 },
          passFalseRewriteRate: { value: 0, numerator: 0, denominator: 2 },
        },
        decision: "pass",
      });
      const source = await readFile(outputPath, "utf8");
      expect(source).not.toContain("清洁正文");
      expect(source).not.toContain("坏味道正文");
      expect(source).not.toContain("priorInvalidResponse");

      const resumed = await runQualityBenchmark({
        ...options,
        models: [model("openai-chat-completions", async () => { throw new Error("completed cases must not call provider"); })],
      });
      expect(resumed.evaluations).toHaveLength(4);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("persists completed evaluations when cancelled and resumes remaining work", async () => {
    const directory = await mkdtemp(join(tmpdir(), "vesicle-quality-benchmark-"));
    const outputPath = join(directory, "events.jsonl");
    try {
      const controller = new AbortController();
      let calls = 0;
      await expect(runQualityBenchmark({
        ...benchmarkOptions(outputPath, [model("openai-chat-completions", async () => {
          calls += 1;
          controller.abort(new DOMException("cancelled", "AbortError"));
          return response(passResult());
        })]),
        signal: controller.signal,
      })).rejects.toMatchObject({ name: "AbortError" });
      expect(calls).toBe(1);
      expect((await readFile(outputPath, "utf8")).trim().split("\n")).toHaveLength(1);

      const resumed = await runQualityBenchmark(benchmarkOptions(outputPath, [model("openai-chat-completions", async (request) =>
        response(request.messages[0]!.content.includes("坏味道") ? rewriteResult() : passResult())
      )]));
      expect(resumed.evaluations).toHaveLength(4);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("reserves the two-request repair budget and stops before exceeding a cap", async () => {
    const directory = await mkdtemp(join(tmpdir(), "vesicle-quality-benchmark-"));
    try {
      const result = await runQualityBenchmark({
        ...benchmarkOptions(join(directory, "events.jsonl"), [model("openai-chat-completions", async () => response(passResult()))]),
        policy: { ...policy(), requestCap: 2 },
      });
      expect(result.evaluations).toHaveLength(1);
      expect(result.stoppedEarly).toEqual([{ model: "fixture\0openai-chat-completions\0fixture-model", reason: "budget reserved: request cap" }]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("covers the three configured provider protocols and stops invalid output early", async () => {
    const directory = await mkdtemp(join(tmpdir(), "vesicle-quality-benchmark-"));
    try {
      const matrix = await runQualityBenchmark(benchmarkOptions(join(directory, "matrix.jsonl"), [
        model("openai-chat-completions", async () => response(passResult())),
        model("anthropic-messages", async () => response(passResult())),
        model("gemini-generate-content", async () => response(passResult())),
      ], [cases[0]!], 1));
      expect(matrix.report.models.map((entry) => entry.protocol)).toEqual([
        "openai-chat-completions", "anthropic-messages", "gemini-generate-content",
      ]);

      const invalid = await runQualityBenchmark({
        ...benchmarkOptions(join(directory, "invalid.jsonl"), [model("openai-chat-completions", async () => response("not-json"))]),
        policy: { ...policy(), earlyStop: { ...policy().earlyStop, invalidRate: 0.1 } },
      });
      expect(invalid.evaluations).toHaveLength(1);
      expect(invalid.stoppedEarly[0]?.reason).toBe("early stop: invalid response rate");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("uses the frozen benchmark Judge timeout instead of the interactive default", async () => {
    const directory = await mkdtemp(join(tmpdir(), "vesicle-quality-benchmark-"));
    try {
      const result = await runQualityBenchmark({
        ...benchmarkOptions(join(directory, "events.jsonl"), [model("openai-chat-completions", async (request) =>
          await new Promise<VesicleResponse>((_resolve, reject) => request.signal?.addEventListener("abort", () => reject(request.signal?.reason), { once: true }))
        )], [cases[0]!], 1),
        policy: { ...policy(), judgeTimeoutMs: 1_000 },
      });
      expect(result.evaluations[0]?.result.status).toBe("timed-out");
      expect(result.evaluations[0]?.result.durationMs).toBeGreaterThanOrEqual(900);
      expect(result.evaluations[0]?.result.durationMs).toBeLessThan(5_000);
      expect(result.report.policy.judgeTimeoutMs).toBe(1_000);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("rejects an out-of-range frozen Judge timeout before any provider request", async () => {
    const directory = await mkdtemp(join(tmpdir(), "vesicle-quality-benchmark-"));
    try {
      let calls = 0;
      await expect(runQualityBenchmark({
        ...benchmarkOptions(join(directory, "events.jsonl"), [model("openai-chat-completions", async () => {
          calls += 1;
          return response(passResult());
        })]),
        policy: { ...policy(), judgeTimeoutMs: 180_001 },
      })).rejects.toThrow("Benchmark Judge timeout must be an integer from 1000 to 180000 milliseconds.");
      expect(calls).toBe(0);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("rejects a tampered corpus case before any provider request", async () => {
    const directory = await mkdtemp(join(tmpdir(), "vesicle-quality-benchmark-"));
    try {
      let calls = 0;
      await expect(runQualityBenchmark({
        ...benchmarkOptions(join(directory, "events.jsonl"), [model("openai-chat-completions", async () => {
          calls += 1;
          return response(passResult());
        })]),
        cases: [{ ...cases[0]!, candidateSha256: "0".repeat(64) }],
      })).rejects.toThrow("Benchmark case pass-case is invalid");
      expect(calls).toBe(0);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("does not call a valid blinded result a failure", async () => {
    const directory = await mkdtemp(join(tmpdir(), "vesicle-quality-benchmark-"));
    try {
      const blinded: QualityBenchmarkCase = {
        ...cases[0]!,
        caseId: "blind-case",
      };
      delete blinded.expectedVerdict;
      delete blinded.expectedRuleIds;
      const result = await runQualityBenchmark(benchmarkOptions(
        join(directory, "events.jsonl"),
        [model("openai-chat-completions", async () => response(passResult()))],
        [blinded],
        1,
      ));
      expect(result.report.models[0]?.failureCaseIds).toEqual([]);
      expect(result.report.models[0]?.decision).toBe("inconclusive");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

function benchmarkOptions(
  outputPath: string,
  models: QualityBenchmarkModel[],
  benchmarkCases = cases,
  repeatsPerCase = 2,
) {
  return {
    runId: "fixture-run",
    outputPath,
    cases: benchmarkCases,
    models,
    identity: { vesicleCommit: "a".repeat(40), corpusSha256: sha256("fixture-corpus"), runtime: runtime() },
    policy: { ...policy(), repeatsPerCase },
    now: () => new Date("2026-07-17T00:00:00.000Z"),
  };
}

function policy(): QualityBenchmarkPolicy {
  return {
    repeatsPerCase: 2,
    confidenceInterval: "wilson-95",
    majorSlices: ["rule", "genre", "targetType"],
    minimumSliceN: 1,
    requestCap: 100,
    tokenCap: 1_000_000,
    costCapUsd: 100,
    maxInputTokensPerRequest: 10_000,
    judgeTimeoutMs: 15_000,
    minimumIntervalMs: 0,
    goNoGo: {
      minimumRecall: 0,
      maximumFalseRewriteRate: 1,
      minimumAgreement: 0,
      maximumInvalidRate: 1,
      maximumP95LatencyMs: 60_000,
    },
    earlyStop: { invalidRate: 1, timeoutRate: 1, falseRewriteRate: 1 },
  };
}

function model(protocol: QualityBenchmarkModel["protocol"], complete: (request: VesicleRequest) => Promise<VesicleResponse>): QualityBenchmarkModel {
  const provider: ProviderAdapter = { id: `fixture-${protocol}`, complete };
  return {
    providerAlias: "fixture",
    protocol,
    modelId: "fixture-model",
    provider,
    pricing: { inputUsdPerMillionTokens: 1, outputUsdPerMillionTokens: 2 },
  };
}

function runtime(): QualityRuntimeContext {
  return {
    packDirectory: "/fixture",
    packId: "prism-engine-v10",
    packVersion: "10.0.1-alpha.4",
    sourceCommit: "b".repeat(40),
    manifestSha256: "c".repeat(64),
    ruleManifest: {
      schema: "rule-pack/v1",
      module: "anti-ai-flavor",
      version: "0.3.0-alpha.3",
      primaryLanguage: "zh-CN",
      sourceRepository: "fixture",
      sourceCommit: "b".repeat(40),
      sourceState: "clean",
      sourceHash: "d".repeat(64),
      moduleInputHash: "e".repeat(64),
      compilerHash: "f".repeat(64),
      ruleCount: 1,
      projectionCounts: { guidance: 0, detector: 0, judge: 1, replacement: 0 },
      requiredCapabilities: ["quality-guard/anti-ai-flavor@1", "quality-judge/anti-ai-flavor@1"],
      preprocessing: { line_endings: "LF", unicode_normalization: "NFC", offset_basis: "normalized-candidate", protected_regions: ["markdown-fenced-code", "markdown-blockquote", "html-comment", "prism-hud", "host-provided-ranges"] },
      artifacts: {
        "judge-rubric.zh-CN.md": "1".repeat(64),
        "judge-rules.zh-CN.json": "2".repeat(64),
        "schemas/judge-result.schema.json": "3".repeat(64),
      },
    },
    rules: [],
    judge: {
      rubric: "Return the strict contract.",
      rules: [{
        id: "zh-f1-style",
        title: "Style issue",
        severity: "tier1",
        maturity: "stable",
        targets: ["narrative-prose"],
        source: "fixture",
        evidence: { mode: "exact-substring", minCodePoints: 1, maxCodePoints: 240 },
      }],
    },
    engineModes: { runtime: "observe" },
    agentModes: {},
  };
}

function caseFor(caseId: string, text: string, expectedVerdict: "pass" | "rewrite", expectedRuleIds: string[]): QualityBenchmarkCase {
  return {
    caseId,
    text,
    candidateSha256: sha256(text),
    targetType: "narrative-prose",
    genre: "fixture",
    modelFamily: "fixture",
    lengthBucket: "short",
    pov: "third",
    expectedVerdict,
    expectedRuleIds,
  };
}

function passResult(): string {
  return JSON.stringify({ schema: "quality-judge-result/v1", verdict: "pass", confidence: 0.9, findings: [] });
}

function rewriteResult(): string {
  return JSON.stringify({
    schema: "quality-judge-result/v1",
    verdict: "rewrite",
    confidence: 0.9,
    findings: [{ ruleId: "zh-f1-style", evidence: "坏味道", confidence: 0.9, explanation: "fixture", rewriteInstruction: "rewrite" }],
  });
}

function response(content: string, usage?: VesicleResponse["usage"]): VesicleResponse {
  return { id: crypto.randomUUID(), content, ...(usage ? { usage } : {}) };
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
