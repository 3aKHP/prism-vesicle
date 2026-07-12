import { cp, lstat, mkdir, readdir, realpath } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import {
  createAssetResolver,
  bundledAssetsDirectory,
  normalizeAssetPath,
  userAssetsDirectory,
  type AssetLayer,
  type AssetResolverOptions,
} from "../core/runtime/assets";

export type AssetScope = "project" | "user";

/** Materialize a full editable snapshot. Retained for `assets init` compatibility. */
export async function initializeEditableAssets(
  projectRoot = process.cwd(),
  options: { scope?: AssetScope; env?: NodeJS.ProcessEnv } = {},
): Promise<void> {
  await materializeEditableAssets("assets", projectRoot, options);
}

/** Copy one default asset file/directory into a sparse editable override layer. */
export async function materializeEditableAssets(
  logicalPath: string,
  projectRoot = process.cwd(),
  options: { scope?: AssetScope; env?: NodeJS.ProcessEnv } = {},
): Promise<void> {
  const scope = options.scope ?? "project";
  const normalized = normalizeAssetPath(logicalPath, { allowRoot: true });
  const resolver = createAssetResolver(projectRoot, { env: options.env });
  const bundledDirectory = bundledAssetsDirectory()
    ?? resolver.layers.find((layer) => layer.source === "bundled")?.directory;
  if (!bundledDirectory) {
    throw new Error("This installation has no default assets to materialize. Extract the assets release pack beside the standalone binary first.");
  }

  const suffix = normalized === "assets" ? "" : normalized.slice("assets/".length);
  const source = join(bundledDirectory, ...suffix.split("/").filter(Boolean));
  const targetRoot = scope === "user" ? userAssetsDirectory(options.env) : join(projectRoot, "assets");
  const target = join(targetRoot, ...suffix.split("/").filter(Boolean));
  if (await pathExists(target)) {
    throw new Error(`Refusing to overwrite existing ${scope} asset override at ${target}.`);
  }
  if (!await pathExists(source)) throw new Error(`Default asset not found: ${normalized}.`);

  await mkdir(dirname(targetRoot), { recursive: true });
  const scopeBase = await realpath(dirname(targetRoot));
  await assertNearestExistingAncestorInside(scopeBase, dirname(target), scope);
  await mkdir(dirname(target), { recursive: true });
  assertInside(scopeBase, await realpath(dirname(target)), scope);
  await cp(source, target, { recursive: true, errorOnExist: true, force: false });
  console.log(`Initialized ${scope} asset override: ${target}`);
}

export async function inspectAssets(
  projectRoot = process.cwd(),
  options: AssetResolverOptions = {},
): Promise<{
  layers: Array<AssetLayer & { present: boolean; fileCount: number }>;
  manifest?: { source: string; path: string };
}> {
  const resolver = createAssetResolver(projectRoot, options);
  const layers = await Promise.all(resolver.layers.map(async (layer) => ({
    ...layer,
    present: await pathExists(layer.directory),
    fileCount: await countFiles(layer.directory),
  })));
  const manifest = await resolver.resolveFile("assets/manifest.json").catch((error: unknown) => {
    if (error instanceof Error && error.message.startsWith("Prism asset not found:")) return undefined;
    throw error;
  });
  return {
    layers,
    ...(manifest ? { manifest: { source: manifest.source, path: manifest.logicalPath } } : {}),
  };
}

export async function runAssetsCommand(args: string[]): Promise<void> {
  const command = args[0];
  if (command === "status" && args.length === 1) {
    const status = await inspectAssets();
    console.log("Prism Vesicle Assets");
    for (const layer of status.layers) {
      console.log(`${capitalize(layer.source)}: ${layer.present ? `${layer.fileCount} files` : "missing"} (${layer.directory})`);
    }
    console.log(`Effective manifest: ${status.manifest ? `${status.manifest.source} (${status.manifest.path})` : "missing"}`);
    return;
  }

  if (command === "init") {
    const scope = parseScope(args.slice(1));
    await initializeEditableAssets(process.cwd(), { scope });
    return;
  }

  if (command === "materialize" && args[1]) {
    const scope = parseScope(args.slice(2));
    await materializeEditableAssets(args[1], process.cwd(), { scope });
    return;
  }

  printUsage();
  process.exitCode = 1;
}

function parseScope(args: string[]): AssetScope {
  if (args.length === 0) return "project";
  if (args.length === 1 && args[0] === "--global") return "user";
  throw new Error("Asset scope accepts only --global.");
}

function printUsage(): void {
  console.error("Usage:");
  console.error("  vesicle assets status");
  console.error("  vesicle assets init [--global]");
  console.error("  vesicle assets materialize <assets/path> [--global]");
}

async function countFiles(directory: string): Promise<number> {
  const entries = await readdir(directory, { withFileTypes: true }).catch((error: unknown) => {
    if (isMissing(error)) return [];
    throw error;
  });
  let count = 0;
  for (const entry of entries) {
    if (entry.isFile()) count += 1;
    else if (entry.isDirectory()) count += await countFiles(join(directory, entry.name));
  }
  return count;
}

async function pathExists(path: string): Promise<boolean> {
  return Boolean(await lstat(path).catch((error: unknown) => {
    if (isMissing(error)) return undefined;
    throw error;
  }));
}

function isMissing(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "ENOENT");
}

function capitalize(value: string): string {
  return value.slice(0, 1).toUpperCase() + value.slice(1);
}

async function assertNearestExistingAncestorInside(
  scopeBase: string,
  targetParent: string,
  scope: AssetScope,
): Promise<void> {
  let cursor = targetParent;
  while (!await pathExists(cursor)) {
    const parent = dirname(cursor);
    if (parent === cursor) throw new Error(`Cannot resolve the ${scope} asset scope.`);
    cursor = parent;
  }
  assertInside(scopeBase, await realpath(cursor), scope);
}

function assertInside(scopeBase: string, candidate: string, scope: AssetScope): void {
  const rel = relative(scopeBase, candidate);
  if (rel === ".." || rel.startsWith(`..${sep}`) || resolve(rel) === rel) {
    throw new Error(`Refusing to materialize through an asset symlink outside the ${scope} scope.`);
  }
}
