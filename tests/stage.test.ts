import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import { loadConfigForSelection } from "../src/config/providers";
import { resolveToolSurface } from "../src/core/agent-loop/tool-surface";
import { loadEngineProfile } from "../src/core/engine/profile";
import { runPrompt } from "../src/core/agent-loop/run";
import { stageSourceDrift, startStageSession } from "../src/core/stage/bootstrap";
import { loadSessionSnapshot } from "../src/core/session/store";
import { createProvider } from "../src/providers";

const originalFetch = globalThis.fetch;
const originalProvidersFile = process.env.VESICLE_PROVIDERS_FILE;
const providerConfigDirs: string[] = [];

afterEach(async () => {
  globalThis.fetch = originalFetch;
  if (originalProvidersFile === undefined) delete process.env.VESICLE_PROVIDERS_FILE;
  else process.env.VESICLE_PROVIDERS_FILE = originalProvidersFile;
  await Promise.all(providerConfigDirs.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("Stage bootstrap", () => {
  test("freezes guarded cards into the system prompt and opening assistant record", async () => {
    const root = await mkdtemp(join(tmpdir(), "vesicle-stage-"));
    try {
      await mkdir(join(root, "workspace"), { recursive: true });
      await writeFile(join(root, "workspace", "character.md"), characterCard, "utf8");
      await writeFile(join(root, "workspace", "scenario.md"), scenarioCard, "utf8");

      const started = await startStageSession({
        rootDir: root,
        characterPath: "workspace/character.md",
        scenarioPath: "workspace/scenario.md",
        provider: "fixture",
        providerId: "fixture",
        model: "fixture-model",
        permissionMode: "MOMENTUM",
      });
      const snapshot = await loadSessionSnapshot(root, started.sessionId);

      expect(started.systemPrompt).toContain("CHARACTER CONTEXT (HOST-INJECTED)");
      expect(started.systemPrompt).toContain("**Lin** · Watcher · adult");
      expect(started.opening).toContain("雨落在空站台上");
      expect(started.opening).toContain("Scene Premise");
      expect(snapshot.engine).toBe("stage");
      expect(snapshot.messages).toEqual([{ role: "assistant", content: started.opening, engine: "stage", kind: "stage-bootstrap-opening" }]);
      expect(snapshot.stageBootstrap?.renderedCharacterContext).toContain("## World Context");
      expect(snapshot.stageBootstrap?.character.sha256).toHaveLength(64);
      expect(await stageSourceDrift(root, snapshot.stageBootstrap!)).toEqual([]);

      await writeFile(join(root, "workspace", "character.md"), `${characterCard}\nChanged.\n`, "utf8");
      expect(await stageSourceDrift(root, snapshot.stageBootstrap!)).toEqual(["workspace/character.md"]);
      expect(await readFile(join(root, ".vesicle", "sessions", `${started.sessionId}.jsonl`), "utf8")).toContain("stage-bootstrap-opening");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("rejects invalid cards and paths before it creates a session", async () => {
    const root = await mkdtemp(join(tmpdir(), "vesicle-stage-invalid-"));
    try {
      await mkdir(join(root, "workspace"), { recursive: true });
      await writeFile(join(root, "workspace", "bad.md"), "not a card", "utf8");
      await expect(startStageSession({
        rootDir: root,
        characterPath: "../bad.md",
        scenarioPath: "workspace/bad.md",
        provider: "fixture",
        providerId: "fixture",
        model: "fixture-model",
        permissionMode: "MOMENTUM",
      })).rejects.toThrow("Path");
      await expect(startStageSession({
        rootDir: root,
        characterPath: "workspace/bad.md",
        scenarioPath: "workspace/bad.md",
        provider: "fixture",
        providerId: "fixture",
        model: "fixture-model",
        permissionMode: "MOMENTUM",
      })).rejects.toThrow("Stage startup rejected");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("has no model-visible tools, including optional host integrations", async () => {
    const profile = await loadEngineProfile("stage");
    const surface = await resolveToolSurface(profile, true, true, "auto");
    expect(surface.definitions).toEqual([]);
  });

  test("sends the frozen opening before the first player action with no tool surface", async () => {
    const root = await stageRoot();
    const requests: Array<{ messages: Array<{ role: string; content: string }>; tools?: unknown[] }> = [];
    try {
      const started = await startStageSession({
        rootDir: root,
        characterPath: "workspace/character.md",
        scenarioPath: "workspace/scenario.md",
        provider: "test",
        providerId: "test",
        model: "test-model",
        permissionMode: "MOMENTUM",
      });
      globalThis.fetch = (async (_input: unknown, init: RequestInit & { body?: unknown }) => {
        requests.push(JSON.parse(String(init.body)));
        if (requests.length === 1) {
          return Response.json({ id: "stage-unavailable-question", choices: [{ message: {
            content: "",
            tool_calls: [{
              id: "stage-question",
              type: "function",
              function: { name: "ask_user_question", arguments: '{\"header\":\"Choose\",\"question\":\"Continue?\",\"options\":[{\"label\":\"Yes\",\"description\":\"Continue\"},{\"label\":\"No\",\"description\":\"Stop\"}]}' },
            }],
          } }] });
        }
        return Response.json({ id: "stage-complete", choices: [{ message: { content: stagePacket } }] });
      }) as unknown as typeof fetch;

      const result = await runPrompt({
        input: "I step beneath the umbrella.",
        engine: "stage",
        rootDir: root,
        sessionId: started.sessionId,
        messages: [...started.messages, { role: "user", content: "I step beneath the umbrella." }],
      });

      if (result.kind !== "complete") throw new Error(`expected complete Stage turn, got ${result.kind}`);
      expect(requests).toHaveLength(2);
      expect(requests[0]?.tools).toBeUndefined();
      expect(requests[0]?.messages.slice(1).map((message) => message.content)).toEqual([
        started.opening,
        "I step beneath the umbrella.",
      ]);
      expect(result.validation?.ok).toBe(true);
      const snapshot = await loadSessionSnapshot(root, started.sessionId);
      expect(snapshot.qualityEvents.at(-1)).toMatchObject({ candidateType: "stage.prose", decision: "pass" });
      expect(snapshot.qualityEvents.at(-1)?.candidateHash).not.toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("rejects attempts to create an unbootstrapped Stage session", async () => {
    const root = await stageRoot();
    try {
      await expect(runPrompt({ input: "start", engine: "stage", rootDir: root }))
        .rejects.toThrow("Stage sessions must start with /stage");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("allows the explicitly enabled Semantic Judge to request a bounded Stage rewrite", async () => {
    const root = await stageRoot();
    let engineRequests = 0;
    let judgeRequests = 0;
    try {
      const started = await startStageSession({
        rootDir: root,
        characterPath: "workspace/character.md",
        scenarioPath: "workspace/scenario.md",
        provider: "test",
        providerId: "test",
        model: "test-model",
        permissionMode: "MOMENTUM",
      });
      const judgeConfig = await loadConfigForSelection({ provider: "test", model: "test-model" });
      globalThis.fetch = (async (_input: unknown, init: RequestInit & { body?: unknown }) => {
        const body = JSON.parse(String(init.body)) as { messages?: Array<{ content?: string }> };
        if (body.messages?.[0]?.content?.includes("quality-judge-result/v1")) {
          judgeRequests += 1;
          return Response.json({ id: `stage-judge-${judgeRequests}`, choices: [{ message: { content: JSON.stringify(
            judgeRequests === 1
              ? { schema: "quality-judge-result/v1", verdict: "rewrite", confidence: 0.9, findings: [{ ruleId: "zh-f1-pov-leak", evidence: "她不知道", confidence: 0.9, explanation: "POV leak", rewriteInstruction: "Use observable detail." }] }
              : { schema: "quality-judge-result/v1", verdict: "pass", confidence: 0.9, findings: [] },
          ) } }] });
        }
        engineRequests += 1;
        return Response.json({ id: `stage-engine-${engineRequests}`, choices: [{ message: {
          content: engineRequests === 1 ? stagePacketWithPovLeak : stagePacket,
        } }] });
      }) as unknown as typeof fetch;

      const result = await runPrompt({
        input: "I wait beside her.",
        engine: "stage",
        rootDir: root,
        sessionId: started.sessionId,
        messages: [...started.messages, { role: "user", content: "I wait beside her." }],
        experimentalQuality: {
          mode: "rewrite",
          provider: createProvider(judgeConfig),
          providerId: "stage-judge",
          modelId: "test-model",
          protocol: judgeConfig.provider,
          judgeTimeoutMs: 15_000,
          configIdentity: "e".repeat(64),
          settingsPath: "quality.yaml",
          temperatureSupported: true,
          reasoningTierSupported: false,
        },
      });

      expect(result).toMatchObject({ kind: "complete", response: { content: stagePacket } });
      expect({ engineRequests, judgeRequests }).toEqual({ engineRequests: 2, judgeRequests: 2 });
      const snapshot = await loadSessionSnapshot(root, started.sessionId);
      expect(snapshot.qualityEvents.map((event) => event.decision)).toEqual(["rewrite", "pass"]);
      expect(snapshot.qualityEvents[0]).toMatchObject({ candidateType: "stage.prose", experimentalJudge: { mode: "rewrite", providerId: "stage-judge" } });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

async function stageRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "vesicle-stage-provider-"));
  const config = await mkdtemp(join(tmpdir(), "vesicle-stage-config-"));
  providerConfigDirs.push(config);
  await mkdir(join(root, "workspace"), { recursive: true });
  await writeFile(join(root, "workspace", "character.md"), characterCard, "utf8");
  await writeFile(join(root, "workspace", "scenario.md"), scenarioCard, "utf8");
  await writeFile(join(config, "providers.yaml"), [
    "default:",
    "  provider: test",
    "  model: test-model",
    "providers:",
    "  test:",
    "    protocol: openai-chat-compatible",
    "    baseUrl: https://provider.test/v1",
    "    apiKeyEnv: STAGE_TEST_KEY",
    "    models:",
    "      - test-model",
    "",
  ].join("\n"), "utf8");
  await writeFile(join(config, ".env"), "STAGE_TEST_KEY=test-key\n", "utf8");
  process.env.VESICLE_PROVIDERS_FILE = join(config, "providers.yaml");
  return root;
}

const characterCard = `---
name: Lin
archetype: Watcher
age_gender: adult
inventory: old umbrella
---

## Visual Cortex
Rain-dark hair and a worn coat.

## Biography
She has waited at this station for years.

## Cognitive Stack
- Invariant: she notices every departure.
- Variant: her guarded voice softens when trust opens.

## Instinct Protocol
She reaches for shelter before speaking.

## Persona Topology

### Invariant Axes
- She protects a promise.
- She does not lie about danger.

### Variant Axes
- Under increasing tension, reserve shifts toward openness.
- Under increasing tension, caution shifts toward warmth.
- Under increasing tension, silence shifts toward honest speech.

### Boundary Conditions
- Hard limit: she never abandons a child.

## Narrative Engine
Close sensory detail and deliberate pauses.

## World Context
A rain-soaked city where trains still remember names.
`;

const scenarioCard = `---
scenario_name: Last Train
tags: [rain]
world_state: The final train is delayed.
beat_map:
  - label: Arrival
    tension_target: 40
    variant_config: guarded
    pivot_condition: The player asks why she waits.
  - label: Confession
    tension_target: 70
    variant_config: opening
    pivot_condition: The train lights appear.
  - label: Choice
    tension_target: 65
    variant_config: resolve
    pivot_condition: Someone steps aboard.
---

雨落在空站台上，Lin 把伞向你倾斜了一寸，像把迟疑也一并让了出来。

"别错过最后一班车。"

<!--
## Scene Premise
The player arrives at a deserted station before the last train.

## Neural State
- **Surface emotion:** guarded hope
- **Tension source:** the train may never arrive
- **Active lens:** rain and waiting

## User Role
- **Identity:** a late traveler
- **Immediate goal:** learn why Lin remains
-->
`;

const stagePacket = `<!--[!Neural Chain]
Perception: Rain blurs the platform lights.
Instinct: She angles the umbrella closer.
State: guarded hope
Strategy: Let the silence hold for one breath.
-->
【Status】
[Space-Time] Night | rain-dark platform
[Physical] Cold fingers | shared umbrella | worn coat
[Psychology] Tension: 40 (waiting) | Lens: rain and waiting
[Beat] Arrival
[Impression] The player has not left her alone in the rain.

Rain tapped softly against the umbrella as Lin made room beside her.`;

const stagePacketWithPovLeak = stagePacket.replace(
  "Rain tapped softly against the umbrella as Lin made room beside her.",
  "她不知道，雨已经沿着站台边缘漫开。",
);
