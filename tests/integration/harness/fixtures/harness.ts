import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentStore } from "../../../../src/core/agents/store";
import type { AgentInvocationContext } from "../../../../src/core/agents/types";
import {
  parseHarnessDriverContract,
  parseHarnessHostAdapter,
  type HarnessRuntimeContext,
} from "../../../../src/core/harness";
import { AssetResolver } from "../../../../src/core/runtime/assets";
export async function delegationFixture(): Promise<{
  root: string;
  store: AgentStore;
  invocation: AgentInvocationContext;
}> {
  const root = await mkdtemp(join(tmpdir(), "vesicle-harness-delegation-"));
  await mkdir(join(root, "assets", "agents"), { recursive: true });
  await mkdir(join(root, "assets", "prompts", "agents"), { recursive: true });
  await mkdir(join(root, "assets", "prompts", "shared"), { recursive: true });
  await mkdir(join(root, "assets", "prompts", "engines"), { recursive: true });
  await mkdir(join(root, "assets", "engines"), { recursive: true });
  await writeFile(join(root, "assets", "prompts", "agents", "base.md"), "base", "utf8");
  await writeFile(join(root, "assets", "prompts", "shared", "vesicle-base.md"), "base", "utf8");
  await writeFile(join(root, "assets", "prompts", "engines", "weaver-orch.md"), "weaver orch", "utf8");
  await writeFile(join(root, "assets", "engines", "weaver-orch.profile.yaml"), [
    "id: weaver-orch",
    "displayName: Weaver-Orch",
    "protocolVersion: v10",
    "systemPrompt:",
    "  - assets/prompts/shared/vesicle-base.md",
    "  - assets/prompts/engines/weaver-orch.md",
    "defaultTools:",
    "  - read_file",
    "validators: []",
    "stopGates: []",
    "stateRoots:",
    "  - workspace",
    "  - novels",
    "  - reports",
    "",
  ].join("\n"), "utf8");
  await mkdir(join(root, "workspace"), { recursive: true });
  for (const profile of ["scene-writer", "continuity-editor", "chapter-reviewer"]) {
    await writeFile(join(root, "assets", "prompts", "agents", `${profile}.md`), profile, "utf8");
    await writeFile(join(root, "assets", "agents", `${profile}.agent.yaml`), [
      `id: ${profile}`,
      `displayName: ${profile}`,
      `description: ${profile}`,
      "systemPrompt:",
      "  - assets/prompts/agents/base.md",
      `  - assets/prompts/agents/${profile}.md`,
      "tools:",
      "  - read_file",
      ...(profile === "scene-writer" ? ["  - write_file"] : []),
      "contextMode: fresh",
      "modelPolicy: inherit",
      "defaultMode: foreground",
      "maxTurns: 4",
      "",
    ].join("\n"), "utf8");
  }
  const assets = new AssetResolver(root);
  return {
    root,
    store: new AgentStore(root),
    invocation: {
      rootDir: root,
      parentEngine: "weaver-orch",
      parentToolDefinitions: [],
      parentSystemPrompt: "parent",
      parentMessages: [],
      harness: harnessRuntime(),
      assets,
    },
  };
}

export async function configureFixtureProvider(root: string): Promise<void> {
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
}

export function testConfig() {
  return {
    provider: "openai-chat-compatible" as const,
    providerId: "test",
    baseUrl: "https://provider.test/v1",
    model: "test-model",
  };
}

export function emptyMcp() {
  return {
    definitions: [],
    statuses: [],
    hasTool: () => false,
    execute: async () => { throw new Error("unexpected MCP call"); },
  };
}

export function weaverOrchProfile() {
  return {
    id: "weaver-orch" as const,
    displayName: "Weaver-Orch",
    protocolVersion: "v10",
    systemPrompt: [],
    defaultTools: [],
    validators: [],
    stopGates: [],
    stateRoots: ["workspace", "novels", "reports"],
    asset: { path: "assets/engines/weaver-orch.profile.yaml", source: "project" as const },
  };
}

export function harnessRuntime(): HarnessRuntimeContext {
  return {
    packId: "prism-engine-v10",
    packVersion: "10.0.1-alpha.1",
    sourceCommit: "fixture-source",
    manifestSha256: "a".repeat(64),
    identity: {
      packId: "prism-engine-v10",
      packVersion: "10.0.1-alpha.1",
      sourceCommit: "fixture-source",
      manifestSha256: "a".repeat(64),
      adapterId: "vesicle-v1",
      adapterVersion: "1.0.0",
      adapterHash: "b".repeat(64),
    },
    driver: parseHarnessDriverContract({
      schema: "prism-driver-contract/v1",
      id: "prism-engine-v10",
      version: "10.0.1-alpha.1",
      agents: Object.fromEntries(["scene-writer", "continuity-editor", "chapter-reviewer"].map((agent) => [agent, {
        operations: ["artifact.inspect"],
        defaultMode: "foreground",
      }])),
      engines: {
        "weaver-orch": {
          operations: ["agent.delegate", "interaction.select"],
          delegations: [
            { id: "weaver-orch.scene-writer", agent: "scene-writer", mode: "foreground", purpose: "Write one scene.", retryLimit: 1 },
            { id: "weaver-orch.continuity", agent: "continuity-editor", mode: "foreground", purpose: "Synchronize state.", retryLimit: 1 },
            { id: "weaver-orch.chapter-review", agent: "chapter-reviewer", mode: "foreground", purpose: "Review one chapter.", retryLimit: 1 },
          ],
          interactions: [{
            id: "weaver-orch.agent-failure",
            operation: "interaction.select",
            purpose: "Choose how to recover after the declared retry limit is exhausted.",
            options: [
              { id: "retry", label: "Retry", description: "Authorize one more attempt." },
              { id: "manual-repair", label: "Manual repair", description: "Wait for user repairs." },
              { id: "abort", label: "Abort chapter", description: "Stop the current chapter." },
            ],
          }],
        },
      },
    }),
    adapter: parseHarnessHostAdapter({
      schema: "prism-host-adapter/v1",
      id: "vesicle-v1",
      version: "1.0.0",
      targetHost: "Prism Vesicle",
      operationBindings: {
        "agent.delegate": { kind: "interaction-tool", tool: "spawn_agent" },
        "interaction.select": { kind: "interaction-tool", tool: "ask_user_question" },
      },
      interactionBindings: {
        "weaver-orch.agent-failure": { header: "Subtask failure" },
      },
    }),
  };
}

export function spawnCall(id: string, profile: string) {
  return {
    id,
    name: "spawn_agent",
    arguments: JSON.stringify({
      profile,
      description: `Delegate ${profile}`,
      prompt: `Complete ${profile} deliverable.`,
      mode: "foreground",
    }),
  };
}
