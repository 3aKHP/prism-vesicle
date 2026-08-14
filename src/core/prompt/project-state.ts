import { lstat } from "node:fs/promises";
import { join } from "node:path";
import type { AssetResolver } from "../runtime/assets";
import { modelReadableRoots } from "../project/roots";
import { observeDirectory } from "../project/directory-observation";

const maxFilesPerRoot = 1_000;
const maxEntriesPerRoot = 1_024;
const maxDirectoriesPerRoot = 64;
const maxDepth = 4;
const ignoredNames = new Set([".gitkeep", ".vesicle"]);

type RootState = {
  files: number;
  nonFiles: number;
  truncated: boolean;
  status: "ok" | "absent" | "inaccessible";
};

/** Bounded logical orientation; never includes contents or physical paths. */
export async function composeProjectStateBlock(rootDir: string, assets: AssetResolver): Promise<string> {
  const rootStates = await Promise.all(modelReadableRoots.map(async (root) => ({
    root,
    state: root === "assets" ? await countAssetFiles(assets) : await countProjectFiles(join(rootDir, root)),
  })));

  return [
    "<project_state>",
    "Bounded snapshot captured when this turn or delegated task started. File tools may make it stale; query a path again when current state matters.",
    "The model-visible filesystem has these logical roots:",
    ...rootStates.map(({ root, state }) => `- ${root}${root === "assets" ? " (read-only)" : ""}: ${formatRootState(state)}`),
    "Use list_directory with path '.' to query this virtual root. The host project root and its infrastructure are not exposed.",
    "Project-root VESICLE.md and VESICLE.<engine>.md are host-managed Persistent Instructions, not file-tool paths.",
    "</project_state>",
  ].join("\n");
}

// A paused turn keeps the same orientation it started with, just like its
// frozen Persistent Instructions. The cache is intentionally process-local:
// after a restart, rebuilding a continuation is a fresh observation boundary.
const frozenProjectStateBlocks = new Map<string, string>();

export function freezeProjectStateBlock(sessionId: string, block: string): void {
  frozenProjectStateBlocks.set(sessionId, block);
}

export function readFrozenProjectStateBlock(sessionId: string): string | undefined {
  return frozenProjectStateBlocks.get(sessionId);
}

export function clearFrozenProjectStateBlock(sessionId: string): void {
  frozenProjectStateBlocks.delete(sessionId);
}

async function countAssetFiles(assets: AssetResolver): Promise<RootState> {
  try {
    const listing = await assets.listDirectory("assets", {
      recursive: true,
      filesOnly: true,
      limit: maxFilesPerRoot + 1,
      directoryLimit: maxDirectoriesPerRoot,
      maxDepth,
    });
    if (!listing) return { files: 0, nonFiles: 0, truncated: false, status: "absent" };
    return {
      files: Math.min(listing.fileCount, maxFilesPerRoot),
      nonFiles: listing.directoryCount,
      truncated: listing.truncated || listing.fileCount > maxFilesPerRoot,
      status: "ok",
    };
  } catch {
    return { files: 0, nonFiles: 0, truncated: false, status: "inaccessible" };
  }
}

async function countProjectFiles(rootPath: string): Promise<RootState> {
  try {
    const root = await lstat(rootPath);
    if (!root.isDirectory()) return { files: 0, nonFiles: 0, truncated: false, status: "inaccessible" };
    const observed = await observeDirectory(rootPath, {
      recursive: true,
      entryLimit: maxEntriesPerRoot,
      directoryLimit: maxDirectoriesPerRoot,
      maxDepth,
      ignoreNames: ignoredNames,
      tolerateDescendantErrors: true,
    });
    return {
      files: Math.min(observed.fileCount, maxFilesPerRoot),
      nonFiles: observed.directoryCount + observed.otherCount,
      truncated: observed.truncated || observed.fileCount > maxFilesPerRoot,
      status: "ok",
    };
  } catch (error) {
    if (errorCode(error) === "ENOENT") return { files: 0, nonFiles: 0, truncated: false, status: "absent" };
    return { files: 0, nonFiles: 0, truncated: false, status: "inaccessible" };
  }
}

function formatRootState(state: RootState): string {
  if (state.status === "absent") return "absent";
  if (state.status === "inaccessible") return "inaccessible";
  if (state.files === 0) {
    if (state.truncated) return "0 observed files (scan truncated)";
    return state.nonFiles === 0 ? "empty (0 files)" : "0 files (contains directories or other entries)";
  }
  return `${state.truncated ? "at least " : ""}${state.files} file${state.files === 1 ? "" : "s"}`;
}

function errorCode(error: unknown): string | undefined {
  return error && typeof error === "object" && "code" in error && typeof error.code === "string"
    ? error.code
    : undefined;
}
