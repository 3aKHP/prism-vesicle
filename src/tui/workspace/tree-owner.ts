import { createSignal } from "solid-js";
import {
  buildFileIndex,
  flattenVisibleTree,
  matchFiles,
  statEntry,
  type WorkspaceTreeNode,
  type WorkspaceVisibleRow,
} from "./tree-data";
import type { WorkspaceMutation } from "./types";

/**
 * Workspace file-tree owner (Scope B / #62). Owns the tree navigation state —
 * expanded paths, hidden-entry visibility, flattened rows, selection, loading,
 * the per-directory scan cache, the quick-open index, and the quick-open panel
 * state — plus the functions that evolve that state.
 *
 * Boundary: this owner knows nothing about editor buffers, dirty state,
 * validation snapshots, file mutations, or external editors. Opening a file
 * crosses into other domains, so it is expressed as a narrow port
 * (`onOpenPath`) that the controller facade wires to its open pipeline; the
 * owner never reaches into buffer/validation state itself.
 */

export type TreeOwnerOptions = {
  rootDir: string;
  /** Open a project-relative path (preview + buffer + validation pipeline). */
  onOpenPath: (relPath: string) => Promise<boolean>;
  /** Surface a tree load failure on the status line (narrow error port). */
  onLoadError: (message: string) => void;
};

function clampIndex(index: number, length: number): number {
  if (length <= 0) return 0;
  return Math.max(0, Math.min(index, length - 1));
}

export function createTreeOwner(options: TreeOwnerOptions) {
  const { rootDir } = options;

  const [expanded, setExpanded] = createSignal<ReadonlySet<string>>(new Set());
  const [showHidden, setShowHidden] = createSignal(false);
  const [rows, setRows] = createSignal<WorkspaceVisibleRow[]>([]);
  const [selectedIndex, setSelectedIndex] = createSignal(0);
  const [loading, setLoading] = createSignal(false);
  const scanCache = new Map<string, WorkspaceTreeNode[]>();
  let flattenVersion = 0;

  // —— quick open ——
  const [quickOpenActive, setQuickOpenActive] = createSignal(false);
  const [quickQuery, setQuickQuery] = createSignal("");
  const [quickIndex, setQuickIndex] = createSignal(0);
  const [fileIndex, setFileIndex] = createSignal<string[]>([]);

  const quickMatches = () => matchFiles(fileIndex(), quickQuery());

  async function recomputeRows(): Promise<void> {
    const version = ++flattenVersion;
    const next = await flattenVisibleTree(rootDir, expanded(), { showHidden: showHidden() }, scanCache);
    if (version !== flattenVersion) return;
    setRows(next);
    setSelectedIndex((index) => clampIndex(index, next.length));
  }

  async function rebuildIndex(): Promise<void> {
    setFileIndex(await buildFileIndex(rootDir, { showHidden: showHidden() }));
  }

  let loadPromise: Promise<void> | null = null;

  async function ensureLoaded(): Promise<void> {
    if (!loadPromise) {
      setLoading(true);
      // `.catch` resets the loading flag and clears the cached promise so a
      // rejected load (e.g. a directory permission error) doesn't leave the
      // spinner stuck forever and the next ensureLoaded() can retry — the
      // `.then` alone would cache the rejection as permanent state.
      loadPromise = Promise.all([recomputeRows(), rebuildIndex()])
        .then(() => {
          setLoading(false);
        })
        .catch((error) => {
          setLoading(false);
          loadPromise = null;
          options.onLoadError(error instanceof Error ? error.message : String(error));
        });
    }
    await loadPromise;
  }

  function moveSelection(delta: number): void {
    setSelectedIndex((index) => clampIndex(index + delta, rows().length));
  }

  async function refresh(): Promise<void> {
    scanCache.clear();
    await Promise.all([recomputeRows(), rebuildIndex()]);
  }

  async function toggleHidden(): Promise<void> {
    setShowHidden((value) => !value);
    scanCache.clear();
    await Promise.all([recomputeRows(), rebuildIndex()]);
  }

  async function setDirExpanded(relPath: string, value: boolean): Promise<void> {
    setExpanded((current) => {
      const next = new Set(current);
      if (value) next.add(relPath);
      else next.delete(relPath);
      return next;
    });
    await recomputeRows();
  }

  async function openSelected(): Promise<void> {
    const row = rows()[selectedIndex()];
    if (!row) return;
    if (row.node.kind === "dir") {
      await setDirExpanded(row.node.relPath, !row.expanded);
      return;
    }
    await options.onOpenPath(row.node.relPath);
  }

  async function collapseSelected(): Promise<void> {
    const row = rows()[selectedIndex()];
    if (!row) return;
    if (row.node.kind === "dir" && row.expanded) {
      await setDirExpanded(row.node.relPath, false);
      return;
    }
    // Jump to the parent directory row when collapsing a child.
    const parts = row.node.relPath.split("/");
    if (parts.length < 2) return;
    const parent = parts.slice(0, -1).join("/");
    const parentIndex = rows().findIndex((candidate) => candidate.node.relPath === parent);
    if (parentIndex >= 0) setSelectedIndex(parentIndex);
  }

  async function expandSelected(): Promise<void> {
    const row = rows()[selectedIndex()];
    if (!row) return;
    if (row.node.kind === "dir") {
      if (!row.expanded) await setDirExpanded(row.node.relPath, true);
      return;
    }
    // Right on a file row opens it and hands focus to the viewer (D1 of the
    // cc-switch-cli keymap review): focus follows position, no F6 needed.
    await options.onOpenPath(row.node.relPath);
  }

  /**
   * Expand the ancestor chain of a project-relative path and select it;
   * files additionally open in the viewer. Used by /workspace <path> and
   * the /artifact bridge. Returns the located kind, or null when the path
   * does not resolve.
   */
  async function locatePath(relPath: string): Promise<"file" | "dir" | null> {
    const normalized = relPath.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "");
    if (!normalized || normalized.startsWith("/") || normalized.split("/").includes("..")) return null;
    const stat = await statEntry(rootDir, normalized);
    if (!stat) return null;
    const parts = normalized.split("/");
    setExpanded((current) => {
      const next = new Set(current);
      for (let i = 1; i < parts.length; i += 1) next.add(parts.slice(0, i).join("/"));
      // A located directory arrives expanded so its contents are visible.
      if (stat.kind === "dir") next.add(normalized);
      return next;
    });
    await recomputeRows();
    const index = rows().findIndex((row) => row.node.relPath === normalized);
    if (index >= 0) setSelectedIndex(index);
    if (stat.kind === "file") {
      await options.onOpenPath(normalized);
      return "file";
    }
    return "dir";
  }

  /** Move the tree selection to a project-relative path if it is visible. */
  function selectRelPath(relPath: string): void {
    const idx = rows().findIndex((row) => row.node.relPath === relPath);
    if (idx >= 0) setSelectedIndex(idx);
  }

  /** Directory prefix of the current tree selection (dir itself, or a file's parent). */
  function selectionDirPrefix(): string {
    const row = rows()[selectedIndex()];
    if (!row) return "";
    const rel = row.node.relPath;
    if (row.node.kind === "dir") return rel.endsWith("/") ? rel : `${rel}/`;
    const slash = rel.lastIndexOf("/");
    return slash >= 0 ? rel.slice(0, slash + 1) : "";
  }

  /**
   * Clear the scan cache for a path's ancestor chain plus the root, so a
   * deeply-nested create/move refreshes every expanded directory on the path
   * (a `mkdir -p a/b/c` creates a new top-level `a` that the cached root
   * listing would miss).
   */
  function invalidateCache(relPath: string): void {
    const parts = relPath.split("/");
    for (let i = parts.length - 1; i >= 1; i -= 1) {
      scanCache.delete(parts.slice(0, i).join("/"));
    }
    scanCache.delete("");
  }

  /** Refresh rows and the quick-open index (used after tree-affecting mutations). */
  async function refreshRowsAndIndex(): Promise<void> {
    await Promise.all([recomputeRows(), rebuildIndex()]);
  }

  /**
   * Apply a frozen file-operation mutation: invalidate the affected caches and
   * refresh rows + index. Selection follow-ups are the facade's reaction.
   */
  function applyMutation(mutation: WorkspaceMutation): Promise<void> {
    if (mutation.kind === "created" || mutation.kind === "deleted") {
      invalidateCache(mutation.path);
    } else {
      invalidateCache(mutation.source);
      invalidateCache(mutation.target);
    }
    return refreshRowsAndIndex();
  }

  // —— quick open ——

  function openQuickOpen(): void {
    void ensureLoaded();
    setQuickQuery("");
    setQuickIndex(0);
    setQuickOpenActive(true);
  }

  function closeQuickOpen(): void {
    setQuickOpenActive(false);
  }

  function moveQuickIndex(delta: number): void {
    setQuickIndex((index) => clampIndex(index + delta, quickMatches().length));
  }

  function quickOpenBackspace(): void {
    setQuickQuery((query) => query.slice(0, -1));
    setQuickIndex(0);
  }

  function quickOpenAppend(char: string): void {
    setQuickQuery((query) => query + char);
    setQuickIndex(0);
  }

  async function chooseQuickMatch(): Promise<void> {
    const target = quickMatches()[quickIndex()];
    if (!target) return;
    closeQuickOpen();
    await options.onOpenPath(target);
  }

  return {
    // tree state
    showHidden,
    rows,
    selectedIndex,
    loading,
    // tree actions
    ensureLoaded,
    moveSelection,
    refresh,
    toggleHidden,
    setDirExpanded,
    openSelected,
    collapseSelected,
    expandSelected,
    locatePath,
    selectRelPath,
    selectionDirPrefix,
    invalidateCache,
    refreshRowsAndIndex,
    rebuildIndex,
    applyMutation,
    // quick open
    quickOpenActive,
    quickQuery,
    quickIndex,
    quickMatches,
    openQuickOpen,
    closeQuickOpen,
    moveQuickIndex,
    quickOpenBackspace,
    quickOpenAppend,
    chooseQuickMatch,
  };
}

export type TreeOwner = ReturnType<typeof createTreeOwner>;
