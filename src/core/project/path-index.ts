import { type Dirent } from "node:fs";
import { relative, sep } from "node:path";
import { projectPathRoot } from "./roots";
import { observeDirectory, type ObservedDirectoryEntry } from "./directory-observation";

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
  const ignored = options.showHidden ? undefined : HIDDEN_ENTRY_NAMES;
  const observed = await observeDirectory(rootDir, {
    recursive: true,
    entryLimit: MAX_PROJECT_PATH_ENTRIES,
    ignoreNames: ignored,
    includeTypes: new Set<ObservedDirectoryEntry["type"]>(["file", "directory"]),
    tolerateDescendantErrors: true,
  });
  return observed.entries.map((entry) => {
    const path = relative(rootDir, entry.absolutePath).split(sep).join("/");
    return { path, kind: entry.type === "directory" ? "dir" : "file" };
  }).filter((entry) => projectPathRoot(entry.path));
}
