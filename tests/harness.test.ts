import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { engineIds } from "../src/core/engine/profile";
import {
  assertHarnessPackCompatible,
  harnessPacksDirectory,
  installHarnessPack,
  parseHarnessManifest,
  supportedHarnessCapabilities,
  verifyHarnessPack,
} from "../src/core/harness";
import type { HarnessManifest } from "../src/core/harness";

describe("Harness Pack foundation", () => {
  test("verifies a complete compatible pack and its runtime bindings", async () => {
    const fixture = await createHarnessFixture();
    try {
      const verified = await verifyHarnessPack(fixture.pack, fixture.options);
      expect(verified.manifest.id).toBe("fixture-harness");
      expect(verified.assetCount).toBe(16);
      expect(verified.compatibility).toEqual({
        compatible: true,
        unsupportedCapabilities: [],
        missingExternalHostAssets: [],
        issues: [],
      });
      expect(verified.manifestSha256).toHaveLength(64);
      expect(() => assertHarnessPackCompatible(verified)).not.toThrow();
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  test("reports unsupported capabilities without weakening integrity checks", async () => {
    const fixture = await createHarnessFixture({
      requiredCapabilities: [
        ...supportedHarnessCapabilities,
        "prism-agent/delegation@1",
        "quality-guard/anti-ai-flavor@1",
      ],
    });
    try {
      const verified = await verifyHarnessPack(fixture.pack, fixture.options);
      expect(verified.compatibility.compatible).toBe(false);
      expect(verified.compatibility.unsupportedCapabilities).toEqual([
        "prism-agent/delegation@1",
        "quality-guard/anti-ai-flavor@1",
      ]);
      expect(() => assertHarnessPackCompatible(verified)).toThrow("is not compatible");
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  test("rejects tampered, unlisted, and unsafe pack files", async () => {
    const tampered = await createHarnessFixture();
    const extra = await createHarnessFixture();
    const linked = await createHarnessFixture();
    try {
      await write(join(tampered.pack, "assets", "prompts", "engines", "etl.md"), "tampered");
      await expect(verifyHarnessPack(tampered.pack, tampered.options)).rejects.toThrow("hash mismatch");

      await write(join(extra.pack, "assets", "unlisted.md"), "unlisted");
      await expect(verifyHarnessPack(extra.pack, extra.options)).rejects.toThrow("unlisted file");

      const raw = JSON.parse(await readFile(join(extra.pack, "manifest.json"), "utf8")) as Record<string, unknown>;
      raw.assets = { ...(raw.assets as Record<string, string>), "assets/../escape.md": "a".repeat(64) };
      expect(() => parseHarnessManifest(raw)).toThrow("unsafe");

      await symlink(linked.host, join(linked.pack, "assets", "linked-host"));
      await expect(verifyHarnessPack(linked.pack, linked.options)).rejects.toThrow("symbolic link");
    } finally {
      await Promise.all([
        rm(tampered.root, { recursive: true, force: true }),
        rm(extra.root, { recursive: true, force: true }),
        rm(linked.root, { recursive: true, force: true }),
      ]);
    }
  });

  test("treats dirty sources and missing host assets as incompatible", async () => {
    const fixture = await createHarnessFixture({ sourceState: "dirty" });
    try {
      await rm(fixture.host, { recursive: true, force: true });
      const verified = await verifyHarnessPack(fixture.pack, fixture.options);
      expect(verified.compatibility.compatible).toBe(false);
      expect(verified.compatibility.missingExternalHostAssets).toEqual([
        "assets/prompts/agents/base.md",
        "assets/prompts/shared/vesicle-base.md",
      ]);
      expect(verified.compatibility.issues).toContain("Harness sourceState is dirty.");
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  test("installs a verified immutable directory through staging", async () => {
    const fixture = await createHarnessFixture();
    try {
      const installed = await installHarnessPack(fixture.pack, fixture.options);
      const expected = join(harnessPacksDirectory(fixture.options.env), "fixture-harness", "10.0.0-test.1");
      expect(installed.directory).toBe(expected);
      expect(await Bun.file(join(expected, "manifest.json")).exists()).toBe(true);
      await expect(installHarnessPack(fixture.pack, fixture.options)).rejects.toThrow("already installed");
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });
});

type FixtureOptions = {
  requiredCapabilities?: string[];
  sourceState?: "clean" | "dirty";
};

async function createHarnessFixture(options: FixtureOptions = {}): Promise<{
  root: string;
  pack: string;
  host: string;
  options: { env: NodeJS.ProcessEnv; bundledDirectory: string; executablePath: string };
}> {
  const root = await mkdtemp(join(tmpdir(), "vesicle-harness-"));
  const pack = join(root, "pack");
  const host = join(root, "host-assets");
  const config = join(root, "config");
  await write(join(host, "prompts", "shared", "vesicle-base.md"), "host base");
  await write(join(host, "prompts", "agents", "base.md"), "agent base");

  const profileBindings: Record<string, string> = {};
  const promptBindings: Record<string, string[]> = {};
  const qualityBindings: HarnessManifest["qualityBindings"] = {};
  for (const engine of engineIds) {
    const profilePath = `assets/engines/${engine}.profile.yaml`;
    const promptPath = `assets/prompts/engines/${engine}.md`;
    await write(join(pack, ...profilePath.split("/")), [
      `id: ${engine}`,
      `displayName: Fixture ${engine}`,
      "protocolVersion: v10.0-test",
      "systemPrompt:",
      "  - assets/prompts/shared/vesicle-base.md",
      `  - ${promptPath}`,
      "defaultTools:",
      "  - read_file",
      "validators: []",
      "stopGates: []",
      "stateRoots:",
      "  - workspace",
      "",
    ].join("\n"));
    await write(join(pack, ...promptPath.split("/")), `${engine} prompt`);
    profileBindings[engine] = profilePath;
    promptBindings[engine] = ["assets/prompts/shared/vesicle-base.md", promptPath];
    qualityBindings[engine] = {};
  }

  const agentProfilePath = "assets/agents/scene-writer.agent.yaml";
  const agentPromptPath = "assets/prompts/agents/scene-writer.md";
  await write(join(pack, ...agentProfilePath.split("/")), [
    "id: scene-writer",
    "displayName: Fixture Scene Writer",
    "description: Write one fixture scene.",
    "systemPrompt:",
    "  - assets/prompts/agents/base.md",
    `  - ${agentPromptPath}`,
    "tools:",
    "  - read_file",
    "contextMode: fresh",
    "modelPolicy: inherit",
    "defaultMode: foreground",
    "maxTurns: 4",
    "",
  ].join("\n"));
  await write(join(pack, ...agentPromptPath.split("/")), "scene writer prompt");

  const contractPath = "assets/prism-driver/contract.json";
  const adapterPath = "assets/prism-driver/adapter.json";
  await write(join(pack, ...contractPath.split("/")), "{}\n");
  await write(join(pack, ...adapterPath.split("/")), "{}\n");
  const assets = await assetHashes(pack);
  const manifest: HarnessManifest = {
    schema: "prism-harness-pack/v1",
    id: "fixture-harness",
    version: "10.0.0-test.1",
    sourceRepository: "fixture/repository",
    sourceCommit: "fixture-commit",
    sourceState: options.sourceState ?? "clean",
    harnessConfigHash: "a".repeat(64),
    compilerHash: "b".repeat(64),
    requiredCapabilities: options.requiredCapabilities ?? [...supportedHarnessCapabilities],
    externalHostAssets: [
      "assets/prompts/agents/base.md",
      "assets/prompts/shared/vesicle-base.md",
    ],
    driver: {
      contract: contractPath,
      contractHash: assets[contractPath],
      contractSourceHash: "c".repeat(64),
      adapter: adapterPath,
      adapterHash: assets[adapterPath],
      adapterSourceHash: "d".repeat(64),
      adapterId: "vesicle-v1",
      adapterVersion: "1.0.0",
      targetHost: "Prism Vesicle",
    },
    ruleModules: [],
    profileBindings,
    agentProfileBindings: { "scene-writer": agentProfilePath },
    promptBindings,
    agentPromptBindings: {
      "scene-writer": ["assets/prompts/agents/base.md", agentPromptPath],
    },
    qualityBindings,
    agentQualityBindings: { "scene-writer": {} },
    assets,
  };
  await write(join(pack, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  return {
    root,
    pack,
    host,
    options: {
      env: { VESICLE_CONFIG_DIR: config },
      bundledDirectory: host,
      executablePath: join(root, "missing", "vesicle"),
    },
  };
}

async function assetHashes(pack: string): Promise<Record<string, string>> {
  const paths: string[] = [];
  for (const engine of engineIds) {
    paths.push(`assets/engines/${engine}.profile.yaml`, `assets/prompts/engines/${engine}.md`);
  }
  paths.push(
    "assets/agents/scene-writer.agent.yaml",
    "assets/prompts/agents/scene-writer.md",
    "assets/prism-driver/adapter.json",
    "assets/prism-driver/contract.json",
  );
  return Object.fromEntries(await Promise.all(paths.sort().map(async (path) => [
    path,
    createHash("sha256").update(await readFile(join(pack, ...path.split("/")))).digest("hex"),
  ])));
}

async function write(path: string, content: string): Promise<void> {
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, content, "utf8");
}
