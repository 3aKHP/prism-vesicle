import type { Stats } from "node:fs";
import { lstat, mkdir, stat, unlink } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { isEnoent, toProjectPath } from "./path-policy";

export async function assertFile(filePath: string): Promise<Stats> {
  const info = await lstat(filePath);
  if (!info.isFile()) throw new Error("Path must be a file.");
  return info;
}

export async function assertDirectory(directoryPath: string): Promise<Stats> {
  const info = await lstat(directoryPath);
  if (!info.isDirectory()) throw new Error("Path must be a directory.");
  return info;
}

export async function assertMissing(targetPath: string, message: string): Promise<void> {
  const existing = await lstat(targetPath).catch((error: unknown) => {
    if (isEnoent(error)) return undefined;
    throw error;
  });
  if (existing) throw new Error(message);
}

export function assertMutableDirectoryPath(rootDir: string, directoryPath: string): void {
  const projectPath = toProjectPath(rootDir, directoryPath);
  if (!projectPath.includes("/")) {
    throw new Error("Fixed writable roots cannot be created, moved, or deleted.");
  }
}

export async function mutationPathsForTarget(rootDir: string, targetPath: string): Promise<string[]> {
  const root = resolve(rootDir);
  const paths = [toProjectPath(rootDir, targetPath)];
  let current = dirname(targetPath);
  while (current !== root) {
    const exists = await lstat(current).then(() => true).catch((error: unknown) => {
      if (isEnoent(error)) return false;
      throw error;
    });
    if (exists) break;
    paths.push(toProjectPath(rootDir, current));
    current = dirname(current);
  }
  return [...new Set(paths)].sort((left, right) => left.split("/").length - right.split("/").length);
}

export async function prepareTarget(targetPath: string, overwrite: boolean): Promise<void> {
  await mkdir(dirname(targetPath), { recursive: true });
  const existing = await stat(targetPath).catch((error: unknown) => {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return undefined;
    throw error;
  });
  if (!existing) return;
  if (!existing.isFile()) throw new Error("Target path exists and is not a file.");
  if (!overwrite) throw new Error("Target file already exists. Set overwrite=true to replace it.");
  // Single-user TUI contract: overwrite is a stat/unlink/write sequence, not
  // a cross-process atomic replacement protocol.
  await unlink(targetPath);
}
