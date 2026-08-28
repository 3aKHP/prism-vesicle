import { type Dirent } from "node:fs";
import { readdir } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { projectPathRoot } from "./roots";

export type ProjectPathEntry = {
  path: string;
  kind: "dir" | "file";
};

export const HIDDEN_ENTRY_NAMES = new Set([".git", ".vesicle", "node_modules", "dist"]);
const MAX_PROJECT_PATH_ENTRIES = 2000;

export function isHiddenProjectName(name: string): boolean {
  return name.startsWith(".") || HIDDEN_ENTRY_NAMES.has(name);
}

/** List bounded, visible project-relative files and directories without following symlinks. */
export async function buildProjectPathIndex(
  rootDir: string,
  options: { showHidden?: boolean } = {},
): Promise<ProjectPathEntry[]> {
  const entries: ProjectPathEntry[] = [];
  async function walk(absDir: string): Promise<void> {
    if (entries.length >= MAX_PROJECT_PATH_ENTRIES) return;
    let children: Dirent[];
    try {
      children = await readdir(absDir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const child of children) {
      if (entries.length >= MAX_PROJECT_PATH_ENTRIES) return;
      if (!options.showHidden && isHiddenProjectName(child.name)) continue;
      if (child.isSymbolicLink()) continue;
      const abs = join(absDir, child.name);
      const path = relative(rootDir, abs).split(sep).join("/");
      if (!projectPathRoot(path)) continue;
      if (child.isDirectory()) {
        entries.push({ path, kind: "dir" });
        await walk(abs);
      } else if (child.isFile()) {
        entries.push({ path, kind: "file" });
      }
    }
  }
  await walk(rootDir);
  return entries.sort((left, right) => left.path.localeCompare(right.path));
}
