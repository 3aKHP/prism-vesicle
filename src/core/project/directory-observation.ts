import { lstat, readdir } from "node:fs/promises";
import { resolve } from "node:path";

export type ObservedDirectoryEntry = {
  absolutePath: string;
  type: "file" | "directory" | "symlink" | "other";
  size?: number;
  modifiedAt: Date;
};

export type DirectoryObservation = {
  entries: ObservedDirectoryEntry[];
  fileCount: number;
  directoryCount: number;
  otherCount: number;
  truncated: boolean;
};

/** Bounded physical-directory observation; callers project logical paths and policy. */
export async function observeDirectory(
  directoryPath: string,
  options: {
    recursive?: boolean;
    entryLimit?: number;
    directoryLimit?: number;
    maxDepth?: number;
    ignoreNames?: ReadonlySet<string>;
    includeTypes?: ReadonlySet<ObservedDirectoryEntry["type"]>;
    tolerateDescendantErrors?: boolean;
  } = {},
): Promise<DirectoryObservation> {
  const entryLimit = clampPositiveInteger(options.entryLimit ?? 500, "entryLimit", 10_000);
  const directoryLimit = clampPositiveInteger(options.directoryLimit ?? 2_000, "directoryLimit", 10_000);
  const maxDepth = clampNonNegativeInteger(options.maxDepth ?? 8, "maxDepth", 32);
  const entries: ObservedDirectoryEntry[] = [];
  let fileCount = 0;
  let directoryCount = 0;
  let otherCount = 0;
  let visitedDirectories = 0;
  let truncated = false;
  let hardStop = false;

  const visit = async (dir: string, depth: number): Promise<void> => {
    if (hardStop) return;
    if (visitedDirectories >= directoryLimit) {
      truncated = true;
      return;
    }
    visitedDirectories++;
    const children = await readdir(dir, { withFileTypes: true }).catch((error: unknown) => {
      if (depth > 0 && options.tolerateDescendantErrors) {
        truncated = true;
        return undefined;
      }
      throw error;
    });
    if (!children) return;
    for (const child of children.sort((left, right) => left.name.localeCompare(right.name))) {
      if (hardStop) return;
      if (options.ignoreNames?.has(child.name)) continue;
      const absolutePath = resolve(dir, child.name);
      const info = await lstat(absolutePath).catch((error: unknown) => {
        if (options.tolerateDescendantErrors) {
          truncated = true;
          return undefined;
        }
        throw error;
      });
      if (!info) continue;
      const type = info.isSymbolicLink()
        ? "symlink"
        : info.isDirectory()
          ? "directory"
          : info.isFile()
            ? "file"
            : "other";
      const included = !options.includeTypes || options.includeTypes.has(type);
      if (included && entries.length >= entryLimit) {
        truncated = true;
        hardStop = true;
        return;
      }
      if (type === "file") fileCount++;
      else if (type === "directory") directoryCount++;
      else otherCount++;
      if (included) {
        entries.push({
          absolutePath,
          type,
          ...(type === "file" ? { size: info.size } : {}),
          modifiedAt: info.mtime,
        });
      }
      if (options.recursive && type === "directory") {
        if (depth < maxDepth) await visit(absolutePath, depth + 1);
        else truncated = true;
      }
    }
  };

  await visit(directoryPath, 0);
  entries.sort((left, right) => left.absolutePath.localeCompare(right.absolutePath));
  return { entries, fileCount, directoryCount, otherCount, truncated };
}

function clampPositiveInteger(value: number, name: string, max: number): number {
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer.`);
  return Math.min(value, max);
}

function clampNonNegativeInteger(value: number, name: string, max: number): number {
  if (!Number.isInteger(value) || value < 0) throw new Error(`${name} must be a non-negative integer.`);
  return Math.min(value, max);
}
