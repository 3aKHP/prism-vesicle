import { describe, expect, test } from "bun:test";
import {
  evaluateQualityCandidate,
  parseDetectorRules,
  parseRulePackManifest,
  type QualityCandidateType,
  type QualityDetectorRule,
  type QualityProtectedRange,
} from "../src/core/quality";

const publishedCases: Array<{
  name: string;
  candidateType: QualityCandidateType;
  text: string;
  protectedRanges?: QualityProtectedRange[];
  expectedRuleIds: string[];
}> = [
  { name: "runtime-literal-detection", candidateType: "runtime.prose", text: "空气中弥漫着潮湿的铁锈味。", expectedRuleIds: ["zh-f0-air-thick-with"] },
  { name: "dyad-skeleton-detection", candidateType: "dyad.character-response", text: "这不是迟疑，而是她终于承认自己害怕。", expectedRuleIds: ["zh-f1-not-x-but-y"] },
  { name: "scene-protected-fence-and-hud", candidateType: "scene.prose", text: "```text\n空气中弥漫着旧例。\n```\n[Beat] Opening | 不是退让，而是试探\n她把湿透的袖口卷到肘上。", expectedRuleIds: [] },
  { name: "host-provided-inline-protection", candidateType: "audit.target-prose", text: "审计示例：空气中弥漫着。正文没有问题。", protectedRanges: [{ start: 5, end: 11 }], expectedRuleIds: [] },
  { name: "crlf-normalization", candidateType: "runtime.prose", text: "门轴响了一声。\r\n空气中弥漫着雨味。", expectedRuleIds: ["zh-f0-air-thick-with"] },
  { name: "experimental-em-dash-metric", candidateType: "scene.prose", text: "她——停住——回头——又把手缩了回去。", expectedRuleIds: ["zh-f3-emdash-density"] },
  { name: "clean-orchestrator-prose", candidateType: "orchestrator-authored-prose", text: "三段场景已经合并。她在末段关掉走廊的灯，下一章从清晨开始。", expectedRuleIds: [] },
  { name: "quoted-report-text-exclusion", candidateType: "audit.target-prose", text: "> 报告引用：空气中弥漫着旧例。\n\n本段只记录审计结论。", expectedRuleIds: [] },
];

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
  for (const fixture of publishedCases) {
    test(`matches published host conformance case: ${fixture.name}`, () => {
      const result = evaluateQualityCandidate({
        producer: "runtime",
        type: fixture.candidateType,
        content: fixture.text,
        protectedRanges: fixture.protectedRanges,
      }, rules);
      expect([...new Set(result.findings.map((finding) => finding.ruleId))]).toEqual(fixture.expectedRuleIds);
    });
  }

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
  });
});

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
