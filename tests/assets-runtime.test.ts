import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { initializeEditableAssets, inspectAssets, materializeEditableAssets } from "../src/cli/assets";
import { AssetResolver } from "../src/core/runtime/assets";
import { inspectEngineAssetDrift, loadEngineAssetRuntime } from "../src/core/runtime/engine-assets";

describe("runtime assets", () => {
  test("falls back to package assets and can materialize a legacy full project override", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "vesicle-assets-"));
    try {
      const options = { env: { VESICLE_CONFIG_DIR: join(rootDir, "config") } };
      expect((await new AssetResolver(rootDir, options).resolveFile("assets/manifest.json")).source).toBe("bundled");

      await initializeEditableAssets(rootDir);
      expect((await new AssetResolver(rootDir, options).resolveFile("assets/manifest.json")).source).toBe("project");
      expect(await Bun.file(join(rootDir, "assets", "manifest.json")).exists()).toBe(true);
      await expect(initializeEditableAssets(rootDir)).rejects.toThrow("Refusing to overwrite existing project asset override");
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  test("can initialize a user-global editable snapshot without touching the project", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "vesicle-global-assets-"));
    const config = join(rootDir, "config");
    const project = join(rootDir, "project");
    try {
      await initializeEditableAssets(project, {
        scope: "user",
        env: { VESICLE_CONFIG_DIR: config },
      });
      expect(await Bun.file(join(config, "assets", "manifest.json")).exists()).toBe(true);
      expect(await Bun.file(join(project, "assets", "manifest.json")).exists()).toBe(false);
      const status = await inspectAssets(project, {
        env: { VESICLE_CONFIG_DIR: config },
        executablePath: join(rootDir, "missing", "vesicle"),
      });
      expect(status.layers.find((layer) => layer.source === "user")).toMatchObject({ present: true });
      expect(status.manifest?.source).toBe("user");
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  test("materializes one sparse project override without copying the full tree", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "vesicle-sparse-assets-"));
    try {
      await materializeEditableAssets("assets/prompts/engines/etl.md", rootDir);
      expect(await Bun.file(join(rootDir, "assets", "prompts", "engines", "etl.md")).exists()).toBe(true);
      expect(await Bun.file(join(rootDir, "assets", "manifest.json")).exists()).toBe(false);
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  test("refuses to materialize through a project asset symlink", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "vesicle-materialize-symlink-"));
    const project = join(rootDir, "project");
    const outside = join(rootDir, "outside");
    try {
      await mkdir(project, { recursive: true });
      await mkdir(outside, { recursive: true });
      await symlink(outside, join(project, "assets"));
      await writeFile(join(outside, "secret.md"), "must not be readable", "utf8");
      const resolver = new AssetResolver(project, {
        env: { VESICLE_CONFIG_DIR: join(rootDir, "config") },
        executablePath: join(rootDir, "missing", "vesicle"),
      });
      await expect(resolver.readText("assets/secret.md")).rejects.toThrow("layer root escapes its project boundary");
      await expect(materializeEditableAssets("assets/prompts/engines/etl.md", project)).rejects.toThrow(
        "asset symlink outside the project scope",
      );
      expect(await Bun.file(join(outside, "prompts", "engines", "etl.md")).exists()).toBe(false);
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  test("detects effective engine asset drift without persisting prompt contents", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "vesicle-asset-drift-"));
    const options = {
      env: { VESICLE_CONFIG_DIR: join(rootDir, "config") },
      bundledDirectory: join(import.meta.dir, "..", "assets"),
      executablePath: join(rootDir, "missing", "vesicle"),
    };
    try {
      const initial = (await loadEngineAssetRuntime("etl", rootDir, options)).assets;
      const override = join(rootDir, "assets", "prompts", "engines", "etl.md");
      await write(override, "changed project prompt");
      const drift = await inspectEngineAssetDrift(initial, "etl", rootDir, options);
      expect(drift?.changedPaths).toEqual(["assets/prompts/engines/etl.md"]);
      expect(JSON.stringify(drift)).not.toContain("changed project prompt");
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  test("merges sparse project and user overrides over bundled defaults file by file", async () => {
    const fixture = await createLayerFixture();
    try {
      const resolver = new AssetResolver(fixture.project, {
        env: { VESICLE_CONFIG_DIR: fixture.config },
        bundledDirectory: fixture.bundled,
        executablePath: join(fixture.root, "missing", "vesicle"),
      });

      expect(await resolver.readText("assets/prompts/engines/etl.md")).toBe("project etl");
      expect(await resolver.readText("assets/prompts/shared/base.md")).toBe("user base");
      expect(await resolver.readText("assets/specs/module-a.md")).toBe("bundled spec");
      expect((await resolver.resolveFile("assets/prompts/engines/etl.md")).source).toBe("project");
      expect((await resolver.resolveFile("assets/prompts/shared/base.md")).source).toBe("user");
      expect((await resolver.resolveFile("assets/specs/module-a.md")).source).toBe("bundled");

      expect(await resolver.listFiles("assets", true)).toEqual([
        "assets/manifest.json",
        "assets/masked",
        "assets/prompts/engines/etl.md",
        "assets/prompts/engines/runtime.md",
        "assets/prompts/shared/base.md",
        "assets/replaced/visible.md",
        "assets/specs/module-a.md",
      ]);
      await expect(resolver.resolveFile("assets/replaced")).rejects.toThrow("not a file");
      const maskedError = await resolver.readText("assets/masked/hidden.md").catch((error: unknown) => error);
      expect(maskedError).toBeInstanceOf(Error);
      expect((maskedError as Error).message).toContain("shadowed by a file");
      expect((maskedError as Error).message).not.toContain(fixture.root);

      const fingerprint = await resolver.fingerprint([
        "assets/specs/module-a.md",
        "assets/prompts/engines/etl.md",
      ]);
      expect(fingerprint.sha256).toHaveLength(64);
      expect(fingerprint.files.map((file) => [file.path, file.source])).toEqual([
        ["assets/prompts/engines/etl.md", "project"],
        ["assets/specs/module-a.md", "bundled"],
      ]);

      await expect(resolver.readText("assets/../secret.txt")).rejects.toThrow("Unsafe asset path");
      await expect(resolver.readText("workspace/not-an-asset.md")).rejects.toThrow("must be under assets");
      const outside = join(fixture.root, "outside.txt");
      await writeFile(outside, "secret", "utf8");
      await symlink(outside, join(fixture.project, "assets", "escape.md"));
      await expect(resolver.readText("assets/escape.md")).rejects.toThrow("escapes its layer");
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });
});

async function createLayerFixture(): Promise<{
  root: string;
  project: string;
  config: string;
  bundled: string;
}> {
  const root = await mkdtemp(join(tmpdir(), "vesicle-asset-layers-"));
  const project = join(root, "project");
  const config = join(root, "config");
  const bundled = join(root, "bundled-assets");
  await write(join(project, "assets", "prompts", "engines", "etl.md"), "project etl");
  await write(join(project, "assets", "masked"), "project file masks bundled directory");
  await write(join(project, "assets", "replaced", "visible.md"), "project directory masks bundled file");
  await write(join(config, "assets", "prompts", "shared", "base.md"), "user base");
  await write(join(bundled, "manifest.json"), "{}");
  await write(join(bundled, "prompts", "engines", "etl.md"), "bundled etl");
  await write(join(bundled, "prompts", "engines", "runtime.md"), "bundled runtime");
  await write(join(bundled, "prompts", "shared", "base.md"), "bundled base");
  await write(join(bundled, "specs", "module-a.md"), "bundled spec");
  await write(join(bundled, "masked", "hidden.md"), "must stay hidden");
  await write(join(bundled, "replaced"), "bundled file");
  return { root, project, config, bundled };
}

async function write(path: string, content: string): Promise<void> {
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, content, "utf8");
}
