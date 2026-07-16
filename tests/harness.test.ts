import { createHash } from "node:crypto";
import { cp, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { engineIds } from "../src/core/engine/profile";
import {
  assertHarnessPackCompatible,
  activateInstalledHarness,
  assertSessionHarnessIdentity,
  harnessPacksDirectory,
  installHarnessPack,
  loadProjectHarnessLock,
  parseHarnessManifest,
  resolveProjectHarnessRuntime,
  rollbackProjectHarness,
  supportedHarnessCapabilities,
  verifyBundledHarnessPack,
  verifyHarnessPack,
} from "../src/core/harness";
import type { HarnessManifest } from "../src/core/harness";
import { runPrompt } from "../src/core/agent-loop/run";
import { listAgentProfiles } from "../src/core/agents/profile";
import { createSessionStore, loadSessionSnapshot } from "../src/core/session/store";
import { inspectAssets, materializeEditableAssets, parseHarnessReference } from "../src/cli/assets";

describe("Harness Pack foundation", () => {
  test("selects the verified bundled V10 baseline when a project has no lock", async () => {
    const root = await mkdtemp(join(tmpdir(), "vesicle-bundled-harness-"));
    const project = join(root, "project");
    try {
      const runtime = await resolveProjectHarnessRuntime(project, {
        env: { VESICLE_CONFIG_DIR: join(root, "config") },
      });
      expect(runtime).toBeDefined();
      expect(runtime?.selection).toBe("bundled");
      expect(runtime?.lock).toMatchObject({
        packId: "prism-engine-v10",
        packVersion: "10.0.1-alpha.3",
        manifestSha256: "5f9617d5c02c62b7bdd8f48c87285ddcd15cfab959e57bfa4249536101d25174",
      });
      expect(runtime?.pack.assetCount).toBe(54);
      expect(runtime?.pack.manifest.requiredCapabilities).toContain("quality-detector/document-metrics@1");
      expect(runtime?.pack.manifest.requiredCapabilities).toContain("quality-judge/anti-ai-flavor@1");
      expect(runtime?.harness.quality?.judge?.rules).toHaveLength(21);
      expect((await runtime!.assets.resolveFile("assets/engines/etl.profile.yaml")).source).toBe("bundled");
      expect((await runtime!.assets.resolveFile("assets/prompts/shared/vesicle-base.md")).source).toBe("host");
      expect((await listAgentProfiles(project, runtime!.assets)).map((profile) => profile.id)).toEqual([
        "chapter-reviewer",
        "continuity-editor",
        "explore",
        "general",
        "plan",
        "research",
        "reviewer",
        "scene-writer",
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("fails closed when the bundled V10 inventory is tampered", async () => {
    const root = await mkdtemp(join(tmpdir(), "vesicle-bundled-tamper-"));
    const assetsDirectory = join(root, "assets");
    const hostAssetsDirectory = join(root, "host-assets");
    const manifestPath = join(root, "harness-manifest.json");
    try {
      await cp(join(import.meta.dir, "..", "assets"), assetsDirectory, { recursive: true });
      await cp(join(import.meta.dir, "..", "host-assets"), hostAssetsDirectory, { recursive: true });
      await cp(join(import.meta.dir, "..", "harness-manifest.json"), manifestPath);
      const layout = { rootDirectory: root, manifestPath, assetsDirectory, hostAssetsDirectory };
      expect((await verifyBundledHarnessPack(layout)).assetCount).toBe(54);
      await writeFile(join(assetsDirectory, "prompts", "engines", "etl.md"), "tampered", "utf8");
      await expect(verifyBundledHarnessPack(layout)).rejects.toThrow("hash mismatch");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

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
    expect(Object.isFrozen(supportedHarnessCapabilities)).toBe(true);
    expect(() => (supportedHarnessCapabilities as string[]).push("future-capability@1")).toThrow();

    const fixture = await createHarnessFixture({
      requiredCapabilities: [
        ...supportedHarnessCapabilities.filter((capability) => capability !== "prism-agent/delegation@1"),
        "quality-analysis/anti-ai-flavor@1",
      ],
    });
    try {
      const verified = await verifyHarnessPack(fixture.pack, fixture.options);
      expect(verified.compatibility.compatible).toBe(false);
      expect(verified.compatibility.unsupportedCapabilities).toEqual([
        "quality-analysis/anti-ai-flavor@1",
      ]);
      expect(() => assertHarnessPackCompatible(verified)).toThrow("is not compatible");
      await expect(installHarnessPack(fixture.pack, fixture.options)).rejects.toThrow("is not compatible");
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  test("rejects capabilities hidden in Adapter and Rule manifests", async () => {
    const adapter = await createHarnessFixture({
      adapterCapabilities: [
        ...supportedHarnessCapabilities.filter((capability) => capability !== "prism-harness/v1" && capability !== "prism-agent/delegation@1"),
        "prism-agent/delegation@1",
      ],
    });
    const rule = await createHarnessFixture({
      ruleRequiredCapabilities: ["quality-analysis/anti-ai-flavor@1"],
    });
    const runtime = await createHarnessFixture({
      runtimeCapabilities: ["quality-analysis/anti-ai-flavor@1"],
    });
    try {
      await expect(verifyHarnessPack(adapter.pack, adapter.options)).rejects.toThrow(
        "Host Adapter capabilities are missing from requiredCapabilities",
      );
      await expect(verifyHarnessPack(rule.pack, rule.options)).rejects.toThrow(
        "rule module fixture-rule capabilities are missing from requiredCapabilities",
      );
      await expect(verifyHarnessPack(runtime.pack, runtime.options)).rejects.toThrow(
        "Host Adapter runtime capabilities are missing from requiredCapabilities",
      );
    } finally {
      await Promise.all([
        rm(adapter.root, { recursive: true, force: true }),
        rm(rule.root, { recursive: true, force: true }),
        rm(runtime.root, { recursive: true, force: true }),
      ]);
    }
  });

  test("rejects unknown tools in Adapter operation bindings", async () => {
    const fixture = await createHarnessFixture({
      adapterOperationBindings: {
        "artifact.inspect": { kind: "tool-group", tools: ["missing_host_tool"] },
      },
    });
    try {
      await expect(verifyHarnessPack(fixture.pack, fixture.options)).rejects.toThrow(
        "references unknown host tool(s): missing_host_tool",
      );
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

  test("keeps unsupported strict quality policy fail-closed", async () => {
    const fixture = await createHarnessFixture({ ruleRequiredCapabilities: ["quality-guard/anti-ai-flavor@1"] });
    try {
      const manifestPath = join(fixture.pack, "manifest.json");
      const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as HarnessManifest;
      manifest.qualityBindings.runtime = { "fixture-rule": "strict" };
      await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
      const verified = await verifyHarnessPack(fixture.pack, fixture.options);
      expect(verified.compatibility.compatible).toBe(false);
      expect(verified.compatibility.issues).toContain("Unsupported Harness quality bindings: runtime/fixture-rule:strict.");
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  test("rejects quality modes outside the implemented producer matrix", async () => {
    const fixture = await createHarnessFixture({ ruleRequiredCapabilities: ["quality-guard/anti-ai-flavor@1"] });
    try {
      const manifestPath = join(fixture.pack, "manifest.json");
      const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as HarnessManifest;
      manifest.qualityBindings.etl = { "fixture-rule": "rewrite" };
      manifest.agentQualityBindings["scene-writer"] = { "fixture-rule": "rewrite" };
      await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
      const verified = await verifyHarnessPack(fixture.pack, fixture.options);
      expect(verified.compatibility.compatible).toBe(false);
      expect(verified.compatibility.issues[0]).toContain("etl/fixture-rule:rewrite");
      expect(verified.compatibility.issues[0]).toContain("scene-writer/fixture-rule:rewrite");
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

  test("activates, re-verifies, and rolls back one project-managed baseline", async () => {
    const fixture = await createHarnessFixture();
    const project = join(fixture.root, "project");
    try {
      await write(join(fixture.host, "legacy-v9-only.md"), "must not fall through");
      const installed = await installHarnessPack(fixture.pack, fixture.options);
      const active = await activateInstalledHarness(
        project,
        installed.manifest.id,
        installed.manifest.version,
        fixture.options,
      );
      const reactivated = await activateInstalledHarness(
        project,
        installed.manifest.id,
        installed.manifest.version,
        fixture.options,
      );
      expect(reactivated.lock).toEqual(active.lock);
      expect(await loadProjectHarnessLock(project)).toEqual(active.lock);
      expect(active.harness.identity).toEqual(expect.objectContaining({
        packId: "fixture-harness",
        packVersion: "10.0.0-test.1",
        adapterId: "vesicle-v1",
      }));
      expect((await active.assets.resolveFile("assets/engines/runtime.profile.yaml")).source).toBe("managed");
      expect((await active.assets.resolveFile("assets/prompts/shared/vesicle-base.md")).source).toBe("host");
      await expect(active.assets.resolveFile("assets/legacy-v9-only.md")).rejects.toThrow("not found");
      expect(parseHarnessReference("fixture-harness@10.0.0-test.1")).toEqual({
        packId: "fixture-harness",
        packVersion: "10.0.0-test.1",
      });
      const status = await inspectAssets(project, fixture.options);
      expect(status.managed).toEqual(active.lock);
      expect(status.layers.find((layer) => layer.source === "host")?.fileCount).toBe(2);
      await materializeEditableAssets("assets/prompts/engines/runtime.md", project, {
        env: fixture.options.env,
      });
      expect(await readFile(join(project, "assets", "prompts", "engines", "runtime.md"), "utf8"))
        .toBe("runtime prompt");

      const resumed = await resolveProjectHarnessRuntime(project, fixture.options);
      expect(resumed?.lock).toEqual(active.lock);
      expect(() => assertSessionHarnessIdentity(active.harness.identity, resumed?.harness.identity)).not.toThrow();
      expect(() => assertSessionHarnessIdentity(undefined, resumed?.harness.identity)).toThrow("does not match");

      await rollbackProjectHarness(project);
      expect(await loadProjectHarnessLock(project)).toBeUndefined();
      expect(await resolveProjectHarnessRuntime(project, fixture.options)).toBeUndefined();
      const bundled = await resolveProjectHarnessRuntime(project, { env: fixture.options.env });
      expect(bundled?.selection).toBe("bundled");
      expect(bundled?.lock).toMatchObject({
        packId: "prism-engine-v10",
        packVersion: "10.0.1-alpha.3",
      });
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  test("fails closed when an installed managed pack drifts after activation", async () => {
    const fixture = await createHarnessFixture();
    const project = join(fixture.root, "project");
    try {
      const installed = await installHarnessPack(fixture.pack, fixture.options);
      await activateInstalledHarness(project, installed.manifest.id, installed.manifest.version, fixture.options);
      await writeFile(join(installed.directory, "assets", "prompts", "engines", "runtime.md"), "tampered", "utf8");
      await expect(resolveProjectHarnessRuntime(project, fixture.options)).rejects.toThrow("hash mismatch");
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  test("fails closed for malformed locks and missing installed packs", async () => {
    const fixture = await createHarnessFixture();
    const project = join(fixture.root, "project");
    try {
      const installed = await installHarnessPack(fixture.pack, fixture.options);
      await activateInstalledHarness(project, installed.manifest.id, installed.manifest.version, fixture.options);
      await writeFile(join(project, ".vesicle", "assets.lock.json"), "{}\n", "utf8");
      await expect(resolveProjectHarnessRuntime(project, fixture.options)).rejects.toThrow(
        "Project Harness lock is invalid",
      );

      await activateInstalledHarness(project, installed.manifest.id, installed.manifest.version, fixture.options);
      await rm(installed.directory, { recursive: true, force: true });
      await expect(resolveProjectHarnessRuntime(project, fixture.options)).rejects.toThrow(
        "Cannot access Harness pack directory",
      );
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  test("preserves the previous project lock when runtime construction fails", async () => {
    const current = await createHarnessFixture();
    const invalid = await createHarnessFixture({
      packVersion: "10.0.0-test.2",
      ruleModuleId: "anti-ai-flavor",
      ruleRequiredCapabilities: ["quality-guard/anti-ai-flavor@1"],
    });
    const project = join(current.root, "project");
    try {
      const installedCurrent = await installHarnessPack(current.pack, current.options);
      const active = await activateInstalledHarness(
        project,
        installedCurrent.manifest.id,
        installedCurrent.manifest.version,
        current.options,
      );
      const invalidOptions = {
        ...invalid.options,
        env: current.options.env,
        bundledDirectory: current.host,
      };
      await expect(installHarnessPack(invalid.pack, invalidOptions)).rejects.toThrow("Rule Pack manifest");
      const invalidDirectory = join(
        harnessPacksDirectory(current.options.env),
        "fixture-harness",
        "10.0.0-test.2",
      );
      await mkdir(join(harnessPacksDirectory(current.options.env), "fixture-harness"), { recursive: true });
      await cp(invalid.pack, invalidDirectory, { recursive: true });

      await expect(activateInstalledHarness(
        project,
        "fixture-harness",
        "10.0.0-test.2",
        invalidOptions,
      )).rejects.toThrow("Rule Pack manifest");
      expect(await loadProjectHarnessLock(project)).toEqual(active.lock);
      expect((await resolveProjectHarnessRuntime(project, current.options))?.lock).toEqual(active.lock);
    } finally {
      await rm(current.root, { recursive: true, force: true });
      await rm(invalid.root, { recursive: true, force: true });
    }
  });

  test("does not resume an unpinned session after managed activation", async () => {
    const fixture = await createHarnessFixture();
    const project = join(fixture.root, "project");
    try {
      const session = await createSessionStore(project, "pre-managed-session");
      await session.append({ role: "system", content: "legacy prompt" });
      await session.append({ role: "user", content: "legacy turn" });
      const installed = await installHarnessPack(fixture.pack, fixture.options);
      const active = await activateInstalledHarness(project, installed.manifest.id, installed.manifest.version, fixture.options);
      const snapshot = await loadSessionSnapshot(project, session.sessionId);

      expect(() => assertSessionHarnessIdentity(snapshot.harness, active.harness.identity)).toThrow(
        "Session Harness identity does not match",
      );
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  test("persists bundled V10 identity for new sessions and rejects legacy unpinned sessions", async () => {
    const root = await mkdtemp(join(tmpdir(), "vesicle-bundled-session-"));
    const project = join(root, "project");
    const config = join(root, "config");
    const providers = join(config, "providers.yaml");
    const originalProvidersFile = process.env.VESICLE_PROVIDERS_FILE;
    const originalConfigDirectory = process.env.VESICLE_CONFIG_DIR;
    const originalFetch = globalThis.fetch;
    try {
      await write(providers, [
        "default:",
        "  provider: test",
        "  model: test-model",
        "providers:",
        "  test:",
        "    protocol: openai-chat-compatible",
        "    baseUrl: https://provider.test/v1",
        "    apiKeyEnv: TEST_KEY",
        "    models:",
        "      - test-model",
        "",
      ].join("\n"));
      await write(join(config, ".env"), "TEST_KEY=test-secret\n");
      process.env.VESICLE_PROVIDERS_FILE = providers;
      process.env.VESICLE_CONFIG_DIR = config;
      globalThis.fetch = (async () => Response.json({
        id: "bundled-session",
        choices: [{ message: { content: "bundled response" } }],
      })) as unknown as typeof fetch;

      const first = await runPrompt({ input: "start", engine: "etl", rootDir: project });
      expect(first.kind).toBe("complete");
      expect(first.profile.protocolVersion).toBe("v10.0-tempered-voice");
      const snapshot = await loadSessionSnapshot(project, first.sessionId);
      expect(snapshot.harness).toMatchObject({
        packId: "prism-engine-v10",
        packVersion: "10.0.1-alpha.3",
      });
      expect(snapshot.assets?.files.some((file) => file.source === "bundled")).toBe(true);
      expect(snapshot.assets?.files.some((file) => file.source === "host")).toBe(true);

      const resumed = await runPrompt({
        input: "continue",
        engine: "etl",
        rootDir: project,
        sessionId: first.sessionId,
        messages: [...first.messages, { role: "user", content: "continue" }],
      });
      expect(resumed.kind).toBe("complete");

      let runtimeRequests = 0;
      let judgeRequests = 0;
      globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body)) as { messages?: Array<{ content?: string }> };
        if (body.messages?.[0]?.content?.includes("quality-judge-result/v1")) {
          judgeRequests += 1;
          return Response.json({
            id: `bundled-judge-${judgeRequests}`,
            choices: [{ message: { content: JSON.stringify({
              schema: "quality-judge-result/v1",
              verdict: "pass",
              confidence: 0.9,
              findings: [],
            }) } }],
          });
        }
        runtimeRequests += 1;
        return Response.json({
          id: `bundled-runtime-${runtimeRequests}`,
          choices: [{ message: {
            content: runtimeRequests === 1
              ? "空气中弥漫着雨味。"
              : "雨水顺着门轴滴到她的袖口。",
          } }],
        });
      }) as unknown as typeof fetch;
      const guarded = await runPrompt({ input: "write", engine: "runtime", rootDir: project });
      expect(guarded.kind).toBe("complete");
      expect(runtimeRequests).toBe(2);
      expect(judgeRequests).toBe(1);
      const guardedSnapshot = await loadSessionSnapshot(project, guarded.sessionId);
      expect(guardedSnapshot.qualityEvents.map((event) => event.decision)).toEqual(["rewrite", "pass"]);
      expect(guardedSnapshot.qualityEvents.at(-1)?.judgeStatus).toBe("valid");

      const legacy = await createSessionStore(project, "legacy-v9-session");
      await legacy.append({ role: "system", content: "legacy V9 prompt" });
      await legacy.append({ role: "user", content: "legacy turn" });
      await expect(runPrompt({
        input: "continue legacy",
        engine: "etl",
        rootDir: project,
        sessionId: legacy.sessionId,
        messages: [{ role: "user", content: "continue legacy" }],
      })).rejects.toThrow("Session Harness identity does not match");
    } finally {
      globalThis.fetch = originalFetch;
      if (originalProvidersFile === undefined) delete process.env.VESICLE_PROVIDERS_FILE;
      else process.env.VESICLE_PROVIDERS_FILE = originalProvidersFile;
      if (originalConfigDirectory === undefined) delete process.env.VESICLE_CONFIG_DIR;
      else process.env.VESICLE_CONFIG_DIR = originalConfigDirectory;
      await rm(root, { recursive: true, force: true });
    }
  });

  test("starts and resumes a session from the verified project-managed baseline", async () => {
    const fixture = await createHarnessFixture();
    const project = join(fixture.root, "project");
    const providers = join(fixture.config, "providers.yaml");
    const originalProvidersFile = process.env.VESICLE_PROVIDERS_FILE;
    const originalFetch = globalThis.fetch;
    try {
      await write(providers, [
        "default:",
        "  provider: test",
        "  model: test-model",
        "providers:",
        "  test:",
        "    protocol: openai-chat-compatible",
        "    baseUrl: https://provider.test/v1",
        "    apiKeyEnv: TEST_KEY",
        "    models:",
        "      - test-model",
        "",
      ].join("\n"));
      await write(join(fixture.config, ".env"), "TEST_KEY=test-secret\n");
      process.env.VESICLE_PROVIDERS_FILE = providers;
      globalThis.fetch = (async () => Response.json({
        id: "managed-session",
        choices: [{ message: { content: "managed response" } }],
      })) as unknown as typeof fetch;
      const installed = await installHarnessPack(fixture.pack, fixture.options);
      const active = await activateInstalledHarness(project, installed.manifest.id, installed.manifest.version, fixture.options);

      const first = await runPrompt({ input: "start", engine: "runtime", rootDir: project });
      expect(first.kind).toBe("complete");
      expect(first.profile.protocolVersion).toBe("v10.0-test");
      const snapshot = await loadSessionSnapshot(project, first.sessionId);
      expect(snapshot.harness).toEqual(active.harness.identity);
      expect(snapshot.assets?.files.some((file) => file.source === "managed")).toBe(true);

      const resumed = await runPrompt({
        input: "continue",
        engine: "runtime",
        rootDir: project,
        sessionId: first.sessionId,
        messages: [...first.messages, { role: "user", content: "continue" }],
      });
      expect(resumed.kind).toBe("complete");

      await rollbackProjectHarness(project);
      await expect(runPrompt({
        input: "continue after rollback",
        engine: "runtime",
        rootDir: project,
        sessionId: first.sessionId,
        messages: resumed.messages,
      })).rejects.toThrow("Session Harness identity does not match");
    } finally {
      globalThis.fetch = originalFetch;
      if (originalProvidersFile === undefined) delete process.env.VESICLE_PROVIDERS_FILE;
      else process.env.VESICLE_PROVIDERS_FILE = originalProvidersFile;
      await rm(fixture.root, { recursive: true, force: true });
    }
  });
});

type FixtureOptions = {
  adapterCapabilities?: string[];
  adapterOperationBindings?: Record<string, unknown>;
  requiredCapabilities?: string[];
  ruleRequiredCapabilities?: string[];
  runtimeCapabilities?: string[];
  sourceState?: "clean" | "dirty";
  packVersion?: string;
  ruleModuleId?: string;
};

async function createHarnessFixture(options: FixtureOptions = {}): Promise<{
  root: string;
  pack: string;
  host: string;
  config: string;
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
  await write(join(pack, ...contractPath.split("/")), `${JSON.stringify({
    schema: "prism-driver-contract/v1",
    id: "fixture-driver",
    version: "10.0.0-test.1",
    agents: {
      "scene-writer": {
        operations: ["artifact.inspect"],
        defaultMode: "foreground",
      },
    },
    engines: Object.fromEntries(engineIds.map((engine) => [engine, {
      operations: ["artifact.inspect"],
      interactions: [],
      delegations: [],
    }])),
  }, null, 2)}\n`);
  await write(join(pack, ...adapterPath.split("/")), `${JSON.stringify({
    schema: "prism-host-adapter/v1",
    id: "vesicle-v1",
    version: "1.0.0",
    targetHost: "Prism Vesicle",
    capabilities: options.adapterCapabilities
      ?? supportedHarnessCapabilities.filter((capability) =>
        capability !== "prism-harness/v1" && capability !== "prism-agent/delegation@1"
      ),
    operationBindings: options.adapterOperationBindings ?? {
      "artifact.inspect": { kind: "tool-group", tools: ["read_file"] },
      ...Object.fromEntries((options.runtimeCapabilities ?? []).map((capability, index) => [
        `fixture.runtime-${index + 1}`,
        { kind: "runtime-capability", capability },
      ])),
    },
  }, null, 2)}\n`);
  const ruleModuleId = options.ruleModuleId ?? "fixture-rule";
  const ruleManifestPath = `assets/quality/${ruleModuleId}/manifest.json`;
  const extraAssetPaths: string[] = [];
  if (options.ruleRequiredCapabilities) {
    await write(join(pack, ...ruleManifestPath.split("/")), `${JSON.stringify({
      schema: "rule-pack/v1",
      module: ruleModuleId,
      requiredCapabilities: options.ruleRequiredCapabilities,
    }, null, 2)}\n`);
    extraAssetPaths.push(ruleManifestPath);
  }
  const assets = await assetHashes(pack, extraAssetPaths);
  const manifest: HarnessManifest = {
    schema: "prism-harness-pack/v1",
    id: "fixture-harness",
    version: options.packVersion ?? "10.0.0-test.1",
    sourceRepository: "fixture/repository",
    sourceCommit: "fixture-commit",
    sourceState: options.sourceState ?? "clean",
    harnessConfigHash: "a".repeat(64),
    compilerHash: "b".repeat(64),
    requiredCapabilities: options.requiredCapabilities
      ?? supportedHarnessCapabilities.filter((capability) => capability !== "prism-agent/delegation@1"),
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
    ruleModules: options.ruleRequiredCapabilities
      ? [{ id: ruleModuleId, manifest: ruleManifestPath }]
      : [],
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
    config,
    options: {
      env: { VESICLE_CONFIG_DIR: config },
      bundledDirectory: host,
      executablePath: join(root, "missing", "vesicle"),
    },
  };
}

async function assetHashes(pack: string, extraPaths: string[] = []): Promise<Record<string, string>> {
  const paths: string[] = [];
  for (const engine of engineIds) {
    paths.push(`assets/engines/${engine}.profile.yaml`, `assets/prompts/engines/${engine}.md`);
  }
  paths.push(
    "assets/agents/scene-writer.agent.yaml",
    "assets/prompts/agents/scene-writer.md",
    "assets/prism-driver/adapter.json",
    "assets/prism-driver/contract.json",
    ...extraPaths,
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
