import { lstat, realpath } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";
import { writableProjectRoots } from "../../artifacts/roots";

export const readableFileRoots = ["assets", ...writableProjectRoots] as const;
export const writableFileRoots = [...writableProjectRoots] as const;

/** The single project-relative path policy for model-visible file tools. */
export async function resolveAllowedPath(rootDir: string, requestedPath: string, roots: readonly string[]): Promise<string> {
  if (!requestedPath || requestedPath.includes("\0")) throw new Error("Path is required.");
  if (resolve(requestedPath) === requestedPath) throw new Error("Only project-relative paths are allowed.");

  const root = resolve(rootDir);
  const resolved = resolve(root, requestedPath);
  const rel = relative(root, resolved);
  if (rel.startsWith("..") || rel === ".." || resolve(rel) === rel) {
    throw new Error(`Path escapes project root: ${requestedPath}`);
  }

  const normalized = rel.split(sep).join("/");
  if (!roots.includes(normalized.split("/")[0])) {
    throw new Error(`Path must be under one of: ${roots.join(", ")}`);
  }

  const realRoot = await realpath(root);
  let current = root;
  for (const part of normalized.split("/")) {
    current = resolve(current, part);
    const info = await lstat(current).catch((error: unknown) => {
      if (isEnoent(error)) return undefined;
      throw error;
    });
    if (!info) break;
    if (info.isSymbolicLink()) throw new Error(`Symbolic links are not allowed in model-visible paths: ${requestedPath}`);
    if (!isWithin(realRoot, await realpath(current))) {
      throw new Error(`Path escapes project root through a linked path: ${requestedPath}`);
    }
  }
  return resolved;
}

export function isAssetPath(requestedPath: string): boolean {
  const normalized = requestedPath.replaceAll("\\", "/");
  return normalized === "assets" || normalized.startsWith("assets/");
}

export function toProjectPath(rootDir: string, filePath: string): string {
  return relative(rootDir, filePath).split(sep).join("/");
}

export function isEnoent(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "ENOENT");
}

function isWithin(rootPath: string, candidatePath: string): boolean {
  const rel = relative(rootPath, candidatePath);
  return rel === "" || (!rel.startsWith("..") && rel !== ".." && resolve(rel) !== rel);
}
