import { createSignal } from "solid-js";
import type { TuiKeyEvent } from "./decision-interaction";
import {
  buildFileIndex,
  flattenVisibleTree,
  matchFiles,
  readFilePreview,
  statEntry,
  type WorkspaceFilePreview,
  type WorkspaceTreeNode,
  type WorkspaceVisibleRow,
} from "./workspace-files";

/**
 * Shell page state for the two-page model (Scope B / #62). B1 shipped the
 * page skeleton; B2 adds the Workspace page's file tree, read-only viewer,
 * quick-open, and the region focus model.
 *
 * Focus model (keyboard-first contract): the page owns three regions —
 * "tree", "editor" (the viewer; the editable buffer lands here in B3), and
 * "composer" (the shared bottom input). `F6` / `Shift+F6` cycle them, `Esc`
 * steps back (editor → tree → composer), and printable keys only reach the
 * composer while it is focused, so tree/viewer shortcuts never collide with
 * drafting. Page state lives outside the component tree so switching pages
 * keeps the tree, open file, and focus; nothing here touches session JSONL,
 * checkpoints, or rewind.
 */
export type ShellPage = "chat" | "workspace";

export type WorkspaceFocusRegion = "tree" | "editor" | "composer";

export type ViewerScrollEdge = "home" | "end";

const FOCUS_CYCLE: WorkspaceFocusRegion[] = ["tree", "editor", "composer"];

function clampIndex(index: number, length: number): number {
  if (length <= 0) return 0;
  return Math.max(0, Math.min(index, length - 1));
}

function printableChar(key: TuiKeyEvent): string | null {
  if (key.ctrl || key.meta || key.option) return null;
  if (key.name === "space") return " ";
  if (key.name && key.name.length === 1) return key.name;
  return null;
}

export function createWorkspaceController(rootDir: string = process.cwd()) {
  const [page, setPage] = createSignal<ShellPage>("chat");
  const [focusRegion, setFocusRegion] = createSignal<WorkspaceFocusRegion>("tree");

  // —— file tree ——
  const [expanded, setExpanded] = createSignal<ReadonlySet<string>>(new Set());
  const [showHidden, setShowHidden] = createSignal(false);
  const [rows, setRows] = createSignal<WorkspaceVisibleRow[]>([]);
  const [selectedIndex, setSelectedIndex] = createSignal(0);
  const [loading, setLoading] = createSignal(false);
  const scanCache = new Map<string, WorkspaceTreeNode[]>();
  let flattenVersion = 0;

  // —— viewer ——
  const [openFile, setOpenFile] = createSignal<WorkspaceFilePreview | null>(null);
  const [viewMode, setViewMode] = createSignal<"source" | "preview">("source");
  let viewerScrollBy: ((delta: number) => void) | null = null;
  let viewerScrollEdge: ((edge: ViewerScrollEdge) => void) | null = null;

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
      loadPromise = Promise.all([recomputeRows(), rebuildIndex()]).then(() => {
        setLoading(false);
      });
    }
    await loadPromise;
  }

  function activatePage(next: ShellPage): void {
    setPage(next);
    if (next === "workspace") void ensureLoaded();
  }

  function togglePage(): void {
    activatePage(page() === "chat" ? "workspace" : "chat");
  }

  function cycleFocus(direction: 1 | -1): void {
    const order = FOCUS_CYCLE.filter((region) => region !== "editor" || openFile());
    const current = order.indexOf(focusRegion());
    const next = order[(current + direction + order.length) % order.length];
    setFocusRegion(next ?? "tree");
  }

  // —— tree actions ——

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

  async function openPath(relPath: string): Promise<boolean> {
    const preview = await readFilePreview(rootDir, relPath);
    if (!preview) return false;
    setOpenFile(preview);
    setViewMode(preview.kind === "markdown" ? "preview" : "source");
    setFocusRegion("editor");
    return true;
  }

  async function openSelected(): Promise<void> {
    const row = rows()[selectedIndex()];
    if (!row) return;
    if (row.node.kind === "dir") {
      await setDirExpanded(row.node.relPath, !row.expanded);
      return;
    }
    await openPath(row.node.relPath);
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
    if (row?.node.kind === "dir" && !row.expanded) await setDirExpanded(row.node.relPath, true);
  }

  /**
   * Expand the ancestor chain of a project-relative path and select it;
   * files additionally open in the viewer. Used by /workspace <path> and
   * the /artifact bridge.
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
      await openPath(normalized);
      return "file";
    }
    return "dir";
  }

  /** Command bridge: open the page, ensure the model is loaded, locate. */
  async function openWorkspaceTarget(relPath?: string): Promise<"file" | "dir" | null> {
    activatePage("workspace");
    await ensureLoaded();
    if (!relPath) return null;
    return locatePath(relPath);
  }

  // —— viewer actions ——

  function toggleViewMode(): void {
    if (openFile()?.kind !== "markdown") return;
    setViewMode((mode) => (mode === "source" ? "preview" : "source"));
  }

  function registerViewerScroller(
    scrollBy: (delta: number) => void,
    scrollEdge: (edge: ViewerScrollEdge) => void,
  ): () => void {
    viewerScrollBy = scrollBy;
    viewerScrollEdge = scrollEdge;
    return () => {
      viewerScrollBy = null;
      viewerScrollEdge = null;
    };
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

  async function chooseQuickMatch(): Promise<void> {
    const target = quickMatches()[quickIndex()];
    if (!target) return;
    closeQuickOpen();
    await openPath(target);
  }

  // —— key handling ——

  function handleQuickOpenKey(key: TuiKeyEvent): boolean {
    if (key.name === "escape") { closeQuickOpen(); return true; }
    if (key.name === "up") { moveQuickIndex(-1); return true; }
    if (key.name === "down") { moveQuickIndex(1); return true; }
    if (key.name === "enter") { void chooseQuickMatch(); return true; }
    if (key.name === "backspace") {
      setQuickQuery((query) => query.slice(0, -1));
      setQuickIndex(0);
      return true;
    }
    const char = printableChar(key);
    if (char) {
      setQuickQuery((query) => query + char);
      setQuickIndex(0);
    }
    return true; // the panel owns all input while open
  }

  function handleTreeKey(key: TuiKeyEvent): boolean {
    switch (key.name) {
      case "up": moveSelection(-1); return true;
      case "down": moveSelection(1); return true;
      case "left": void collapseSelected(); return true;
      case "right": void expandSelected(); return true;
      case "enter": void openSelected(); return true;
      case "r": void refresh(); return true;
      case ".": void toggleHidden(); return true;
      case "/": openQuickOpen(); return true;
      case "escape": setFocusRegion("composer"); return true;
      default: return true; // focused region owns (and swallows) the rest
    }
  }

  function handleEditorKey(key: TuiKeyEvent): boolean {
    switch (key.name) {
      case "escape": setFocusRegion("tree"); return true;
      case "m": toggleViewMode(); return true;
      case "up": viewerScrollBy?.(-1); return true;
      case "down": viewerScrollBy?.(1); return true;
      case "pageup": viewerScrollBy?.(-10); return true;
      case "pagedown": viewerScrollBy?.(10); return true;
      case "home": viewerScrollEdge?.("home"); return true;
      case "end": viewerScrollEdge?.("end"); return true;
      default: return true;
    }
  }

  /** Returns true when the key was consumed by the Workspace page. */
  function handleKey(key: TuiKeyEvent): boolean {
    if (page() !== "workspace") return false;
    if (key.ctrl && key.name === "p") { openQuickOpen(); return true; }
    if (key.name === "f6") { cycleFocus(key.shift ? -1 : 1); return true; }
    if (quickOpenActive()) return handleQuickOpenKey(key);
    const region = focusRegion();
    if (region === "editor" && openFile()) return handleEditorKey(key);
    if (region === "editor") { setFocusRegion("tree"); return true; }
    if (region === "tree") return handleTreeKey(key);
    return false; // composer region: fall through to the shared composer
  }

  return {
    // page
    activePage: page,
    setActivePage: activatePage,
    togglePage,
    openWorkspaceTarget,
    focusRegion,
    cycleFocus,
    // tree
    rows,
    selectedIndex,
    loading,
    showHidden,
    refresh,
    toggleHidden,
    locatePath,
    openPath,
    // viewer
    openFile,
    viewMode,
    toggleViewMode,
    registerViewerScroller,
    // quick open
    quickOpenActive,
    quickQuery,
    quickIndex,
    quickMatches,
    openQuickOpen,
    closeQuickOpen,
    // keys
    handleKey,
  };
}

export type WorkspaceController = ReturnType<typeof createWorkspaceController>;
