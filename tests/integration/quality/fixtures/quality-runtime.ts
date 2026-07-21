import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runPrompt } from "../../../../src/core/agent-loop/run";
import type { AgentRunContext } from "../../../../src/core/agents/types";
import type { HarnessRuntimeContext } from "../../../../src/core/harness";
import { AssetResolver } from "../../../../src/core/runtime/assets";
import { type QualityDetectorRule, type QualityJudgeContract, type QualityRuntimeContext } from "../../../../src/core/quality";
import { OpenAIChatCompatibleAdapter } from "../../../../src/providers/openai-chat/adapter";
import type { ExperimentalQualityProfile } from "../../../../src/config/quality";

const originalFetch = globalThis.fetch;
const originalProvidersFile = process.env.VESICLE_PROVIDERS_FILE;
const originalQualityFile = process.env.VESICLE_QUALITY_FILE;
const roots: string[] = [];

export async function restoreQualityTestState(): Promise<void> {
  globalThis.fetch = originalFetch;
  if (originalProvidersFile === undefined) delete process.env.VESICLE_PROVIDERS_FILE;
  else process.env.VESICLE_PROVIDERS_FILE = originalProvidersFile;
  if (originalQualityFile === undefined) delete process.env.VESICLE_QUALITY_FILE;
  else process.env.VESICLE_QUALITY_FILE = originalQualityFile;
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
}
export async function createMixedExhaustedSession(root: string, prefix: string): Promise<string> {
  let requests = 0;
  globalThis.fetch = (async () => {
    requests += 1;
    if (requests === 1) return providerTools(`${prefix}-writes`, [
      { id: `${prefix}-a`, name: "write_file", arguments: JSON.stringify({ path: "workspace/a.md", content: "空气中弥漫着雨味。" }) },
      { id: `${prefix}-b`, name: "write_file", arguments: JSON.stringify({ path: "workspace/b.md", content: "空气中弥漫着尘味。" }) },
    ]);
    if (requests === 2) {
      await rm(join(root, "workspace", "a.md"));
    }
    return providerTool(`${prefix}-gate-${requests}`, "request_confirmation", { gate: "runtime-turn", summary: "Review." });
  }) as unknown as typeof fetch;
  const result = await runPrompt({
    input: "continue",
    engine: "runtime",
    rootDir: root,
    messages: [{ role: "user", content: "continue" }],
    harness: harnessRuntime(),
  });
  if (result.kind !== "needs_quality_decision") throw new Error("expected mixed exhausted quality decision");
  return result.sessionId;
}

export function providerTool(id: string, name: string, args: Record<string, unknown>, usage?: Record<string, number>): Response {
  return Response.json({
    id,
    choices: [{
      finish_reason: "tool_calls",
      message: {
        content: "",
        tool_calls: [{ id: `call-${id}`, type: "function", function: { name, arguments: JSON.stringify(args) } }],
      },
    }],
    ...(usage ? { usage } : {}),
  });
}

export function providerTools(id: string, calls: Array<{ id: string; name: string; arguments: string }>): Response {
  return Response.json({
    id,
    choices: [{
      finish_reason: "tool_calls",
      message: {
        content: "",
        tool_calls: calls.map((call) => ({
          id: call.id,
          type: "function",
          function: { name: call.name, arguments: call.arguments },
        })),
      },
    }],
  });
}

export async function runtimeRoot(engine: "runtime" | "dyad" | "weaver" | "weaver-orch" | "evaluate", stopGates: string[] = []): Promise<string> {
  const root = await baseRoot();
  await mkdir(join(root, "assets", "prompts", "engines"), { recursive: true });
  await mkdir(join(root, "assets", "engines"), { recursive: true });
  await writeFile(join(root, "assets", "prompts", "engines", `${engine}.md`), engine, "utf8");
  await writeFile(join(root, "assets", "engines", `${engine}.profile.yaml`), [
    `id: ${engine}`,
    `displayName: ${engine}`,
    "protocolVersion: v10",
    "systemPrompt:",
    "  - assets/prompts/shared/vesicle-base.md",
    `  - assets/prompts/engines/${engine}.md`,
    "defaultTools:",
    "  - write_file",
    "  - replace_in_file",
    "  - append_file",
    "validators: []",
    ...(stopGates.length ? ["stopGates:", ...stopGates.map((gate) => `  - ${gate}`)] : ["stopGates: []"]),
    "stateRoots:",
    "  - workspace",
    "",
  ].join("\n"), "utf8");
  return root;
}

export async function childRoot(): Promise<string> {
  const root = await baseRoot();
  await mkdir(join(root, "assets", "agents"), { recursive: true });
  await mkdir(join(root, "assets", "prompts", "agents"), { recursive: true });
  for (const profile of ["scene-writer", "chapter-reviewer"]) {
    await writeFile(join(root, "assets", "prompts", "agents", `${profile}.md`), profile, "utf8");
    await writeFile(join(root, "assets", "agents", `${profile}.agent.yaml`), [
      `id: ${profile}`,
      `displayName: ${profile}`,
      `description: ${profile}`,
      "systemPrompt:",
      `  - assets/prompts/agents/${profile}.md`,
      "tools:",
      "  - read_file",
      "  - write_file",
      "  - replace_in_file",
      "  - append_file",
      "contextMode: fresh",
      "modelPolicy: inherit",
      "defaultMode: foreground",
      "maxTurns: 2",
      "",
    ].join("\n"), "utf8");
  }
  return root;
}

export async function baseRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "vesicle-quality-runtime-"));
  roots.push(root);
  await mkdir(join(root, "assets", "prompts", "shared"), { recursive: true });
  await mkdir(join(root, "workspace"), { recursive: true });
  await writeFile(join(root, "assets", "prompts", "shared", "vesicle-base.md"), "base", "utf8");
  const config = join(root, "providers.yaml");
  await writeFile(config, [
    "default:",
    "  provider: test",
    "  model: test-model",
    "providers:",
    "  test:",
    "    protocol: openai-chat-compatible",
    "    baseUrl: https://provider.test/v1",
    "    apiKeyEnv: TEST_PROVIDER_KEY",
    "    models:",
    "      - test-model",
    "",
  ].join("\n"), "utf8");
  await writeFile(join(root, ".env"), "TEST_PROVIDER_KEY=test-key\n", "utf8");
  process.env.VESICLE_PROVIDERS_FILE = config;
  return root;
}

export function childContext(root: string, profileId: "scene-writer" | "chapter-reviewer"): AgentRunContext {
  return {
    runId: `run-${profileId}`,
    handle: `${profileId}-1`,
    spec: {
      profileId,
      description: profileId,
      prompt: "write",
      mode: "foreground",
      parentSessionId: "parent",
      parentToolCallId: `call-${profileId}`,
    },
    signal: new AbortController().signal,
    invocation: {
      rootDir: root,
      parentEngine: "weaver-orch",
      providerSelection: { provider: "test", model: "test-model" },
      parentToolDefinitions: [],
      parentSystemPrompt: "parent",
      parentMessages: [],
      assets: new AssetResolver(root),
      harness: harnessRuntime(),
    },
    onProgress: () => undefined,
    takeMessages: () => [],
    claimMutation: async () => undefined,
    registerChildSession: async () => undefined,
  };
}

export function harnessRuntime(options: { judge?: boolean } = {}): HarnessRuntimeContext {
  return {
    packId: "prism-engine-v10",
    packVersion: "10.0.1-alpha.1",
    sourceCommit: "fixture",
    manifestSha256: "a".repeat(64),
    driver: { schema: "prism-driver-contract/v1", id: "fixture", version: "1.0.0", engines: {}, agents: {} },
    adapter: { schema: "prism-host-adapter/v1", id: "fixture", version: "1.0.0", targetHost: "prism-vesicle", operationBindings: {}, interactionBindings: {} },
    quality: qualityRuntime(options),
  };
}

export function qualityRuntime(options: { judge?: boolean } = {}): QualityRuntimeContext {
  const judge: QualityJudgeContract = {
    rubric: "Judge only the supplied candidate and return JSON.",
    rules: [{
      id: "zh-f1-pov-leak",
      title: "POV leak",
      severity: "tier2",
      maturity: "stable",
      targets: ["narrative-prose"],
      source: "self",
      evidence: { mode: "exact-substring", minCodePoints: 1, maxCodePoints: 240 },
    }],
  };
  return {
    packDirectory: "/fixture",
    packId: "prism-engine-v10",
    packVersion: "10.0.1-alpha.1",
    sourceCommit: "fixture",
    manifestSha256: "a".repeat(64),
    ruleManifest: {
      schema: "rule-pack/v1",
      module: "anti-ai-flavor",
      version: "0.2.1",
      primaryLanguage: "zh-CN",
      sourceRepository: "fixture",
      sourceCommit: "fixture",
      sourceState: "clean",
      sourceHash: "b".repeat(64),
      moduleInputHash: "c".repeat(64),
      compilerHash: "d".repeat(64),
      ruleCount: 1,
      projectionCounts: { guidance: 0, detector: 1, judge: options.judge ? 1 : 0, replacement: 0 },
      requiredCapabilities: [
        "quality-guard/anti-ai-flavor@1",
        ...(options.judge ? ["quality-judge/anti-ai-flavor@1"] : []),
      ],
      preprocessing: {
        line_endings: "LF",
        unicode_normalization: "NFC",
        offset_basis: "normalized-candidate",
        protected_regions: ["markdown-fenced-code", "markdown-blockquote", "html-comment", "prism-hud", "host-provided-ranges"],
      },
      artifacts: {},
    },
    rules: [literalRule()],
    ...(options.judge ? { judge } : {}),
    engineModes: { runtime: "rewrite", weaver: "observe", "weaver-orch": "observe", dyad: "observe", evaluate: "analyze", etl: "off" },
    agentModes: { "scene-writer": "observe", "chapter-reviewer": "analyze", "continuity-editor": "off" },
  };
}

export function experimentalJudge(mode: "observe" | "rewrite"): ExperimentalQualityProfile {
  return {
    mode,
    provider: new OpenAIChatCompatibleAdapter({
      provider: "openai-chat-compatible",
      providerId: "judge-fixture",
      baseUrl: "https://example.test/v1",
      model: "judge-model",
      apiKey: "test-key",
    }),
    providerId: "judge-fixture",
    modelId: "judge-model",
    protocol: "openai-chat-compatible",
    judgeTimeoutMs: 15_000,
    configIdentity: "e".repeat(64),
    settingsPath: "/fixture/quality.yaml",
    temperatureSupported: true,
    reasoningTierSupported: false,
  };
}

export function qualityProviderConfig(baseUrl: string): string {
  return [
    "default:", "  provider: judge", "  model: judge-model", "providers:",
    "  judge:", "    protocol: openai-chat-compatible", `    baseUrl: ${baseUrl}`, "    apiKeyEnv: JUDGE_KEY", "    models:", "      - judge-model", "",
  ].join("\n");
}

export function literalRule(): QualityDetectorRule {
  return {
    id: "zh-f0-air-thick-with",
    tier: "F0",
    lang: "zh-CN",
    title: "air thick with",
    severity: "tier1",
    maturity: "stable",
    targets: ["narrative-prose"],
    matcher: { kind: "literal", value: "空气中弥漫着", unit: "candidate" },
    source: "self",
  };
}
