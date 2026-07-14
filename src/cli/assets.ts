import { cp, lstat, mkdir, readdir, realpath } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import {
  createAssetResolver,
  normalizeAssetPath,
  userAssetsDirectory,
  type AssetLayer,
  type AssetResolverOptions,
} from "../core/runtime/assets";
import {
  activateInstalledHarness,
  createHarnessRuntimeContext,
  installHarnessPack,
  resolveProjectHarnessRuntime,
  rollbackProjectHarness,
  verifyHarnessPack,
  type HarnessProjectLock,
} from "../core/harness";

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
  const projectHarness = await resolveProjectHarnessRuntime(projectRoot, { env: options.env });
  const resolver = projectHarness?.assets ?? createAssetResolver(projectRoot, { env: options.env });

  const suffix = normalized === "assets" ? "" : normalized.slice("assets/".length);
  const targetRoot = scope === "user" ? userAssetsDirectory(options.env) : join(projectRoot, "assets");
  const target = join(targetRoot, ...suffix.split("/").filter(Boolean));
  if (await pathExists(target)) {
    throw new Error(`Refusing to overwrite existing ${scope} asset override at ${target}.`);
  }

  await mkdir(dirname(targetRoot), { recursive: true });
  const scopeBase = await realpath(dirname(targetRoot));
  await assertNearestExistingAncestorInside(scopeBase, dirname(target), scope);
  await mkdir(dirname(target), { recursive: true });
  assertInside(scopeBase, await realpath(dirname(target)), scope);
  await copyEffectiveAsset(resolver, normalized, target);
  console.log(`Initialized ${scope} asset override: ${target}`);
}

export async function inspectAssets(
  projectRoot = process.cwd(),
  options: AssetResolverOptions = {},
): Promise<{
  layers: Array<AssetLayer & { present: boolean; fileCount: number }>;
  manifest?: { source: string; path: string };
  managed?: HarnessProjectLock;
  harness?: { selection: "managed" | "bundled"; identity: HarnessProjectLock };
}> {
  const projectHarness = await resolveProjectHarnessRuntime(projectRoot, options);
  const resolver = projectHarness?.assets ?? createAssetResolver(projectRoot, options);
  const layers = await Promise.all(resolver.layers.map(async (layer) => ({
    ...layer,
    present: await pathExists(layer.directory),
    fileCount: await countFiles(layer.directory, "assets", layer.allowedPaths),
  })));
  const manifest = projectHarness
    ? undefined
    : await resolver.resolveFile("assets/manifest.json").catch((error: unknown) => {
        if (error instanceof Error && error.message.startsWith("Prism asset not found:")) return undefined;
        throw error;
      });
  return {
    layers,
    ...(manifest ? { manifest: { source: manifest.source, path: manifest.logicalPath } } : {}),
    ...(projectHarness?.selection === "managed" ? { managed: projectHarness.lock } : {}),
    ...(projectHarness ? { harness: { selection: projectHarness.selection, identity: projectHarness.lock } } : {}),
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
    console.log(status.harness
      ? `Active baseline: ${status.harness.selection} ${status.harness.identity.packId}@${status.harness.identity.packVersion}`
      : "Active baseline: unavailable");
    console.log(status.harness
      ? `Harness manifest SHA-256: ${status.harness.identity.manifestSha256}`
      : `Effective manifest: ${status.manifest ? `${status.manifest.source} (${status.manifest.path})` : "missing"}`);
    return;
  }

  if (command === "verify" && args[1] && args.length === 2) {
    const pack = await verifyHarnessPack(resolve(args[1]));
    if (!pack.compatibility.compatible) {
      console.log(`Verified Harness ${pack.manifest.id}@${pack.manifest.version}: ${pack.assetCount} assets; compatible=false`);
      for (const issue of pack.compatibility.issues) console.log(`- ${issue}`);
      process.exitCode = 1;
    } else {
      await createHarnessRuntimeContext(pack);
      console.log(`Verified Harness ${pack.manifest.id}@${pack.manifest.version}: ${pack.assetCount} assets; compatible=true`);
    }
    return;
  }

  if (command === "install" && args[1] && args.length === 2) {
    const pack = await installHarnessPack(resolve(args[1]));
    console.log(`Installed Harness ${pack.manifest.id}@${pack.manifest.version} (${pack.assetCount} assets).`);
    return;
  }

  if (command === "use" && args[1] && args.length === 2) {
    const reference = parseHarnessReference(args[1]);
    const selected = await activateInstalledHarness(process.cwd(), reference.packId, reference.packVersion);
    console.log(`Activated managed Harness ${selected.lock.packId}@${selected.lock.packVersion} for this project.`);
    return;
  }

  if (command === "rollback" && args.length === 1) {
    const previous = await rollbackProjectHarness(process.cwd());
    console.log(`Rolled back ${previous.packId}@${previous.packVersion}; bundled V10 baseline is active.`);
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
  console.error("  vesicle assets verify <extracted-pack-directory>");
  console.error("  vesicle assets install <extracted-pack-directory>");
  console.error("  vesicle assets use <pack-id>@<version>");
  console.error("  vesicle assets rollback");
  console.error("  vesicle assets init [--global]");
  console.error("  vesicle assets materialize <assets/path> [--global]");
}

export function parseHarnessReference(value: string): { packId: string; packVersion: string } {
  const separator = value.lastIndexOf("@");
  if (separator <= 0 || separator === value.length - 1) {
    throw new Error("Harness reference must use <pack-id>@<version>.");
  }
  return { packId: value.slice(0, separator), packVersion: value.slice(separator + 1) };
}

async function countFiles(directory: string, logicalDirectory: string, allowedPaths?: readonly string[]): Promise<number> {
  const entries = await readdir(directory, { withFileTypes: true }).catch((error: unknown) => {
    if (isMissing(error)) return [];
    throw error;
  });
  let count = 0;
  for (const entry of entries) {
    const logicalPath = `${logicalDirectory}/${entry.name}`;
    const allowed = !allowedPaths || allowedPaths.some((path) => path === logicalPath || path.startsWith(`${logicalPath}/`));
    if (!allowed) continue;
    if (entry.isFile()) count += 1;
    else if (entry.isDirectory()) count += await countFiles(join(directory, entry.name), logicalPath, allowedPaths);
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

async function copyEffectiveAsset(
  resolver: ReturnType<typeof createAssetResolver>,
  logicalPath: string,
  target: string,
): Promise<void> {
  const info = await resolver.stat(logicalPath);
  if (info.type === "file") {
    const source = await resolver.resolveFile(logicalPath);
    await cp(source.absolutePath, target, { errorOnExist: true, force: false });
    return;
  }
  await mkdir(target, { recursive: false });
  for (const file of await resolver.listFiles(logicalPath, true)) {
    const source = await resolver.resolveFile(file);
    const relativePath = file.slice(`${logicalPath}/`.length);
    const destination = join(target, ...relativePath.split("/"));
    await mkdir(dirname(destination), { recursive: true });
    await cp(source.absolutePath, destination, { errorOnExist: true, force: false });
  }
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
