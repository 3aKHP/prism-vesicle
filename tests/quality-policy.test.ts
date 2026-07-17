import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  evaluateSemanticRewritePolicy,
  loadQualityRuntime,
  parseSemanticRewritePolicy,
  type QualityFinding,
  type QualityJudgeRule,
} from "../src/core/quality";

const judgeRules: QualityJudgeRule[] = [{
  id: "zh-f1-pov-leak",
  title: "POV leak",
  severity: "tier2",
  maturity: "stable",
  targets: ["narrative-prose"],
  source: "self",
  evidence: { mode: "exact-substring", minCodePoints: 1, maxCodePoints: 240 },
}];

describe("Semantic Rewrite Policy", () => {
  test("parses the inactive fixture shape without enabling it", () => {
    const policy = parseSemanticRewritePolicy(policyFixture({ activation: "inactive" }), judgeRules);
    expect(policy).toMatchObject({
      activation: "inactive",
      blockingRuleIds: ["zh-f1-pov-leak"],
      onUnknownModel: "observe",
      onInconclusive: "observe",
    });
  });

  test("fails closed on malformed rule, confidence, scope, and calibration contracts", () => {
    expect(() => parseSemanticRewritePolicy(policyFixture({ blockingRuleIds: ["unknown-rule"] }), judgeRules))
      .toThrow("blocking rule is unsupported");
    expect(() => parseSemanticRewritePolicy(policyFixture({ minimumConfidenceByRule: { "zh-f1-pov-leak": 0.9, extra: 0.9 } }), judgeRules))
      .toThrow("confidence rules must exactly match");
    expect(() => parseSemanticRewritePolicy(policyFixture({ modelScopes: [{ protocol: "openai-chat-compatible", modelFamily: "fixture", modelIds: ["fixture-model"] }, { protocol: "openai-chat-compatible", modelFamily: "duplicate", modelIds: ["fixture-model"] }] }), judgeRules))
      .toThrow("model scopes must not overlap");
    expect(() => parseSemanticRewritePolicy(policyFixture({ calibration: { corpusSha256: "short", reportSha256: "b".repeat(64), thresholdVersion: "v1" } }), judgeRules))
      .toThrow("corpusSha256 must be a SHA-256 hash");
  });

  test("keeps inactive and inconclusive Judge results out of rewrite eligibility", () => {
    const inactive = parseSemanticRewritePolicy(policyFixture({ activation: "inactive" }), judgeRules);
    expect(evaluateSemanticRewritePolicy({
      policy: inactive,
      judgeStatus: "valid",
      candidateType: "runtime.prose",
      protocol: "openai-chat-compatible",
      modelId: "fixture-model",
      findings: [judgeFinding()],
    })).toEqual({ decision: "observe", findings: [] });
    const active = parseSemanticRewritePolicy(policyFixture(), judgeRules);
    expect(evaluateSemanticRewritePolicy({
      policy: active,
      judgeStatus: "invalid",
      candidateType: "runtime.prose",
      protocol: "openai-chat-compatible",
      modelId: "fixture-model",
      findings: [judgeFinding()],
    })).toEqual({ decision: "inconclusive", findings: [] });
  });

  test("requires an exact configured protocol and model match before an eligible finding", () => {
    const policy = parseSemanticRewritePolicy(policyFixture(), judgeRules);
    const matching = {
      policy,
      judgeStatus: "valid" as const,
      candidateType: "runtime.prose" as const,
      protocol: "openai-chat-compatible" as const,
      modelId: "fixture-model",
      findings: [judgeFinding()],
    };
    expect(evaluateSemanticRewritePolicy(matching)).toMatchObject({ decision: "eligible", findings: [{ ruleId: "zh-f1-pov-leak" }] });
    expect(evaluateSemanticRewritePolicy({ ...matching, protocol: "anthropic-messages" })).toEqual({ decision: "observe", findings: [] });
    expect(evaluateSemanticRewritePolicy({ ...matching, modelId: "another-model" })).toEqual({ decision: "observe", findings: [] });
    expect(evaluateSemanticRewritePolicy({ ...matching, findings: [judgeFinding({ confidence: 0.89 })] })).toEqual({ decision: "observe", findings: [] });
  });

  test("loads an active required policy and rejects an inactive required artifact", async () => {
    const active = await qualityRuntimeWithPolicy();
    try {
      await expect(loadQualityRuntime(active.source)).resolves.toMatchObject({
        semanticRewritePolicy: { activation: "active", blockingRuleIds: ["zh-f1-pov-leak"] },
      });
    } finally {
      await rm(active.root, { recursive: true, force: true });
    }

    const inactive = await qualityRuntimeWithPolicy({ activation: "inactive" });
    try {
      await expect(loadQualityRuntime(inactive.source)).rejects.toThrow("must be active when its capability is required");
    } finally {
      await rm(inactive.root, { recursive: true, force: true });
    }
  });

  test("ignores an inactive policy artifact when the Rule Pack does not require its capability", async () => {
    const fixture = await qualityRuntimeWithPolicy({ activation: "inactive" }, false);
    try {
      const runtime = await loadQualityRuntime(fixture.source);
      expect(runtime.judge?.rules.map((rule) => rule.id)).toContain("zh-f1-pov-leak");
      expect(runtime.semanticRewritePolicy).toBeUndefined();
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });
});

function policyFixture(overrides: Record<string, unknown> = {}) {
  return {
    schema: "quality-semantic-rewrite-policy/v1",
    module: "anti-ai-flavor",
    policyVersion: "quality-policy/v2",
    activation: "active",
    targetTypes: ["runtime.prose"],
    blockingRuleIds: ["zh-f1-pov-leak"],
    minimumConfidenceByRule: { "zh-f1-pov-leak": 0.9 },
    modelScopes: [{ protocol: "openai-chat-compatible", modelFamily: "fixture", modelIds: ["fixture-model"] }],
    onUnknownModel: "observe",
    onInconclusive: "observe",
    multiTargetAction: "inconclusive",
    calibration: { corpusSha256: "a".repeat(64), reportSha256: "b".repeat(64), thresholdVersion: "v1" },
    ...overrides,
  };
}

function judgeFinding(overrides: Partial<QualityFinding> = {}): QualityFinding {
  return {
    ruleId: "zh-f1-pov-leak",
    title: "POV leak",
    severity: "tier2",
    maturity: "stable",
    start: 0,
    end: 3,
    evidence: "她不知道",
    source: "judge",
    confidence: 0.9,
    ...overrides,
  };
}

async function qualityRuntimeWithPolicy(overrides: Record<string, unknown> = {}, requiresCapability = true) {
  const root = await mkdtemp(join(tmpdir(), "vesicle-semantic-policy-"));
  const moduleDirectory = join(root, "assets", "quality", "anti-ai-flavor");
  await cp(join(import.meta.dir, "..", "assets", "quality", "anti-ai-flavor"), moduleDirectory, { recursive: true });
  const manifestPath = join(moduleDirectory, "manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
    requiredCapabilities: string[];
    artifacts: Record<string, string>;
  };
  const policy = `${JSON.stringify(policyFixture(overrides), null, 2)}\n`;
  const schema = `${JSON.stringify(policySchema(), null, 2)}\n`;
  await writeFile(join(moduleDirectory, "data", "semantic-rewrite-policy.json"), policy, "utf8");
  await writeFile(join(moduleDirectory, "schemas", "semantic-rewrite-policy.schema.json"), schema, "utf8");
  if (requiresCapability) manifest.requiredCapabilities.push("quality-policy/semantic-rewrite@1");
  manifest.artifacts["data/semantic-rewrite-policy.json"] = sha256(policy);
  manifest.artifacts["schemas/semantic-rewrite-policy.schema.json"] = sha256(schema);
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  return {
    root,
    source: {
      directory: root,
      manifestSha256: "a".repeat(64),
      manifest: {
        id: "prism-engine-v10",
        version: "10.0.1-alpha.5",
        sourceCommit: "b".repeat(40),
        ruleModules: [{ id: "anti-ai-flavor", manifest: "assets/quality/anti-ai-flavor/manifest.json" }],
        qualityBindings: {},
        agentQualityBindings: {},
      },
    } as Parameters<typeof loadQualityRuntime>[0],
  };
}

function policySchema() {
  return {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    title: "Semantic Rewrite Policy v1",
    type: "object",
    additionalProperties: false,
    required: [
      "schema", "module", "policyVersion", "activation", "targetTypes", "blockingRuleIds",
      "minimumConfidenceByRule", "modelScopes", "onUnknownModel", "onInconclusive", "multiTargetAction", "calibration",
    ],
    properties: {
      schema: { const: "quality-semantic-rewrite-policy/v1" },
      module: { const: "anti-ai-flavor" },
      policyVersion: { const: "quality-policy/v2" },
      activation: { enum: ["inactive", "active"] },
      targetTypes: { type: "array", minItems: 1, items: { enum: ["runtime.prose"] }, uniqueItems: true },
      blockingRuleIds: {
        type: "array",
        minItems: 1,
        items: { type: "string", pattern: "^[a-z0-9]+(?:-[a-z0-9]+)*$" },
        uniqueItems: true,
      },
      minimumConfidenceByRule: {
        type: "object",
        minProperties: 1,
        additionalProperties: { type: "number", minimum: 0, maximum: 1 },
        propertyNames: { pattern: "^[a-z0-9]+(?:-[a-z0-9]+)*$" },
      },
      modelScopes: {
        type: "array",
        minItems: 1,
        items: {
          type: "object",
          additionalProperties: false,
          required: ["protocol", "modelFamily", "modelIds"],
          properties: {
            protocol: { enum: ["openai-chat-compatible", "anthropic-messages", "gemini-generate-content"] },
            modelFamily: { type: "string", minLength: 1 },
            modelIds: { type: "array", minItems: 1, items: { type: "string", minLength: 1 }, uniqueItems: true },
          },
        },
      },
      onUnknownModel: { const: "observe" },
      onInconclusive: { const: "observe" },
      multiTargetAction: { enum: ["inconclusive", "rewrite-with-warning"] },
      calibration: {
        type: "object",
        additionalProperties: false,
        required: ["corpusSha256", "reportSha256", "thresholdVersion"],
        properties: {
          corpusSha256: { type: "string", pattern: "^[a-f0-9]{64}$" },
          reportSha256: { type: "string", pattern: "^[a-f0-9]{64}$" },
          thresholdVersion: { type: "string", minLength: 1 },
        },
      },
    },
  };
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
