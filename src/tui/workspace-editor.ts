import { mkdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import type { Stats } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { OVERSIZED_BYTES, PREVIEW_LINE_CAP, type WorkspaceFilePreview } from "./workspace-files";

/**
 * Editor kernel for the Workspace page (Scope B / #62, milestone B3): the
 * user-driven file editor. This is the host-side counterpart to the read-only
 * viewer — it owns the bits the OpenTUI textarea has no concept of: a
 * project-root-bounded path guard, crash-safe atomic writes, plain-text find,
 * and mtime probes for external-modification detection.
 *
 * Boundary: unlike the model-visible file tools (`core/tools/file`), the
 * editor is driven by the human at the keyboard, so its path policy is
 * project-root-bounded rather than restricted to the writable subroots. The
 * model never reaches this surface. The textarea component itself (one
 * instance per open file, preserving per-file undo) lives in WorkspacePage;
 * this module holds only the pure I/O and arithmetic the controller drives it
 * with.
 */

export type EditorReadonlyReason =
  | "image"
  | "binary"
  | "oversized"
  | "symlink"
  | "permission";

export type EditableFileRead = {
  /** Project-relative posix path. */
  relPath: string;
  content: string;
  mtimeMs: number;
  bytes: number;
};

/**
 * Normalize a project-relative path and assert it stays inside the project
 * root. Rejects absolute paths, NUL bytes, and `..` traversal. Returns the
 * resolved absolute path. Posix-style input (`a/b/c`) is accepted on every
 * platform; the resolved path uses the platform separator.
 */
export function assertProjectRelativePath(rootDir: string, relPath: string): string {
  if (!relPath || relPath.includes("\0")) throw new Error("Path is required.");
  const posix = relPath.replace(/\\/g, "/");
  if (posix.startsWith("/")) throw new Error("Only project-relative paths are allowed.");
  const root = resolve(rootDir);
  const resolved = resolve(root, posix);
  const rel = relative(root, resolved);
  if (rel === "" || rel === ".." || rel.startsWith("..") || resolve(rel) === rel) {
    throw new Error(`Path escapes project root: ${relPath}`);
  }
  return resolved;
}

/**
 * Whether a preview is eligible for the editable textarea. Mirrors the B2
 * viewer's downgrade thresholds: image and binary files are never editable,
 * oversized or over-cap files are read-only, and symlinks and read-only files
 * stay in the viewer. The textarea only ever opens for in-bounds, writable,
 * regular text or markdown.
 */
export function isEditablePreview(preview: WorkspaceFilePreview): boolean {
  if (preview.kind !== "text" && preview.kind !== "markdown") return false;
  if (preview.oversized || preview.truncated) return false;
  if (preview.symlink || preview.readonly) return false;
  return true;
}

/**
 * Crash-safe write: write to a sibling temp file then rename. A direct
 * `writeFile` would truncate the destination on a mid-write crash; temp +
 * rename leaves the original intact until the new bytes are fully on disk.
 * The temp name is unique per process so two Vesicle instances do not collide.
 */
export async function atomicWriteFile(absPath: string, content: string): Promise<void> {
  await mkdir(dirname(absPath), { recursive: true });
  const tmp = `${absPath}.vesicle-edit.${process.pid}.tmp`;
  await writeFile(tmp, content, "utf8");
  try {
    await rename(tmp, absPath);
  } catch (error) {
    await safeUnlink(tmp);
    throw error;
  }
}

async function safeUnlink(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch {
    // best effort — the rename failure is the real error
  }
}

/** Read the full text of an editable file plus its current mtime. */
export async function readEditableFile(
  rootDir: string,
  relPath: string,
): Promise<EditableFileRead | null> {
  const abs = assertProjectRelativePath(rootDir, relPath);
  let info: Stats;
  try {
    info = await stat(abs);
  } catch {
    return null;
  }
  if (!info.isFile()) return null;
  const content = await readFile(abs, "utf8");
  return { relPath: relPath.replace(/\\/g, "/"), content, mtimeMs: info.mtimeMs, bytes: info.size };
}

/** Current mtime for a project-relative file, or null if it no longer exists. */
export async function readMtimeMs(rootDir: string, relPath: string): Promise<number | null> {
  try {
    const info = await stat(assertProjectRelativePath(rootDir, relPath));
    return info.isFile() ? info.mtimeMs : null;
  } catch {
    return null;
  }
}

/**
 * Plain-text substring match offsets over a buffer. Returns the start offset
 * of every non-overlapping match (empty query → no matches). The controller
 * maps these to `setSelection`/`setCursorByOffset` on the textarea.
 */
export function computeFindOffsets(text: string, query: string): number[] {
  if (!query) return [];
  const offsets: number[] = [];
  let from = 0;
  while (from <= text.length) {
    const hit = text.indexOf(query, from);
    if (hit < 0) break;
    offsets.push(hit);
    from = hit + query.length;
  }
  return offsets;
}

export { OVERSIZED_BYTES, PREVIEW_LINE_CAP };
