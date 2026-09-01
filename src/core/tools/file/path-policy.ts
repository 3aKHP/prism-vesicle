import { lstat, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { modelReadableRoots, modelWritableRoots } from "../../project/roots";

export const readableFileRoots = modelReadableRoots;
export const writableFileRoots = [...modelWritableRoots] as const;

/** The single project-relative path policy for model-visible file tools. */
export async function resolveAllowedPath(rootDir: string, requestedPath: string, roots: readonly string[]): Promise<string> {
  if (!requestedPath || requestedPath.includes("\0")) throw new Error("Path is required.");
  if (isAbsolute(requestedPath)) throw new Error("Only project-relative paths are allowed.");

  // The skills mount is resolver-backed, not a project directory; read tools
  // divert it before reaching here, so this fires for writes and any other
  // root-validated access with an instructive error instead of a root-list
  // rejection.
  if (isSkillPath(requestedPath)) {
    throw new Error(
      "skills/ is a read-only mount of activated Skill resources, not a project path; it cannot be written, moved, copied into, or deleted through file tools.",
    );
  }

  const root = resolve(rootDir);
  const resolved = resolve(root, requestedPath);
  const rel = relative(root, resolved);
  if (rel.startsWith("..") || rel === ".." || resolve(rel) === rel) {
    throw new Error(`Path escapes project root: ${requestedPath}`);
  }

  const normalized = rel.split(sep).join("/");
  if (!roots.includes(normalized.split("/")[0])) {
    if (/^VESICLE(?:\.[^.\/]+)?\.md$/i.test(normalized)) {
      throw new Error("VESICLE.md and VESICLE.<engine>.md are host-managed Persistent Instruction files outside the model-visible file roots.");
    }
    throw new Error(`Path must be under one of: ${roots.join(", ")}. Use list_directory with path "." to discover the logical roots.`);
  }

  const realRoot = await realpath(root);
  let current = root;
  for (const part of normalized.split("/")) {
    current = resolve(current, part);
    const info = await lstat(current).catch((error: unknown) => {
      if (isMissingPathError(error)) return undefined;
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

/**
 * Whether a path addresses the `skills/` mount of activated Skills. Read tools
 * divert these to the SkillMount resolver; `resolveAllowedPath` rejects them
 * for every root-validated (write) access.
 */
export function isSkillPath(requestedPath: string): boolean {
  const normalized = requestedPath.replaceAll("\\", "/");
  return normalized === "skills" || normalized.startsWith("skills/");
}

export function toProjectPath(rootDir: string, filePath: string): string {
  return relative(rootDir, filePath).split(sep).join("/");
}

export function isEnoent(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "ENOENT");
}

/** Missing terminals and descendants below a file are both absent observations. */
export function isMissingPathError(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error
    && (error.code === "ENOENT" || error.code === "ENOTDIR"));
}

function isWithin(rootPath: string, candidatePath: string): boolean {
  const rel = relative(rootPath, candidatePath);
  return rel === "" || (!rel.startsWith("..") && rel !== ".." && resolve(rel) !== rel);
}
