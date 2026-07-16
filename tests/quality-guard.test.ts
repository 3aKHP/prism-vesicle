import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  evaluateBoundQuality,
  evaluateQualityCandidate,
  maxQualityArtifactBytes,
  parseDetectorRules,
  parseRulePackManifest,
  type QualityCandidateType,
  type QualityDetectorRule,
  type QualityProtectedRange,
  type QualityRuntimeContext,
} from "../src/core/quality";

type PublishedCase = {
  name: string;
  candidateType: QualityCandidateType;
  text: string;
  protectedRanges?: QualityProtectedRange[];
  expectedRuleIds: string[];
  expectedMetrics?: Array<{ ruleId: string; signal: string; value: number; threshold: number; tolerance: number }>;
};

const bundledQualityDirectory = join(import.meta.dir, "..", "assets", "quality", "anti-ai-flavor");

const rules = parseDetectorRules({
  schema: "detector-rules/v1",
  module: "anti-ai-flavor",
  language: "zh-CN",
  rules: [
    detector("zh-f0-air-thick-with", "F0", "tier1", "stable", { kind: "literal", value: "空气中弥漫着", unit: "candidate" }),
    detector("zh-f0-meaningless-filler", "F0", "tier2", "stable", { kind: "regex", value: "^(就这样(?:[，,][^。！？!?]{0,12})?|于是[^。！？!?]{0,8}了)[。！!？?]?$", unit: "sentence", flags: "u" }),
    detector("zh-f0-essay-register-connectors", "F0", "tier2", "stable", { kind: "regex", value: "(总而言之|不得不说|值得一提的是|与此同时[，,])", unit: "sentence", flags: "u" }),
    detector("zh-f1-not-x-but-y", "F1", "tier1", "stable", { kind: "regex", value: "不是[^。！？!?]{1,30}而是", unit: "sentence", flags: "u" }),
    detector("zh-f1-narrator-filler-before-quote", "F1", "tier1", "stable", { kind: "regex", value: "(顿了一下|沉默了一会儿)[,，]?然后说", unit: "sentence", flags: "u" }),
    detector("zh-f3-emdash-density", "F3", "tier3", "experimental", { kind: "metric", unit: "paragraph", metric: { signal: "em_dash_per_100_chars", operator: "gte", threshold: 2 } }),
  ],
});

describe("deterministic Output Quality Guard", () => {
  test("matches every published host conformance case from the bundled Rule Pack", async () => {
    const publishedRules = await loadBundledDetectorRules();
    const corpus = await readFile(join(bundledQualityDirectory, "calibration", "host-conformance.jsonl"), "utf8");
    const cases = corpus.trim().split("\n").map((line) => JSON.parse(line) as PublishedCase);
    expect(cases).toHaveLength(24);
    for (const fixture of cases) {
      const result = evaluateQualityCandidate({
        producer: "runtime",
        type: fixture.candidateType,
        content: fixture.text,
        protectedRanges: fixture.protectedRanges,
      }, publishedRules);
      expect([...new Set(result.findings.map((finding) => finding.ruleId))].sort(), fixture.name)
        .toEqual([...fixture.expectedRuleIds].sort());
      for (const expected of fixture.expectedMetrics ?? []) {
        const metric = result.findings.find((finding) => finding.ruleId === expected.ruleId)?.metric;
        expect(metric?.signal === undefined ? undefined : String(metric.signal), fixture.name).toBe(expected.signal);
        expect(metric?.threshold, fixture.name).toBe(expected.threshold);
        expect(Math.abs((metric?.value ?? Number.POSITIVE_INFINITY) - expected.value), fixture.name)
          .toBeLessThanOrEqual(expected.tolerance);
      }
    }
  });

  test("reports normalized UTF-16 evidence offsets", () => {
    const result = evaluateQualityCandidate({
      producer: "runtime",
      type: "runtime.prose",
      content: "😀空气中弥漫着雨味。",
    }, rules);
    expect(result.findings[0]).toMatchObject({ start: 2, end: 8, evidence: "空气中弥漫着" });
  });

  test("fails closed on invalid normalized protected ranges", () => {
    expect(() => evaluateQualityCandidate({
      producer: "runtime",
      type: "runtime.prose",
      content: "短句",
      protectedRanges: [{ start: 0, end: 10 }],
    }, rules)).toThrow("outside the normalized candidate");
  });

  test("excludes Markdown headings, lists, and tables from scene prose", () => {
    const result = evaluateQualityCandidate({
      producer: "weaver",
      type: "scene.prose",
      content: [
        "# 空气中弥漫着编辑标题",
        "- 空气中弥漫着场景计划",
        "| 字段 | 空气中弥漫着元数据 |",
        "| --- | --- |",
        "",
        "雨水从檐角落进石槽。",
      ].join("\n"),
    }, rules);
    expect(result.findings).toEqual([]);
  });

  test("excludes Hidden Neural Chain lines from document metrics", async () => {
    const publishedRules = await loadBundledDetectorRules();
    const result = evaluateQualityCandidate({
      producer: "runtime",
      type: "runtime.prose",
      content: "[!Neural Chain] 一丝一丝一丝一丝一丝一丝一丝一丝\n正文只写雨水落进石槽。",
    }, publishedRules);
    expect(result.findings).toEqual([]);
  });

  test("keeps document metrics advisory even if pack metadata marks one stable tier1", () => {
    const advisoryRule = detector("forced-document-metric", "F3", "tier1", "stable", {
      kind: "metric",
      unit: "candidate",
      metric: {
        signal: "cliche_per_1000_chars",
        operator: "gte",
        threshold: 1,
        minimumMatches: 1,
        excludeDialogue: true,
        patterns: [{ id: "marker", value: "一丝", flags: "u" }],
      },
    });
    const result = evaluateQualityCandidate({
      producer: "runtime",
      type: "runtime.prose",
      content: "一丝。",
    }, [advisoryRule]);
    expect(result.findings.map((finding) => finding.ruleId)).toEqual(["forced-document-metric"]);
    expect(result.blockingFindings).toEqual([]);
  });

  test("delivers document metric findings without entering Runtime rewrite", () => {
    const advisoryRule = detector("runtime-document-metric", "F3", "tier1", "stable", {
      kind: "metric",
      unit: "candidate",
      metric: {
        signal: "cliche_per_1000_chars",
        operator: "gte",
        threshold: 1,
        minimumMatches: 1,
        excludeDialogue: true,
        patterns: [{ id: "marker", value: "一丝", flags: "u" }],
      },
    });
    const runtime: QualityRuntimeContext = {
      packDirectory: "/fixture",
      packId: "prism-engine-v10",
      packVersion: "10.0.1-alpha.2",
      sourceCommit: "fixture",
      manifestSha256: "a".repeat(64),
      ruleManifest: parseRulePackManifest(ruleManifest({
        requiredCapabilities: ["quality-guard/anti-ai-flavor@1", "quality-detector/document-metrics@1"],
      })),
      rules: [advisoryRule],
      engineModes: { runtime: "rewrite" },
      agentModes: {},
    };
    const state = { attempts: 0, rejectedHashes: new Set<string>() };
    const result = evaluateBoundQuality({
      runtime,
      producer: "runtime",
      mode: "rewrite",
      content: "一丝。",
      attempt: 0,
      state,
    });
    expect(result).toMatchObject({ decision: "pass", outcome: "findings", action: "deliver" });
    expect(result?.event.findingIds).toEqual(["runtime-document-metric"]);
    expect(state.attempts).toBe(0);
    expect(state.rejectedHashes.size).toBe(0);
  });

  test("runs the published document metrics within the artifact candidate budget", async () => {
    const publishedRules = await loadBundledDetectorRules();
    const result = evaluateQualityCandidate({
      producer: "runtime",
      type: "runtime.prose",
      content: "甲".repeat(Math.floor(maxQualityArtifactBytes / 3)),
    }, publishedRules);
    expect(result.findings).toEqual([]);
    expect(result.detectorMs).toBeLessThan(2_000);
  }, 5_000);

  test("rejects unsupported Rule Pack and Detector contracts", () => {
    expect(() => parseRulePackManifest(ruleManifest({ preprocessing: {
      line_endings: "LF",
      unicode_normalization: "NFC",
      offset_basis: "original-candidate",
      protected_regions: ["markdown-fenced-code"],
    } }))).toThrow("preprocessing contract");
    expect(() => parseDetectorRules({
      schema: "detector-rules/v1",
      module: "anti-ai-flavor",
      language: "zh-CN",
      rules: [detector("bad", "F0", "tier1", "stable", { kind: "regex", value: "[", unit: "candidate", flags: "u" })],
    })).toThrow("regex is invalid");
    expect(() => parseRulePackManifest(ruleManifest({ sources: null }))).toThrow("sources must be a list");
    expect(() => parseRulePackManifest(ruleManifest({ corpora: "corrupt" }))).toThrow("corpora must be an object");
    expect(() => parseDetectorRules({
      schema: "detector-rules/v1",
      module: "anti-ai-flavor",
      language: "zh-CN",
      rules: [detector("unknown-metric", "F3", "tier3", "experimental", {
        kind: "metric",
        unit: "candidate",
        metric: { signal: "unknown_metric", operator: "gte", threshold: 1 },
      } as unknown as QualityDetectorRule["matcher"])],
    })).toThrow("metric signal is unsupported");
    expect(() => parseDetectorRules({
      schema: "detector-rules/v1",
      module: "anti-ai-flavor",
      language: "zh-CN",
      rules: [detector("incomplete-metric", "F3", "tier3", "experimental", {
        kind: "metric",
        unit: "candidate",
        metric: {
          signal: "cliche_per_1000_chars",
          operator: "gte",
          threshold: 1,
          excludeDialogue: true,
          patterns: [{ id: "empty", value: "(?:)", flags: "u" }],
        },
      } as unknown as QualityDetectorRule["matcher"])],
    })).toThrow("minimumMatches must be a positive integer");
    expect(() => parseDetectorRules({
      schema: "detector-rules/v1",
      module: "anti-ai-flavor",
      language: "zh-CN",
      rules: [detector("empty-pattern", "F3", "tier3", "experimental", {
        kind: "metric",
        unit: "candidate",
        metric: {
          signal: "cliche_per_1000_chars",
          operator: "gte",
          threshold: 1,
          minimumMatches: 1,
          excludeDialogue: true,
          patterns: [{ id: "empty", value: "(?:)", flags: "u" }],
        },
      })],
    })).toThrow("pattern must not match empty text");
    expect(() => parseDetectorRules({
      schema: "detector-rules/v1",
      module: "anti-ai-flavor",
      language: "zh-CN",
      rules: [detector("duplicate-pattern", "F3", "tier3", "experimental", {
        kind: "metric",
        unit: "candidate",
        metric: {
          signal: "cliche_per_1000_chars",
          operator: "gte",
          threshold: 1,
          minimumMatches: 1,
          excludeDialogue: true,
          patterns: [
            { id: "same", value: "一丝", flags: "u" },
            { id: "same", value: "一抹", flags: "u" },
          ],
        },
      })],
    })).toThrow("pattern ids must be unique");
    expect(() => parseDetectorRules({
      schema: "detector-rules/v1",
      module: "anti-ai-flavor",
      language: "zh-CN",
      rules: [detector("incomplete-action", "F3", "tier3", "experimental", {
        kind: "metric",
        unit: "paragraph",
        metric: {
          signal: "action_list_verbs_per_paragraph",
          operator: "gte",
          threshold: 5,
          minimumMatches: 5,
          excludeDialogue: true,
          patterns: [{ id: "action", value: "伸手", flags: "u" }],
        },
      })],
    })).toThrow("requires minimumSeparators");
  });
});

async function loadBundledDetectorRules(): Promise<QualityDetectorRule[]> {
  const paths = ["detector-rules.en-US.json", "detector-rules.zh-CN.json"];
  return (await Promise.all(paths.map(async (path) =>
    parseDetectorRules(JSON.parse(await readFile(join(bundledQualityDirectory, path), "utf8")) as unknown)
  ))).flat();
}

function detector(
  id: string,
  tier: string,
  severity: string,
  maturity: "stable" | "experimental",
  matcher: QualityDetectorRule["matcher"],
) {
  return {
    id,
    tier,
    lang: "zh-CN",
    title: id,
    severity,
    maturity,
    targets: ["narrative-prose"],
    matcher,
    source: "self",
  };
}

function ruleManifest(overrides: Record<string, unknown> = {}) {
  return {
    schema: "rule-pack/v1",
    module: "anti-ai-flavor",
    version: "0.2.1",
    primaryLanguage: "zh-CN",
    sourceRepository: "3aKHP/Neural-Narratology",
    sourceCommit: "1".repeat(40),
    sourceState: "clean",
    sourceHash: "a".repeat(64),
    moduleInputHash: "b".repeat(64),
    compilerHash: "c".repeat(64),
    ruleCount: 23,
    projectionCounts: { guidance: 21, detector: 6, judge: 21, replacement: 0 },
    requiredCapabilities: ["quality-guard/anti-ai-flavor@1"],
    preprocessing: {
      line_endings: "LF",
      unicode_normalization: "NFC",
      offset_basis: "normalized-candidate",
      protected_regions: [
        "markdown-fenced-code",
        "markdown-blockquote",
        "html-comment",
        "prism-hud",
        "host-provided-ranges",
      ],
    },
    sources: [],
    corpora: {},
    artifacts: {
      "schemas/rule-pack.schema.json": "d".repeat(64),
      "schemas/detector-rules.schema.json": "e".repeat(64),
      "schemas/host-conformance-case.schema.json": "f".repeat(64),
    },
    ...overrides,
  };
}
