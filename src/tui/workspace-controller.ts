import { createSignal } from "solid-js";
import type { TextareaRenderable } from "@opentui/core";
import type { TuiKeyEvent } from "./decision-interaction";
import {
  assertProjectRelativePath,
  atomicWriteFile,
  computeFindOffsets,
  isEditablePreview,
  readEditableFile,
  readMtimeMs,
} from "./workspace-editor";
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
 * page skeleton, B2 the file tree + read-only viewer, B3 the editing kernel.
 *
 * Focus model (keyboard-first contract): the page owns three regions —
 * "tree", "editor" (the viewer / editable buffer), and "composer" (the shared
 * bottom input). `F6` / `Shift+F6` cycle them, `Esc` steps back
 * (editor → tree → composer), and printable keys only reach the composer
 * while it is focused, so tree/viewer shortcuts never collide with drafting.
 *
 * Editor (B3): one OpenTUI textarea instance per open file preserves per-file
 * undo history (spike finding: `setText` clears the stack, so the buffer must
 * live inside the component, not be swapped as plain text). The controller
 * owns the buffer pool (LRU, dirty-protected), dirty tracking
 * (plainText-vs-snapshot), save / save-as with a project-root-bounded atomic
 * write, find / goto / save-as input bars, the dirty-on-close confirm, and
 * external-modification detection by mtime on save and page reactivation.
 *
 * Page state lives outside the component tree so switching pages keeps the
 * tree, open file, and focus; nothing here touches session JSONL,
 * checkpoints, or rewind.
 */
export type ShellPage = "chat" | "workspace";

export type WorkspaceFocusRegion = "tree" | "editor" | "composer";

export type ViewerScrollEdge = "home" | "end";

/**
 * Colour tone for the editor status line. The status bar reads muted by
 * default and escalates: `warn` (amber, bold) for anything that risks losing
 * edits or clobbering external work — the dirty/overwrite/reload confirms and
 * disk-change notices; `error` (red, bold) for failures; `success` (emerald)
 * for save/reload confirmations.
 */
export type EditorStatusTone = "info" | "success" | "warn" | "error";

type EditorDialogKind = "dirty-confirm" | "overwrite-confirm" | "reload-confirm";
type EditorDialog = { kind: EditorDialogKind; path: string } | null;

type EditorBufferMeta = {
  savedSnapshot: string;
  mtimeMs: number;
  initialContent: string;
};

/** LRU cap for open editable buffers (spike §4.1 / plan §4.1). */
const EDITOR_LRU_CAP = 8;

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

/**
 * Vim navigation normalized to arrow keys before dispatch (D4 of the
 * cc-switch-cli keymap review): handlers only ever see arrows, and the
 * normalization never runs while a text input owns the keyboard (quick open
 * and the editable source are checked before this point; the composer region
 * never reaches it).
 */
const VIM_KEY_ALIASES: Record<string, string> = { h: "left", j: "down", k: "up", l: "right" };

function normalizeVimKey(key: TuiKeyEvent): TuiKeyEvent {
  if (key.ctrl || key.meta || key.option || key.shift) return key;
  const alias = key.name ? VIM_KEY_ALIASES[key.name] : undefined;
  return alias ? { ...key, name: alias } : key;
}

/**
 * Ctrl+S arrives as `name:"s", ctrl:true` on most terminals, but a few send
 * the raw DC3 byte (`0x13`) without decomposing it. Accept both (D6 of the
 * keymap review). Other Ctrl+letter combos are matched on `name` only.
 */
function isCtrl(key: TuiKeyEvent, letter: string): boolean {
  return Boolean(key.ctrl && key.name === letter);
}

function isSaveKey(key: TuiKeyEvent): boolean {
  return isCtrl(key, "s") || key.sequence === "\x13" || key.raw === "\x13";
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

  // —— editor pool (B3) ——
  // editorOrder: most-recently-used first. activeEditorPath: the editable
  // buffer currently shown (null while a read-only file or no file is open).
  const [editorOrder, setEditorOrder] = createSignal<string[]>([]);
  const [activeEditorPath, setActiveEditorPath] = createSignal<string | null>(null);
  const [dirtyPaths, setDirtyPaths] = createSignal<ReadonlySet<string>>(new Set());
  const [externalChanged, setExternalChanged] = createSignal<ReadonlySet<string>>(new Set());
  const [editorStatusState, setEditorStatusState] = createSignal<{ text: string; tone: EditorStatusTone }>({ text: "", tone: "info" });
  /** Status text (the component reads this for the status-line body). */
  const editorStatus = () => editorStatusState().text;
  /** Status tone (drives the status-line colour — see EditorStatusTone). */
  const editorStatusTone = () => editorStatusState().tone;
  /** Typed setter; clears to neutral info when called with no tone. */
  function status(text: string, tone: EditorStatusTone = "info"): void {
    setEditorStatusState({ text, tone });
  }
  const bufferMeta = new Map<string, EditorBufferMeta>();
  const instances = new Map<string, TextareaRenderable>();
  /** Tracks whether the workspace page has been entered at least once. */
  let workspaceEntered = false;

  // cursor position of the active buffer (status line Ln:Col), 0-indexed
  const [cursorLn, setCursorLn] = createSignal(0);
  const [cursorCol, setCursorCol] = createSignal(0);

  // —— editor input bars / dialogs ——
  const [findActive, setFindActive] = createSignal(false);
  const [findQuery, setFindQuery] = createSignal("");
  const [findMatches, setFindMatches] = createSignal<number[]>([]);
  const [findMatchIndex, setFindMatchIndex] = createSignal(-1);
  let findPlainSnapshot = "";

  const [gotoActive, setGotoActive] = createSignal(false);
  const [gotoDraft, setGotoDraft] = createSignal("");

  const [saveAsActive, setSaveAsActive] = createSignal(false);
  const [saveAsDraft, setSaveAsDraft] = createSignal("");

  const [dialog, setDialog] = createSignal<EditorDialog>(null);

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
    const reentering = next === "workspace" && page() === "workspace";
    setPage(next);
    if (next === "workspace") {
      void ensureLoaded();
      if (reentering || workspaceEntered) void checkExternalModifications();
      workspaceEntered = true;
    }
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

  /** Whether the currently open file is shown in the editable textarea. */
  function isEditing(): boolean {
    const file = openFile();
    return Boolean(file && isEditablePreview(file) && activeEditorPath() === file.relPath && viewMode() === "source");
  }

  async function openPath(relPath: string): Promise<boolean> {
    const preview = await readFilePreview(rootDir, relPath);
    if (!preview) return false;
    setOpenFile(preview);
    setViewMode(preview.kind === "markdown" ? "preview" : "source");
    setFocusRegion("editor");
    status("");
    if (isEditablePreview(preview)) {
      await openEditableBuffer(relPath);
    } else {
      setActiveEditorPath(null);
    }
    return true;
  }

  /**
   * Admit a file into the editable buffer pool (LRU, dirty-protected). On the
   * rare "all dirty" refusal the file still opens in the read-only viewer and
   * a status line explains why no buffer was created.
   */
  async function openEditableBuffer(relPath: string): Promise<void> {
    if (!editorOrder().includes(relPath) && editorOrder().length >= EDITOR_LRU_CAP) {
      const victim = [...editorOrder()].reverse().find((path) => !dirtyPaths().has(path));
      if (!victim) {
        setEditorStatusState({ text: `${EDITOR_LRU_CAP} buffers open and all dirty — save or close one first`, tone: "error" });
        setActiveEditorPath(null);
        return;
      }
      closeBuffer(victim);
    }
    if (!bufferMeta.has(relPath)) {
      const read = await readEditableFile(rootDir, relPath);
      if (!read) {
        setActiveEditorPath(null);
        return;
      }
      bufferMeta.set(relPath, {
        savedSnapshot: read.content,
        mtimeMs: read.mtimeMs,
        initialContent: read.content,
      });
    }
    setEditorOrder((order) => [relPath, ...order.filter((path) => path !== relPath)]);
    setActiveEditorPath(relPath);
    setExternalChanged((set) => {
      if (!set.has(relPath)) return set;
      const next = new Set(set);
      next.delete(relPath);
      return next;
    });
  }

  function closeBuffer(relPath: string): void {
    setEditorOrder((order) => order.filter((path) => path !== relPath));
    bufferMeta.delete(relPath);
    setDirtyPaths((set) => {
      if (!set.has(relPath)) return set;
      const next = new Set(set);
      next.delete(relPath);
      return next;
    });
    if (activeEditorPath() === relPath) setActiveEditorPath(null);
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
    if (!row) return;
    if (row.node.kind === "dir") {
      if (!row.expanded) await setDirExpanded(row.node.relPath, true);
      return;
    }
    // Right on a file row opens it and hands focus to the viewer (D1 of the
    // cc-switch-cli keymap review): focus follows position, no F6 needed.
    await openPath(row.node.relPath);
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

  /** Re-read the open file's preview (viewer `r` — refresh the read-only view). */
  async function reloadViewer(): Promise<void> {
    const file = openFile();
    if (!file) return;
    const preview = await readFilePreview(rootDir, file.relPath);
    if (preview) {
      setOpenFile(preview);
      status(`reloaded ${file.relPath}`, "success");
    }
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

  // —— editor instance + dirty tracking ——

  function registerEditorInstance(relPath: string, instance: TextareaRenderable): void {
    instances.set(relPath, instance);
  }

  function unregisterEditorInstance(relPath: string): void {
    instances.delete(relPath);
  }

  /**
   * Content-change callback from the textarea. Dirty is plainText-vs-snapshot
   * so undo-back-to-clean clears the dot and a programmatic reload (which
   * updates the snapshot first) never reads as a user edit.
   */
  function markEditorContentChanged(relPath: string): void {
    const instance = instances.get(relPath);
    const meta = bufferMeta.get(relPath);
    if (!instance || !meta) return;
    const dirty = instance.plainText !== meta.savedSnapshot;
    setDirtyPaths((set) => {
      if (dirty === set.has(relPath)) return set;
      const next = new Set(set);
      if (dirty) next.add(relPath);
      else next.delete(relPath);
      return next;
    });
    // A new edit makes a lingering "saved" / "reloaded" note stale — clear it
    // so the status line never reads "saved" while the dot shows unsaved work.
    if (dirty && editorStatusState().text) status("");
  }

  function activeInstance(): TextareaRenderable | undefined {
    const path = activeEditorPath();
    return path ? instances.get(path) : undefined;
  }

  /** Status-line cursor readout (onCursorChange feeds this from the textarea). */
  function reportCursor(line: number, col: number): void {
    setCursorLn(line);
    setCursorCol(col);
  }

  function editorInitialContent(relPath: string): string {
    return bufferMeta.get(relPath)?.initialContent ?? "";
  }

  // —— save / save-as / reload ——

  async function saveActive(): Promise<boolean> {
    const path = activeEditorPath();
    if (!path) return false;
    const instance = instances.get(path);
    const meta = bufferMeta.get(path);
    if (!instance || !meta) return false;
    const currentMtime = await readMtimeMs(rootDir, path);
    if (currentMtime !== null && currentMtime !== meta.mtimeMs) {
      setDialog({ kind: "overwrite-confirm", path });
      return false;
    }
    await writeBuffer(path, instance.plainText);
    return true;
  }

  /**
   * Set when a dirty-confirm "save and close" diverts to the overwrite
   * confirm: the close intent survives, so force-overwriting completes the
   * close. Choosing save-as satisfies the save intent on its own (the buffer
   * moves to the new path and stays open); cancelling clears the intent.
   */
  let closeAfterSave = false;

  async function forceSaveActive(): Promise<void> {
    const path = activeEditorPath();
    if (!path) return;
    const instance = instances.get(path);
    if (!instance) return;
    await writeBuffer(path, instance.plainText);
    if (closeAfterSave) {
      closeAfterSave = false;
      afterDirtyConfirm();
    }
  }

  async function writeBuffer(relPath: string, content: string): Promise<void> {
    const abs = assertProjectRelativePath(rootDir, relPath);
    await atomicWriteFile(abs, content);
    const meta = bufferMeta.get(relPath);
    const mtime = await readMtimeMs(rootDir, relPath);
    if (meta) {
      meta.savedSnapshot = content;
      meta.mtimeMs = mtime ?? meta.mtimeMs;
    }
    setDirtyPaths((set) => {
      if (!set.has(relPath)) return set;
      const next = new Set(set);
      next.delete(relPath);
      return next;
    });
    setExternalChanged((set) => {
      if (!set.has(relPath)) return set;
      const next = new Set(set);
      next.delete(relPath);
      return next;
    });
    invalidateDirCache(relPath);
    status(`saved ${relPath}`, "success");
  }

  function invalidateDirCache(relPath: string): void {
    const slash = relPath.lastIndexOf("/");
    scanCache.delete(slash >= 0 ? relPath.slice(0, slash) : "");
  }

  async function commitSaveAs(target: string): Promise<void> {
    const path = activeEditorPath();
    if (!path) return;
    const instance = instances.get(path);
    if (!instance) return;
    const trimmed = target.trim().replace(/\\/g, "/");
    if (!trimmed) {
      status("save-as needs a path", "error");
      return;
    }
    try {
      assertProjectRelativePath(rootDir, trimmed);
    } catch (error) {
      status(String(error instanceof Error ? error.message : error), "error");
      return;
    }
    const content = instance.plainText;
    await writeBuffer(trimmed, content);
    // Switch the editable buffer to the new path (close the old, open the new
    // without re-reading — we just wrote it). The recorded mtime must be the
    // file's real mtime: a wall-clock value never matches the on-disk stat
    // and would raise a spurious overwrite confirm on the next Ctrl+S.
    closeBuffer(path);
    const writtenMtime = await readMtimeMs(rootDir, trimmed);
    bufferMeta.set(trimmed, { savedSnapshot: content, mtimeMs: writtenMtime ?? Date.now(), initialContent: content });
    setEditorOrder((order) => [trimmed, ...order.filter((p) => p !== trimmed)]);
    setActiveEditorPath(trimmed);
    setOpenFile(await readFilePreview(rootDir, trimmed));
    setViewMode("source");
    void rebuildIndex();
  }

  async function reloadActiveBuffer(): Promise<void> {
    const path = activeEditorPath();
    if (!path) return;
    const read = await readEditableFile(rootDir, path);
    if (!read) {
      status(`${path} is gone from disk`, "error");
      return;
    }
    const instance = instances.get(path);
    const meta = bufferMeta.get(path);
    if (!instance || !meta) return;
    // replaceText preserves undo history (one undo step back to the local
    // version); setText would clear the stack.
    instance.replaceText(read.content);
    meta.savedSnapshot = read.content;
    meta.mtimeMs = read.mtimeMs;
    setDirtyPaths((set) => {
      if (!set.has(path)) return set;
      const next = new Set(set);
      next.delete(path);
      return next;
    });
    setExternalChanged((set) => {
      if (!set.has(path)) return set;
      const next = new Set(set);
      next.delete(path);
      return next;
    });
    status(`reloaded ${path}`, "success");
  }

  function requestReloadActive(): void {
    const path = activeEditorPath();
    if (!path) return;
    if (dirtyPaths().has(path) || externalChanged().has(path)) {
      setDialog({ kind: "reload-confirm", path });
    } else {
      status(`${path} is already current`);
    }
  }

  async function checkExternalModifications(): Promise<void> {
    const changed: string[] = [];
    for (const path of editorOrder()) {
      const meta = bufferMeta.get(path);
      if (!meta) continue;
      const mtime = await readMtimeMs(rootDir, path);
      if (mtime !== null && mtime !== meta.mtimeMs) changed.push(path);
    }
    if (changed.length === 0) return;
    setExternalChanged(new Set(changed));
    status(`${changed.length} file(s) changed on disk — Ctrl+R to reload`, "warn");
  }

  /** Leave the editable source by one focus level (Esc-clean destination). */
  function leaveEditorSource(): void {
    const file = openFile();
    if (file?.kind === "markdown" && viewMode() === "source") {
      // Markdown has an intermediate read-only preview level: source → preview
      // → tree. Other editable files step straight to the tree.
      setViewMode("preview");
    } else {
      setFocusRegion("tree");
    }
  }

  // —— find / goto / save-as bars ——

  function openFind(): void {
    const instance = activeInstance();
    if (!instance) return;
    findPlainSnapshot = instance.plainText;
    setFindQuery("");
    setFindMatches([]);
    setFindMatchIndex(-1);
    setFindActive(true);
  }

  function closeFind(): void {
    setFindActive(false);
    findPlainSnapshot = "";
  }

  function refreshFind(): void {
    const offsets = computeFindOffsets(findPlainSnapshot, findQuery());
    setFindMatches(offsets);
    setFindMatchIndex(offsets.length > 0 ? 0 : -1);
    if (offsets.length > 0) selectFindMatch(0);
  }

  function selectFindMatch(index: number): void {
    const instance = activeInstance();
    if (!instance) return;
    const offset = findMatches()[index];
    if (offset === undefined) return;
    const length = findQuery().length;
    instance.setSelection(offset, offset + length);
  }

  function openGoto(): void {
    if (!activeInstance()) return;
    setGotoDraft("");
    setGotoActive(true);
  }

  function openSaveAs(): void {
    if (!activeEditorPath()) return;
    // Start empty: in a keyboard line-input, typing appends, so pre-filling
    // the current path would force the user to clear it first. The status
    // line shows "save as: ▌" and Enter commits the typed path.
    setSaveAsDraft("");
    setSaveAsActive(true);
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

  function handleFindKey(key: TuiKeyEvent): boolean {
    if (key.name === "escape") { closeFind(); return true; }
    if (key.name === "enter") {
      const matches = findMatches();
      if (matches.length === 0) return true;
      const step = key.shift ? -1 : 1;
      const next = (findMatchIndex() + step + matches.length) % matches.length;
      setFindMatchIndex(next);
      selectFindMatch(next);
      return true;
    }
    if (key.name === "backspace") {
      setFindQuery((query) => query.slice(0, -1));
      refreshFind();
      return true;
    }
    const char = printableChar(key);
    if (char) {
      setFindQuery((query) => query + char);
      refreshFind();
    }
    return true;
  }

  function handleGotoKey(key: TuiKeyEvent): boolean {
    if (key.name === "escape") { setGotoActive(false); return true; }
    if (key.name === "enter") {
      const target = parseInt(gotoDraft(), 10);
      setGotoActive(false);
      if (Number.isFinite(target) && target >= 1) activeInstance()?.gotoLine(target - 1);
      return true;
    }
    if (key.name === "backspace") {
      setGotoDraft((draft) => draft.slice(0, -1));
      return true;
    }
    const char = printableChar(key);
    if (char && /[0-9]/.test(char)) setGotoDraft((draft) => draft + char);
    return true;
  }

  function handleSaveAsKey(key: TuiKeyEvent): boolean {
    if (key.name === "escape") { setSaveAsActive(false); return true; }
    if (key.name === "enter") {
      const target = saveAsDraft();
      setSaveAsActive(false);
      void commitSaveAs(target);
      return true;
    }
    if (key.name === "backspace") {
      setSaveAsDraft((draft) => draft.slice(0, -1));
      return true;
    }
    const char = printableChar(key);
    if (char && /[A-Za-z0-9._\-/]/.test(char)) setSaveAsDraft((draft) => draft + char);
    return true;
  }

  function handleDialogKey(key: TuiKeyEvent): boolean {
    const current = dialog();
    if (!current) return false;
    if (key.name === "escape") { closeAfterSave = false; setDialog(null); return true; }
    if (current.kind === "dirty-confirm") {
      if (key.name === "y") {
        setDialog(null);
        // Close only when the save actually landed. A save diverted to the
        // overwrite confirm keeps the buffer open and arms closeAfterSave so
        // force-overwriting completes the close — the edits are never
        // discarded under the user's feet.
        void saveActive().then((saved) => {
          if (saved) afterDirtyConfirm();
          else closeAfterSave = true;
        });
        return true;
      }
      if (key.name === "n") { setDialog(null); afterDirtyConfirm(); return true; }
      return true;
    }
    if (current.kind === "overwrite-confirm") {
      if (key.name === "o") { setDialog(null); void forceSaveActive(); return true; }
      // Save-as satisfies the save intent by itself; the buffer moves to the
      // new path and stays open there.
      if (key.name === "s") { closeAfterSave = false; setDialog(null); openSaveAs(); return true; }
      if (key.name === "c") { closeAfterSave = false; setDialog(null); return true; }
      return true;
    }
    if (current.kind === "reload-confirm") {
      if (key.name === "y") { setDialog(null); void reloadActiveBuffer(); return true; }
      if (key.name === "n") { setDialog(null); return true; }
      return true;
    }
    return true;
  }

  /**
   * After a dirty-confirm save/discard: drop the buffer's local state, close
   * the file, and return focus to the tree.
   */
  function afterDirtyConfirm(): void {
    const path = activeEditorPath();
    if (path) closeBuffer(path);
    setOpenFile(null);
    setFocusRegion("tree");
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
      case "q": setFocusRegion("composer"); return true;
      case "escape": setFocusRegion("composer"); return true;
      default: return true; // focused region owns (and swallows) the rest
    }
  }

  function handleViewerKey(key: TuiKeyEvent): boolean {
    switch (key.name) {
      case "escape": setFocusRegion("tree"); return true;
      case "q": setFocusRegion("tree"); return true;
      case "r": void reloadViewer(); return true;
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

  /**
   * Editable source routing (spike §4.2). Command keys the textarea has no
   * native action for are consumed here (return true → input-routing
   * preventDefault stops the component). Everything the textarea edits with —
   * printable characters, arrows, Backspace, Enter, undo/redo via keyBindings,
   * Tab → indent (handled in the component's onKeyDown) — returns false so the
   * key propagates from the global listener to the focused textarea.
   */
  function handleEditableKey(key: TuiKeyEvent): boolean {
    // Ctrl+Shift+S (save-as) before Ctrl+S — isSaveKey would otherwise catch
    // the shift variant and route it to a plain save.
    if (key.ctrl && key.shift && key.name === "s") { openSaveAs(); return true; }
    if (isSaveKey(key)) { void saveActive(); return true; }
    if (isCtrl(key, "f")) { openFind(); return true; }
    if (isCtrl(key, "g")) { openGoto(); return true; }
    if (isCtrl(key, "r")) { requestReloadActive(); return true; }
    // undo / redo / ctrl+_ legacy fallback: the textarea's custom keyBindings
    // own these — let the key propagate.
    if (key.ctrl && (key.name === "z" || key.name === "y" || key.name === "_")) return false;
    if (key.name === "escape") {
      const path = activeEditorPath();
      if (path && dirtyPaths().has(path)) {
        setDialog({ kind: "dirty-confirm", path });
        return true;
      }
      leaveEditorSource();
      return true;
    }
    // All other keys (printable, arrows, Tab, Enter, …) reach the textarea.
    return false;
  }

  /** Returns true when the key was consumed by the Workspace page. */
  function handleKey(key: TuiKeyEvent): boolean {
    if (page() !== "workspace") return false;
    if (quickOpenActive()) return handleQuickOpenKey(key);
    if (dialog()) return handleDialogKey(key);
    if (findActive()) return handleFindKey(key);
    if (gotoActive()) return handleGotoKey(key);
    if (saveAsActive()) return handleSaveAsKey(key);
    if (key.ctrl && key.name === "p") { openQuickOpen(); return true; }
    if (key.name === "f6") { cycleFocus(key.shift ? -1 : 1); return true; }
    const region = focusRegion();
    if (region === "editor" && openFile()) {
      if (isEditing()) return handleEditableKey(key);
      return handleViewerKey(normalizeVimKey(key));
    }
    if (region === "editor") { setFocusRegion("tree"); return true; }
    if (region === "tree") return handleTreeKey(normalizeVimKey(key));
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
    // editor pool
    editorOrder,
    activeEditorPath,
    dirtyPaths,
    externalChanged,
    editorStatus,
    editorStatusTone,
    editorInitialContent,
    isEditing,
    registerEditorInstance,
    unregisterEditorInstance,
    markEditorContentChanged,
    reportCursor,
    cursorLn,
    cursorCol,
    saveActive,
    reloadActiveBuffer,
    // editor bars / dialogs
    findActive,
    findQuery,
    findMatches,
    findMatchIndex,
    gotoActive,
    gotoDraft,
    saveAsActive,
    saveAsDraft,
    dialog,
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
