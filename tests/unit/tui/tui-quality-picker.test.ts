import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRoot } from "solid-js";
import { createQualityPickerController, resolveQualityCandidate } from "../../../src/tui/quality-picker-controller";
import { qualityRewritePanelHeight } from "../../../src/tui/QualityRewritePrompt";
import { loadExperimentalQualitySettings } from "../../../src/config/quality";
import type { ProviderRegistry } from "../../../src/config/providers";

const originalProvidersFile = process.env.VESICLE_PROVIDERS_FILE;
const originalQualityFile = process.env.VESICLE_QUALITY_FILE;
const directories: string[] = [];

afterEach(async () => {
  if (originalProvidersFile === undefined) delete process.env.VESICLE_PROVIDERS_FILE;
  else process.env.VESICLE_PROVIDERS_FILE = originalProvidersFile;
  if (originalQualityFile === undefined) delete process.env.VESICLE_QUALITY_FILE;
  else process.env.VESICLE_QUALITY_FILE = originalQualityFile;
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

const registry: ProviderRegistry = {
  source: "file",
  default: { provider: "alpha", model: "alpha-chat" },
  providers: [
    { id: "alpha", protocol: "openai-chat-compatible", baseUrl: "https://alpha.example/v1", apiKeyEnv: "ALPHA_KEY", models: [{ id: "alpha-chat" }] },
    { id: "beta", protocol: "openai-chat-compatible", baseUrl: "https://beta.example/v1", apiKeyEnv: "BETA_KEY", models: [{ id: "beta-reasoner" }] },
  ],
};

describe("resolveQualityCandidate", () => {
  test("prefers a retained tuple that still resolves; falls back to the active provider/model", () => {
    const retained = resolveQualityCandidate(
      { mode: "off", providerAlias: "alpha", modelId: "alpha-chat", judgeTimeoutMs: 12_000 },
      registry, "beta", "beta-reasoner",
    );
    expect(retained.candidate).toEqual({ providerAlias: "alpha", modelId: "alpha-chat", judgeTimeoutMs: 12_000 });
    expect(retained.source).toBe("retained");
  });

  test("does not silently substitute another model for a stale retained tuple", () => {
    const stale = resolveQualityCandidate(
      { mode: "off", providerAlias: "alpha", modelId: "gone", judgeTimeoutMs: 12_000 },
      registry, "beta", "beta-reasoner",
    );
    expect(stale.candidate).toEqual({ providerAlias: "beta", modelId: "beta-reasoner", judgeTimeoutMs: 15_000 });
    expect(stale.source).toBe("active");
    // The stale tuple is preserved for explanation, not silently swapped in.
    expect(stale.currentTuple).toEqual({ providerAlias: "alpha", modelId: "gone", judgeTimeoutMs: 12_000 });
  });
});

describe("quality picker controller", () => {
  test("openQualityPicker initializes the mode selection at the current mode", async () => {
    await fixture({ mode: "observe", providerAlias: "alpha", modelId: "alpha-chat", timeoutMs: 12_000 });
    const controller = makeController();
    await controller.openQualityPicker();
    const picker = controller.qualityPicker();
    expect(picker?.step).toBe("mode");
    expect(picker?.selected).toBe(1); // Review only (observe) is focused, not Off
    expect(picker?.currentMode).toBe("observe");
  });

  test("Change Judge browsing does not write or enable a mode", async () => {
    await fixture({ mode: "off" });
    const controller = makeController();
    await controller.openQualityPicker();
    // Move from Off (0) to Change Judge (3): three Down presses.
    controller.handleQualityPickerKey({ name: "down" });
    controller.handleQualityPickerKey({ name: "down" });
    controller.handleQualityPickerKey({ name: "down" });
    controller.handleQualityPickerKey({ name: "return" });
    expect(controller.qualityPicker()?.step).toBe("provider");
    // Browsing providers/models must not persist anything.
    expect((await loadExperimentalQualitySettings()).mode).toBe("off");
    controller.handleQualityPickerKey({ name: "return" }); // pick first provider → model step
    expect(controller.qualityPicker()?.step).toBe("model");
    controller.handleQualityPickerKey({ name: "escape" }); // model → provider
    controller.handleQualityPickerKey({ name: "escape" }); // provider → mode
    expect(controller.qualityPicker()?.step).toBe("mode");
    expect((await loadExperimentalQualitySettings()).mode).toBe("off");
  });

  test("two Enters on the rewrite confirm write the staged profile once", async () => {
    await fixture({ mode: "off" });
    const controller = makeController();
    await controller.openRewriteConfirm({ providerAlias: "alpha", modelId: "alpha-chat", judgeTimeoutMs: 15_000 });
    expect(controller.qualityRewriteConfirm()?.stage).toBe(1);
    expect(controller.handleRewriteConfirmKey({ name: "return" })).toBe(true);
    expect(controller.qualityRewriteConfirm()?.stage).toBe(2);
    expect(controller.handleRewriteConfirmKey({ name: "return" })).toBe(true);
    await waitUntil(() => controller.qualityRewriteConfirm() === null);
    expect(await loadExperimentalQualitySettings()).toMatchObject({
      mode: "rewrite", providerAlias: "alpha", modelId: "alpha-chat", judgeTimeoutMs: 15_000,
    });
  });

  test("Escape at stage 1 and stage 2 preserves the prior settings", async () => {
    await fixture({ mode: "off" });
    const controller = makeController();
    await controller.openRewriteConfirm({ providerAlias: "alpha", modelId: "alpha-chat", judgeTimeoutMs: 15_000 });
    expect(controller.handleRewriteConfirmKey({ name: "escape" })).toBe(true);
    expect(controller.qualityRewriteConfirm()).toBeNull();
    expect((await loadExperimentalQualitySettings()).mode).toBe("off");

    // Stage 2 escape must also leave the prior settings intact.
    await controller.openRewriteConfirm({ providerAlias: "alpha", modelId: "alpha-chat", judgeTimeoutMs: 15_000 });
    controller.handleRewriteConfirmKey({ name: "return" }); // → stage 2
    expect(controller.qualityRewriteConfirm()?.stage).toBe(2);
    controller.handleRewriteConfirmKey({ name: "escape" });
    expect(controller.qualityRewriteConfirm()).toBeNull();
    expect((await loadExperimentalQualitySettings()).mode).toBe("off");
  });

  test("Cancel is focusable and Enter on Cancel cancels without writing", async () => {
    await fixture({ mode: "off" });
    const controller = makeController();
    await controller.openRewriteConfirm({ providerAlias: "alpha", modelId: "alpha-chat", judgeTimeoutMs: 15_000 });
    expect(controller.qualityRewriteConfirm()?.focused).toBe("confirm");
    controller.handleRewriteConfirmKey({ name: "down" });
    expect(controller.qualityRewriteConfirm()?.focused).toBe("reject");
    controller.handleRewriteConfirmKey({ name: "return" });
    expect(controller.qualityRewriteConfirm()).toBeNull();
    expect((await loadExperimentalQualitySettings()).mode).toBe("off");
  });
});

describe("QualityRewritePrompt height", () => {
  test("fits within the gate-modal bottom budget at 80 columns and one narrower width", () => {
    for (const stage of [1, 2] as const) {
      expect(qualityRewritePanelHeight(stage, 80)).toBeLessThanOrEqual(14);
      expect(qualityRewritePanelHeight(stage, 60)).toBeLessThanOrEqual(14);
    }
  });
});

type Env = { providersPath: string; qualityPath: string };

async function fixture(profile: { mode: "off" | "observe" | "rewrite"; providerAlias?: string; modelId?: string; timeoutMs?: number }): Promise<Env> {
  const directory = await mkdtemp(join(tmpdir(), "vesicle-quality-picker-"));
  directories.push(directory);
  await mkdir(directory, { recursive: true });
  const providersPath = join(directory, "providers.yaml");
  await writeFile(providersPath, [
    "default:", "  provider: alpha", "  model: alpha-chat", "providers:",
    "  alpha:", "    protocol: openai-chat-compatible", "    baseUrl: https://alpha.example/v1", "    apiKeyEnv: ALPHA_KEY", "    models:", "      - alpha-chat",
    "  beta:", "    protocol: openai-chat-compatible", "    baseUrl: https://beta.example/v1", "    apiKeyEnv: BETA_KEY", "    models:", "      - beta-reasoner", "",
  ].join("\n"));
  await writeFile(join(directory, ".env"), "ALPHA_KEY=alpha-secret\nBETA_KEY=beta-secret\n");
  const qualityPath = join(directory, "quality.yaml");
  const lines = ["version: 2", `mode: ${profile.mode}`];
  if (profile.providerAlias && profile.modelId && profile.timeoutMs !== undefined) {
    lines.push(`providerAlias: ${profile.providerAlias}`, `modelId: ${profile.modelId}`, `judgeTimeoutMs: ${profile.timeoutMs}`);
  }
  await writeFile(qualityPath, `${lines.join("\n")}\n`);
  process.env.VESICLE_PROVIDERS_FILE = providersPath;
  process.env.VESICLE_QUALITY_FILE = qualityPath;
  return { providersPath, qualityPath };
}

function makeController() {
  // Solid computations (createMemo) only track inside a reactive root.
  return createRoot(() => createQualityPickerController({
    providerRegistry: () => registry,
    ensureProviderRegistry: async () => registry,
    activeProvider: () => "beta",
    activeModel: () => "beta-reasoner",
    setStatus: () => undefined,
    setMessages: () => undefined,
    reportError: (error) => { throw error; },
  }));
}

async function waitUntil(predicate: () => boolean, iterations = 50): Promise<void> {
  for (let index = 0; index < iterations; index += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("waitUntil timed out");
}
