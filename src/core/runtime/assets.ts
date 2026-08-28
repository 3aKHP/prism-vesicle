import { createHash } from "node:crypto";
import { existsSync, type Stats } from "node:fs";
import { lstat, readFile, readdir, realpath, stat } from "node:fs/promises";
import { dirname, join, posix, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { userConfigDirectory } from "../../config/paths";

declare const VESICLE_NPM_BUNDLE: boolean | undefined;

export type AssetSource = "project" | "user" | "managed" | "bundled" | "host";

export type AssetLayer = {
  source: AssetSource;
  directory: string;
  /** Trusted host boundary for editable layers; bundled roots are trusted directly. */
  boundaryDirectory?: string;
  /** Restrict a recovery layer to exact files and their ancestor directories. */
  allowedPaths?: readonly string[];
};

export type ResolvedAsset = {
  logicalPath: string;
  absolutePath: string;
  source: AssetSource;
  size: number;
  modifiedAt: Date;
};

export type AssetStat = {
  logicalPath: string;
  type: "file" | "directory";
  source: AssetSource;
  size: number;
  modifiedAt: Date;
};

export type AssetDirectoryEntry = {
  path: string;
  type: "file" | "directory";
  size?: number;
  modifiedAt: Date;
};

export type AssetDirectoryListing = {
  entries: AssetDirectoryEntry[];
  fileCount: number;
  directoryCount: number;
  truncated: boolean;
};

export type AssetFingerprint = {
  sha256: string;
  files: Array<{ path: string; sha256: string; source: AssetSource }>;
};

export type AssetResolverOptions = {
  env?: NodeJS.ProcessEnv;
  includeOverrides?: boolean;
  bundledDirectory?: string;
  hostAssetsDirectory?: string;
  executablePath?: string;
  managedBaseline?: {
    assetsDirectory: string;
    externalHostAssets: readonly string[];
    source?: "managed" | "bundled";
  };
};

function clampListingLimit(value: number): number {
  if (!Number.isInteger(value) || value <= 0) throw new Error("Asset listing limit must be a positive integer.");
  return Math.min(value, 2_000);
}

export type BundledHarnessLayout = {
  rootDirectory: string;
  manifestPath: string;
  assetsDirectory: string;
  hostAssetsDirectory: string;
};

export const bundledHostAssetPaths = [
  "assets/agents/explore.agent.yaml",
  "assets/agents/general.agent.yaml",
  "assets/agents/plan.agent.yaml",
  "assets/agents/research.agent.yaml",
  "assets/agents/reviewer.agent.yaml",
  "assets/prompts/agents/base.md",
  "assets/prompts/agents/explore.md",
  "assets/prompts/agents/general.md",
  "assets/prompts/agents/plan.md",
  "assets/prompts/agents/research.md",
  "assets/prompts/agents/reviewer.md",
  "assets/prompts/shared/vesicle-base.md",
  "assets/prompts/shared/side-question.md",
  "assets/prompts/shared/init-project.md",
] as const;

export const bundledHostAgentIds = ["explore", "general", "plan", "research", "reviewer"] as const;

export function isBundledHostAgentId(value: string): value is typeof bundledHostAgentIds[number] {
  return (bundledHostAgentIds as readonly string[]).includes(value);
}

/**
 * Resolve the effective read-only `assets/` namespace as a sparse overlay:
 * project overrides user overrides, and both fall back file-by-file to the
 * immutable assets shipped with the active package or standalone release.
 */
export class AssetResolver {
  readonly projectRoot: string;
  readonly layers: readonly AssetLayer[];

  constructor(projectRoot = process.cwd(), options: AssetResolverOptions = {}) {
    this.projectRoot = resolve(projectRoot);
    this.layers = assetLayers(this.projectRoot, options);
  }

  async resolveFile(logicalPath: string): Promise<ResolvedAsset> {
    const normalized = normalizeAssetPath(logicalPath);
    for (const layer of this.layers) {
      const entry = await resolveLayerEntry(layer, normalized);
      if (!entry) continue;
      if (!entry.info.isFile()) {
        throw new Error(`Asset path is not a file: ${normalized}.`);
      }
      return {
        logicalPath: normalized,
        absolutePath: entry.absolutePath,
        source: layer.source,
        size: entry.info.size,
        modifiedAt: entry.info.mtime,
      };
    }
    throw new Error(`Prism asset not found: ${normalized}.`);
  }

  async stat(logicalPath: string): Promise<AssetStat> {
    const normalized = normalizeAssetPath(logicalPath, { allowRoot: true });
    const info = await this.statIfExists(normalized);
    if (info) return info;
    throw new Error(`Prism asset not found: ${normalized}.`);
  }

  async statIfExists(logicalPath: string): Promise<AssetStat | undefined> {
    const normalized = normalizeAssetPath(logicalPath, { allowRoot: true });
    for (const layer of this.layers) {
      // A file in a higher overlay shadows all descendants in lower layers.
      // `resolveLayerEntry` reports that boundary explicitly; do not fall
      // through to a lower layer with a contradictory logical shape.
      let shadowed = false;
      const entry = await resolveLayerEntry(layer, normalized).catch((error: unknown) => {
        if (error instanceof AssetPathShadowError) {
          shadowed = true;
          return undefined;
        }
        throw error;
      });
      if (shadowed) return undefined;
      if (!entry) continue;
      if (!entry.info.isFile() && !entry.info.isDirectory()) {
        throw new Error(`Asset path is neither a file nor a directory: ${normalized}.`);
      }
      return {
        logicalPath: normalized,
        type: entry.info.isDirectory() ? "directory" : "file",
        source: layer.source,
        size: entry.info.size,
        modifiedAt: entry.info.mtime,
      };
    }
    return undefined;
  }

  /** List the effective sparse overlay without exposing any physical layer. */
  async listDirectory(
    logicalDirectory = "assets",
    options: { recursive?: boolean; limit?: number; filesOnly?: boolean; directoryLimit?: number; maxDepth?: number } = {},
  ): Promise<AssetDirectoryListing | undefined> {
    const normalized = normalizeAssetPath(logicalDirectory, { allowRoot: true });
    const highest = await this.statIfExists(normalized);
    if (!highest) return undefined;
    if (highest.type !== "directory") throw new Error(`Asset path is not a directory: ${normalized}.`);

    const limit = clampListingLimit(options.limit ?? 500);
    const directoryLimit = Math.max(1, Math.min(options.directoryLimit ?? 2_000, 10_000));
    const maxDepth = Math.max(0, Math.min(options.maxDepth ?? 8, 32));
    const entries: AssetDirectoryEntry[] = [];
    let fileCount = 0;
    let directoryCount = 0;
    let visitedDirectories = 0;
    let truncated = false;
    let hardStop = false;
    const visit = async (directory: string, depth: number): Promise<void> => {
      if (hardStop) return;
      if (visitedDirectories >= directoryLimit) {
        truncated = true;
        return;
      }
      visitedDirectories++;
      const merged = await this.mergedDirectoryChildren(directory);
      for (const [name, child] of merged) {
        if (hardStop) return;
        const path = `${directory}/${name}`;
        const included = !options.filesOnly || child.info.isFile();
        if (included && entries.length >= limit) {
          truncated = true;
          hardStop = true;
          return;
        }
        if (child.info.isFile()) fileCount++;
        else directoryCount++;
        if (included) {
          entries.push({
            path,
            type: child.info.isDirectory() ? "directory" : "file",
            ...(child.info.isFile() ? { size: child.info.size } : {}),
            modifiedAt: child.info.mtime,
          });
        }
        if (options.recursive && child.info.isDirectory()) {
          if (depth < maxDepth) await visit(path, depth + 1);
          else truncated = true;
        }
      }
    };
    await visit(normalized, 0);
    entries.sort((left, right) => left.path.localeCompare(right.path));
    return { entries, fileCount, directoryCount, truncated };
  }

  async listFiles(logicalDirectory = "assets", recursive = false): Promise<string[]> {
    const normalized = normalizeAssetPath(logicalDirectory, { allowRoot: true });
    const highest = await this.stat(normalized);
    if (highest.type !== "directory") throw new Error(`Asset path is not a directory: ${normalized}.`);

    return this.listMergedDirectory(normalized, recursive);
  }

  private async listMergedDirectory(logicalDirectory: string, recursive: boolean): Promise<string[]> {
    const files: string[] = [];
    for (const [name, entry] of await this.mergedDirectoryChildren(logicalDirectory)) {
      const logicalPath = `${logicalDirectory}/${name}`;
      if (entry.info.isFile()) files.push(logicalPath);
      else if (recursive) files.push(...await this.listMergedDirectory(logicalPath, true));
    }
    return files;
  }

  private async mergedDirectoryChildren(
    logicalDirectory: string,
  ): Promise<Map<string, { info: Stats }>> {
    const merged = new Map<string, { info: Stats }>();
    for (const layer of this.layers) {
      let shadowed = false;
      const entry = await resolveLayerEntry(layer, logicalDirectory).catch((error: unknown) => {
        if (error instanceof AssetPathShadowError) {
          shadowed = true;
          return undefined;
        }
        throw error;
      });
      if (shadowed || entry?.info.isFile()) break;
      if (!entry?.info.isDirectory()) continue;
      const entries = await readdir(entry.absolutePath, { withFileTypes: true }).catch((error: unknown) => {
        throw assetAccessError(logicalDirectory, error);
      });
      for (const child of entries) {
        const childPath = `${logicalDirectory}/${child.name}`;
        if (!layerAllowsPath(layer, childPath) || merged.has(child.name)) continue;
        if (child.isSymbolicLink()) throw new Error(`Asset symlinks are not supported: ${childPath}.`);
        if (!child.isFile() && !child.isDirectory()) continue;
        // `logicalDirectory` has already been resolved through the same strict
        // layer guard. Resolve the child for metadata and boundary validation;
        // the first visible child wins, matching ordinary overlay reads.
        const childEntry = await resolveLayerEntry(layer, childPath);
        if (childEntry) merged.set(child.name, { info: childEntry.info });
      }
    }
    return new Map([...merged.entries()].sort(([left], [right]) => left.localeCompare(right)));
  }

  async readText(logicalPath: string): Promise<string> {
    return Buffer.from(await this.readBytes(logicalPath)).toString("utf8");
  }

  async readBytes(logicalPath: string): Promise<Uint8Array> {
    const resolved = await this.resolveFile(logicalPath);
    return readFile(resolved.absolutePath).catch((error: unknown) => {
      throw assetAccessError(resolved.logicalPath, error);
    });
  }

  async fingerprint(logicalPaths: readonly string[]): Promise<AssetFingerprint> {
    const files = await Promise.all([...new Set(logicalPaths)].sort().map(async (path) => {
      const resolved = await this.resolveFile(path);
      const bytes = await this.readBytes(resolved.logicalPath);
      return {
        path: resolved.logicalPath,
        sha256: createHash("sha256").update(bytes).digest("hex"),
        source: resolved.source,
      };
    }));
    const sha256 = createHash("sha256")
      .update(files.map((file) => `${file.path}\0${file.sha256}`).join("\n"))
      .digest("hex");
    return { sha256, files };
  }
}

export function createAssetResolver(
  projectRoot = process.cwd(),
  options: AssetResolverOptions = {},
): AssetResolver {
  return new AssetResolver(projectRoot, options);
}

export function userAssetsDirectory(env: NodeJS.ProcessEnv = process.env): string {
  return join(userConfigDirectory(env), "assets");
}

/** Locate the complete V10 pack and host extensions shipped with this runtime. */
export function bundledHarnessLayout(executablePath = process.execPath): BundledHarnessLayout | undefined {
  const manifestUrl = typeof VESICLE_NPM_BUNDLE === "boolean" && VESICLE_NPM_BUNDLE
    ? new URL("../../harness-manifest.json", import.meta.url)
    : new URL("../../../harness-manifest.json", import.meta.url);
  const moduleRoot = dirname(fileURLToPath(manifestUrl));
  const roots = [...new Set([moduleRoot, dirname(executablePath)].map((root) => resolve(root)))];
  for (const rootDirectory of roots) {
    const manifestPath = join(rootDirectory, "harness-manifest.json");
    const assetsDirectory = join(rootDirectory, "assets");
    const hostAssetsDirectory = join(rootDirectory, "host-assets");
    if (existsSync(manifestPath)) {
      return { rootDirectory, manifestPath, assetsDirectory, hostAssetsDirectory };
    }
  }
  return undefined;
}

/** Return the package-owned V10 asset directory, independent of the active project. */
export function bundledAssetsDirectory(executablePath = process.execPath): string | undefined {
  return bundledHarnessLayout(executablePath)?.assetsDirectory;
}

export function bundledHostAssetsDirectory(executablePath = process.execPath): string | undefined {
  return bundledHarnessLayout(executablePath)?.hostAssetsDirectory;
}

export function normalizeAssetPath(
  requestedPath: string,
  options: { allowRoot?: boolean } = {},
): string {
  if (!requestedPath || requestedPath.includes("\0")) throw new Error("Asset path is required.");
  const slashPath = requestedPath.replaceAll("\\", "/");
  if (slashPath.startsWith("/") || /^[A-Za-z]:\//.test(slashPath)) {
    throw new Error("Only logical assets/... paths are allowed.");
  }
  const parts = slashPath.split("/");
  if (parts.some((part) => part === "" || part === "." || part === "..")) {
    throw new Error(`Unsafe asset path: ${requestedPath}.`);
  }
  const normalized = posix.normalize(slashPath);
  if (normalized !== "assets" && !normalized.startsWith("assets/")) {
    throw new Error(`Asset path must be under assets/: ${requestedPath}.`);
  }
  if (normalized === "assets" && !options.allowRoot) {
    throw new Error("Asset path must name a file below assets/.");
  }
  return normalized;
}

export function parseAssetFingerprint(value: unknown): AssetFingerprint | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const candidate = value as Partial<AssetFingerprint>;
  if (typeof candidate.sha256 !== "string" || !Array.isArray(candidate.files)) return undefined;
  const files: AssetFingerprint["files"] = [];
  for (const file of candidate.files) {
    if (!file || typeof file !== "object" || Array.isArray(file)) return undefined;
    const entry = file as Partial<AssetFingerprint["files"][number]>;
    if (typeof entry.path !== "string" || typeof entry.sha256 !== "string") return undefined;
    if (entry.source !== "project" && entry.source !== "user" && entry.source !== "managed"
      && entry.source !== "bundled" && entry.source !== "host") return undefined;
    files.push({ path: entry.path, sha256: entry.sha256, source: entry.source });
  }
  return { sha256: candidate.sha256, files };
}

function assetLayers(projectRoot: string, options: AssetResolverOptions): AssetLayer[] {
  const layers: AssetLayer[] = [];
  const projectDirectory = join(projectRoot, "assets");
  if (options.includeOverrides !== false) {
    if (!options.managedBaseline || resolve(projectDirectory) !== resolve(options.managedBaseline.assetsDirectory)) {
      layers.push({ source: "project", directory: projectDirectory, boundaryDirectory: projectRoot });
    }
    layers.push({
      source: "user",
      directory: userAssetsDirectory(options.env),
      boundaryDirectory: userConfigDirectory(options.env),
    });
  }
  if (options.managedBaseline) {
    layers.push({
      source: options.managedBaseline.source ?? "managed",
      directory: options.managedBaseline.assetsDirectory,
    });
  } else {
    const bundled = options.bundledDirectory ?? bundledAssetsDirectory(options.executablePath);
    if (bundled) layers.push({ source: "bundled", directory: bundled });
  }
  const hostAssets = options.hostAssetsDirectory
    ?? (options.managedBaseline ? options.bundledDirectory : undefined)
    ?? (options.bundledDirectory ? undefined : bundledHostAssetsDirectory(options.executablePath));
  if (hostAssets) {
    const allowedPaths = [...new Set([
      ...bundledHostAssetPaths,
      ...(options.managedBaseline?.externalHostAssets ?? []),
    ])];
    layers.push({ source: "host", directory: hostAssets, allowedPaths });
  }

  const seen = new Set<string>();
  return layers.filter((layer) => {
    const key = resolve(layer.directory);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function resolveLayerEntry(
  layer: AssetLayer,
  logicalPath: string,
): Promise<{ absolutePath: string; info: Stats } | undefined> {
  if (!layerAllowsPath(layer, logicalPath)) return undefined;
  const suffix = logicalPath === "assets" ? "" : logicalPath.slice("assets/".length);
  const suffixParts = suffix.split("/").filter(Boolean);
  const candidate = join(layer.directory, ...suffixParts);
  try {
    await lstat(candidate);
  } catch (error) {
    if (errorCode(error) === "ENOTDIR" || (isMissing(error) && await hasFileAncestor(layer, logicalPath, suffixParts))) {
      throw new AssetPathShadowError(logicalPath);
    }
    if (isMissing(error)) return undefined;
    throw assetAccessError(logicalPath, error);
  }

  const [rootPath, absolutePath] = await Promise.all([realpath(layer.directory), realpath(candidate)]).catch((error: unknown) => {
    throw assetAccessError(logicalPath, error);
  });
  if (layer.boundaryDirectory) {
    const boundary = await realpath(layer.boundaryDirectory).catch((error: unknown) => {
      throw assetAccessError(logicalPath, error);
    });
    assertPathInside(boundary, rootPath, `Asset layer root escapes its ${layer.source} boundary: ${logicalPath}.`);
  }
  const rel = relative(rootPath, absolutePath);
  if (rel === ".." || rel.startsWith(`..${sep}`) || resolve(rel) === rel) {
    throw new Error(`Asset path escapes its layer: ${logicalPath}.`);
  }
  const expected = resolve(rootPath, ...suffix.split("/").filter(Boolean));
  if (expected !== absolutePath) {
    throw new Error(`Asset symlinks are not supported: ${logicalPath}.`);
  }
  const info = await stat(absolutePath).catch((error: unknown) => {
    throw assetAccessError(logicalPath, error);
  });
  return { absolutePath, info };
}

/** Windows reports a descendant below a regular file as ENOENT, not ENOTDIR. */
async function hasFileAncestor(
  layer: AssetLayer,
  logicalPath: string,
  suffixParts: readonly string[],
): Promise<boolean> {
  let current = layer.directory;
  for (const part of suffixParts.slice(0, -1)) {
    current = join(current, part);
    let info: Stats;
    try {
      info = await lstat(current);
    } catch (error) {
      if (isMissing(error) || errorCode(error) === "ENOTDIR") return false;
      throw assetAccessError(logicalPath, error);
    }
    if (info.isSymbolicLink()) throw new Error(`Asset symlinks are not supported: ${logicalPath}.`);
    if (info.isFile()) return true;
  }
  return false;
}

class AssetPathShadowError extends Error {
  constructor(logicalPath: string) {
    super(`Asset path is shadowed by a file in a higher layer: ${logicalPath}.`);
    this.name = "AssetPathShadowError";
  }
}

function layerAllowsPath(layer: AssetLayer, logicalPath: string): boolean {
  if (!layer.allowedPaths) return true;
  return layer.allowedPaths.some((allowed) => allowed === logicalPath || allowed.startsWith(`${logicalPath}/`));
}

function isMissing(error: unknown): boolean {
  return errorCode(error) === "ENOENT";
}

function errorCode(error: unknown): string | undefined {
  return error && typeof error === "object" && "code" in error && typeof error.code === "string"
    ? error.code
    : undefined;
}

function assetAccessError(logicalPath: string, error: unknown): Error {
  const code = errorCode(error);
  return new Error(`Cannot access Prism asset ${logicalPath}${code ? ` (${code})` : ""}.`);
}

function assertPathInside(boundary: string, candidate: string, message: string): void {
  const rel = relative(boundary, candidate);
  if (rel === ".." || rel.startsWith(`..${sep}`) || resolve(rel) === rel) throw new Error(message);
}
