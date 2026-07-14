import { createHash } from "node:crypto";
import { existsSync, type Stats } from "node:fs";
import { lstat, readFile, readdir, realpath, stat } from "node:fs/promises";
import { dirname, join, posix, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { userConfigDirectory } from "../../config/paths";

export type AssetSource = "project" | "user" | "managed" | "bundled";

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

export type AssetFingerprint = {
  sha256: string;
  files: Array<{ path: string; sha256: string; source: AssetSource }>;
};

export type AssetResolverOptions = {
  env?: NodeJS.ProcessEnv;
  bundledDirectory?: string;
  executablePath?: string;
  managedBaseline?: {
    assetsDirectory: string;
    externalHostAssets: readonly string[];
  };
};

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
    for (const layer of this.layers) {
      const entry = await resolveLayerEntry(layer, normalized);
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
    throw new Error(`Prism asset not found: ${normalized}.`);
  }

  async listFiles(logicalDirectory = "assets", recursive = false): Promise<string[]> {
    const normalized = normalizeAssetPath(logicalDirectory, { allowRoot: true });
    const highest = await this.stat(normalized);
    if (highest.type !== "directory") throw new Error(`Asset path is not a directory: ${normalized}.`);

    return this.listMergedDirectory(normalized, recursive);
  }

  private async listMergedDirectory(logicalDirectory: string, recursive: boolean): Promise<string[]> {
    const merged = new Map<string, "file" | "directory" | "symlink">();
    for (const layer of this.layers) {
      const entry = await resolveLayerEntry(layer, logicalDirectory);
      if (!entry || !entry.info.isDirectory()) continue;
      const entries = await readdir(entry.absolutePath, { withFileTypes: true }).catch((error: unknown) => {
        throw assetAccessError(logicalDirectory, error);
      });
      for (const child of entries) {
        const childPath = `${logicalDirectory}/${child.name}`;
        if (layerAllowsPath(layer, childPath)
          && !merged.has(child.name)
          && (child.isFile() || child.isDirectory() || child.isSymbolicLink())) {
          merged.set(child.name, child.isSymbolicLink() ? "symlink" : child.isDirectory() ? "directory" : "file");
        }
      }
    }

    const files: string[] = [];
    for (const [name, type] of [...merged.entries()].sort(([left], [right]) => left.localeCompare(right))) {
      const logicalPath = `${logicalDirectory}/${name}`;
      if (type === "symlink") throw new Error(`Asset symlinks are not supported: ${logicalPath}.`);
      if (type === "file") files.push(logicalPath);
      else if (recursive) files.push(...await this.listMergedDirectory(logicalPath, true));
    }
    return files;
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

/** Return the package-owned asset directory, independent of the active project. */
export function bundledAssetsDirectory(): string | undefined {
  const candidate = dirname(fileURLToPath(new URL("../../../assets/manifest.json", import.meta.url)));
  return existsSync(join(candidate, "manifest.json")) ? candidate : undefined;
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
    if (entry.source !== "project" && entry.source !== "user" && entry.source !== "managed" && entry.source !== "bundled") return undefined;
    files.push({ path: entry.path, sha256: entry.sha256, source: entry.source });
  }
  return { sha256: candidate.sha256, files };
}

function assetLayers(projectRoot: string, options: AssetResolverOptions): AssetLayer[] {
  const layers: AssetLayer[] = [
    { source: "project", directory: join(projectRoot, "assets"), boundaryDirectory: projectRoot },
    {
      source: "user",
      directory: userAssetsDirectory(options.env),
      boundaryDirectory: userConfigDirectory(options.env),
    },
  ];
  if (options.managedBaseline) {
    layers.push({ source: "managed", directory: options.managedBaseline.assetsDirectory });
  }
  const bundled = options.bundledDirectory ?? bundledAssetsDirectory();
  const allowedPaths = options.managedBaseline?.externalHostAssets;
  if (bundled) layers.push({ source: "bundled", directory: bundled, ...(allowedPaths ? { allowedPaths } : {}) });

  const executable = join(dirname(options.executablePath ?? process.execPath), "assets");
  if (existsSync(join(executable, "manifest.json"))) {
    layers.push({ source: "bundled", directory: executable, ...(allowedPaths ? { allowedPaths } : {}) });
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
  const candidate = join(layer.directory, ...suffix.split("/").filter(Boolean));
  const entry = await lstat(candidate).catch((error: unknown) => {
    if (isMissing(error)) return undefined;
    if (errorCode(error) === "ENOTDIR") {
      throw new Error(`Asset path is shadowed by a file in a higher layer: ${logicalPath}.`);
    }
    throw assetAccessError(logicalPath, error);
  });
  if (!entry) return undefined;

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
