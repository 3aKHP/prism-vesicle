import { copyFile, lstat, mkdir, readdir, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { assertProjectRelativePath } from "./paths";

/**
 * File-management primitives for the Workspace page tree (Scope B / #62,
 * milestone B4): create / rename-move / copy / delete, all driven by the human
 * at the keyboard. Like the B3 editor, the path policy is project-root-bounded
 * (every target goes through `assertProjectRelativePath`) rather than the
 * stricter writable-subroot policy the model-visible file tools enforce — the
 * model never reaches this surface.
 *
 * Delete is a recycle-bin move into `.vesicle/trash/` (already in the tree's
 * hidden-entry list, never committed); permanent deletion is intentionally not
 * offered. Directories are only removed when empty so a single keypress cannot
 * drop a whole subtree.
 */

/**
 * Move a file or directory into the project's `.vesicle/trash/`, timestamped so
 * repeated deletes of same-named entries do not collide. Returns the trash path
 * (project-relative) so the status line can tell the user where it went for
 * manual recovery — B4 ships no restore UI by design.
 */
export async function trashEntry(rootDir: string, relPath: string): Promise<string> {
  const abs = assertProjectRelativePath(rootDir, relPath);
  const info = await lstat(abs).catch((error) => {
    if (isEnoent(error)) return null;
    throw error;
  });
  if (!info) throw new Error(`${relPath} does not exist.`);
  if (info.isDirectory()) {
    const entries = await readdir(abs).catch(() => []);
    if (entries.length > 0) {
      throw new Error(`${relPath} is not empty — delete its contents first (directories are removed only when empty).`);
    }
  }
  const stamp = timestamp();
  const trashAbs = join(rootDir, ".vesicle", "trash", `${stamp}-${basename(abs)}`);
  await mkdir(dirname(trashAbs), { recursive: true });
  await rename(abs, trashAbs);
  return relPathTo(rootDir, trashAbs);
}

/** Create an empty file, refusing to overwrite an existing one. */
export async function createFile(rootDir: string, relPath: string): Promise<void> {
  const abs = assertProjectRelativePath(rootDir, relPath);
  await mkdir(dirname(abs), { recursive: true });
  try {
    await writeFile(abs, "", { flag: "wx" });
  } catch (error) {
    if (isEexist(error)) throw new Error(`${relPath} already exists.`);
    throw error;
  }
}

/** Create a directory (with parents), refusing to overwrite an existing one. */
export async function createDirectory(rootDir: string, relPath: string): Promise<void> {
  const abs = assertProjectRelativePath(rootDir, relPath);
  const existing = await lstat(abs).catch((error) => {
    if (isEnoent(error)) return null;
    throw error;
  });
  if (existing) throw new Error(`${relPath} already exists.`);
  await mkdir(abs, { recursive: true });
}

/**
 * Rename/move a file or directory. The caller checks the target first and, if
 * it exists, routes through an overwrite confirm — this primitive assumes the
 * target is free. Renaming onto an existing directory is rejected (a directory
 * cannot be silently replaced).
 */
export async function moveEntry(rootDir: string, source: string, target: string): Promise<void> {
  const srcAbs = assertProjectRelativePath(rootDir, source);
  const targetAbs = assertProjectRelativePath(rootDir, target);
  await mkdir(dirname(targetAbs), { recursive: true });
  await rename(srcAbs, targetAbs);
}

/**
 * Copy a file or directory tree. Existing targets are the caller's concern
 * (overwrite confirm); this primitive assumes the target is free.
 */
export async function copyEntry(rootDir: string, source: string, target: string): Promise<void> {
  const srcAbs = assertProjectRelativePath(rootDir, source);
  const targetAbs = assertProjectRelativePath(rootDir, target);
  await mkdir(dirname(targetAbs), { recursive: true });
  const info = await lstat(srcAbs);
  if (info.isDirectory()) {
    await copyTree(srcAbs, targetAbs);
  } else {
    await copyFile(srcAbs, targetAbs);
  }
}

async function copyTree(srcAbs: string, targetAbs: string): Promise<void> {
  await mkdir(targetAbs, { recursive: true });
  const entries = await readdir(srcAbs, { withFileTypes: true });
  for (const entry of entries) {
    const srcChild = join(srcAbs, entry.name);
    const targetChild = join(targetAbs, entry.name);
    if (entry.isDirectory()) await copyTree(srcChild, targetChild);
    else if (entry.isFile() || entry.isSymbolicLink()) await copyFile(srcChild, targetChild);
  }
}

/** Remove an existing target file for move/copy overwrite; never remove a directory tree. */
export async function removeFile(rootDir: string, relPath: string): Promise<void> {
  const abs = assertProjectRelativePath(rootDir, relPath);
  const info = await lstat(abs).catch((error) => {
    if (isEnoent(error)) return null;
    throw error;
  });
  if (!info) return;
  if (info.isDirectory()) {
    throw new Error(`${relPath} is a directory and cannot be overwritten.`);
  }
  await rm(abs, { recursive: false });
}

/** Whether a project-relative path currently exists (file or directory). */
export async function entryExists(rootDir: string, relPath: string): Promise<boolean> {
  try {
    await lstat(assertProjectRelativePath(rootDir, relPath));
    return true;
  } catch {
    return false;
  }
}

function relPathTo(rootDir: string, abs: string): string {
  return abs.slice(join(rootDir).length).replace(/^[\\/]+/, "").replace(/\\/g, "/");
}

function timestamp(): string {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}` +
    `-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
  );
}

function isEnoent(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && (error as { code: string }).code === "ENOENT");
}

function isEexist(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && (error as { code: string }).code === "EEXIST");
}
