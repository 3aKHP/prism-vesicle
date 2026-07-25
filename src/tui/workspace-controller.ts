import { createSignal } from "solid-js";
import type { TextareaRenderable } from "@opentui/core";
import type { TuiKeyEvent } from "./decision-interaction";
import {
  atomicWriteFile,
  computeFindOffsets,
  isEditablePreview,
  readEditableFile,
  readFileStamp,
  type FileStamp,
} from "./workspace-editor";
import { assertProjectRelativePath } from "./workspace-paths";
import {
  copyEntry,
  createDirectory,
  createFile,
  entryExists,
  moveEntry,
  removeFile,
  trashEntry,
} from "./workspace-fileops";
import {
  pendingValidation,
  runValidation,
  type LocatedFinding,
  type ValidationState,
} from "./workspace-validate";
import {
  resolveEditorCommand,
  runExternalEditor,
  type EditorRuntime,
} from "./workspace-external-editor";
import { loadSettings, type Settings } from "../config/settings";
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
 * external-modification detection by mtime + inode on save and page
 * reactivation.
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

type B3DialogKind = "dirty-confirm" | "overwrite-confirm" | "reload-confirm";
type EditorDialog =
  | { kind: B3DialogKind; path: string }
  | { kind: "delete-confirm"; path: string }
  | { kind: "ops-overwrite"; path: string; op: "move" | "copy"; source: string }
  | { kind: "save-as-overwrite"; path: string }
  | null;

/** Tree file-management input bar (B4 §5.1): path prompts isomorphic to save-as. */
type OpsBarKind = "create-file" | "create-dir" | "move" | "copy";
type OpsBar = { kind: OpsBarKind; draft: string; source: string } | null;

type EditorBufferMeta = FileStamp & {
  savedSnapshot: string;
  initialContent: string;
};

function sameFileStamp(left: FileStamp, right: FileStamp): boolean {
  return left.mtimeMs === right.mtimeMs && left.ino === right.ino;
}

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

/**
 * Reset a stale horizontal scroll offset after the cursor lands on a shorter
 * line. OpenTUI's textarea scrolls right to follow the cursor on a long line
 * but does not pull the offset back when the cursor moves to a shorter line,
 * so the shorter line renders with its start cut off. This only resets when
 * the cursor already fits within the viewport from offset 0, so typing on a
 * long line is never disturbed. Used after navigation keys (deferred, see
 * WorkspacePage) and after imperative goto / find jumps.
 *
 * Dormant while the editor uses wrapMode="word" (no horizontal scroll, so
 * offsetX stays 0); kept as the guard for any future return to "none".
 */
export function resetStaleHorizontalScroll(ed: TextareaRenderable): void {
  const vp = ed.editorView.getViewport();
  if (vp.offsetX > 0 && ed.logicalCursor.col < vp.width) {
    ed.editorView.setViewport(0, vp.offsetY, vp.width, vp.height, false);
  }
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

  // —— file-management ops bar (B4 §5.1) ——
  const [opsBar, setOpsBar] = createSignal<OpsBar>(null);

  // —— in-page validation (B4 §5.2) ——
  const [validationState, setValidationState] = createSignal<ValidationState>(pendingValidation);
  const [findingsOpen, setFindingsOpen] = createSignal(false);
  const [findingsIndex, setFindingsIndex] = createSignal(0);

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
          status(`failed to load workspace: ${errMsg(error)}`, "error");
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
    setValidationState(runValidation(preview.lines?.join("\n") ?? ""));
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
        ino: read.ino,
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
      setValidationState(runValidation(preview.lines?.join("\n") ?? ""));
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
    // Clear any close-intent left over from a prior dirty-confirm chain so it
    // can't leak into this unrelated save (a stale closeAfterSave could close
    // the wrong buffer when a later plain save force-overwrites). The dirty-
    // confirm 'y' path re-arms it in its own .then, after this returns.
    closeAfterSave = false;
    const path = activeEditorPath();
    if (!path) return false;
    const instance = instances.get(path);
    const meta = bufferMeta.get(path);
    if (!instance || !meta) return false;
    const currentStamp = await readFileStamp(rootDir, path);
    if (currentStamp !== null && !sameFileStamp(currentStamp, meta)) {
      setDialog({ kind: "overwrite-confirm", path });
      return false;
    }
    return writeBuffer(path, instance.plainText);
  }

  /**
   * Set when a dirty-confirm "save and close" diverts to the overwrite
   * confirm: the close intent survives, so force-overwriting completes the
   * close. saveActive() clears it at the start of every save so it can't leak
   * across buffers; choosing save-as or cancelling clears it too.
   */
  let closeAfterSave = false;
  // Dialog actions that await filesystem I/O temporarily own keyboard input.
  // Without this guard, the dialog disappears before the save promise settles
  // and a fast Esc can reopen it against the same in-flight buffer.
  let dialogActionPending = false;

  async function forceSaveActive(): Promise<void> {
    const path = activeEditorPath();
    if (!path) return;
    const instance = instances.get(path);
    if (!instance) return;
    const saved = await writeBuffer(path, instance.plainText);
    if (saved && closeAfterSave) {
      closeAfterSave = false;
      afterDirtyConfirm();
    }
  }

  /**
   * Atomic write + post-save bookkeeping. Returns false (and surfaces a status
   * error) on a disk failure rather than throwing, so the `void saveActive()`
   * callers don't surface unhandled rejections and the buffer stays dirty.
   */
  async function writeBuffer(relPath: string, content: string): Promise<boolean> {
    let abs: string;
    try {
      abs = assertProjectRelativePath(rootDir, relPath);
      await atomicWriteFile(abs, content);
    } catch (error) {
      status(`failed to save ${relPath}: ${errMsg(error)}`, "error");
      return false;
    }
    const meta = bufferMeta.get(relPath);
    const stamp = await readFileStamp(rootDir, relPath);
    if (meta) {
      meta.savedSnapshot = content;
      if (stamp) {
        meta.mtimeMs = stamp.mtimeMs;
        meta.ino = stamp.ino;
      }
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
    setValidationState(runValidation(content));
    return true;
  }

  function invalidateDirCache(relPath: string): void {
    // Walk the ancestor chain to the root so a deeply-nested create/move
    // refreshes every expanded directory on the path (a `mkdir -p a/b/c`
    // creates a new top-level `a` that the cached root listing would miss).
    const parts = relPath.split("/");
    for (let i = parts.length - 1; i >= 1; i -= 1) {
      scanCache.delete(parts.slice(0, i).join("/"));
    }
    scanCache.delete("");
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
    // Refuse to silently clobber a different existing file — mirror the
    // move/copy overwrite confirm. 'o' completes the save-as via performSaveAs.
    if (trimmed !== path && await entryExists(rootDir, trimmed)) {
      setDialog({ kind: "save-as-overwrite", path: trimmed });
      return;
    }
    await performSaveAs(trimmed);
  }

  /** Write the active buffer's content to `target` and switch the buffer there. */
  async function performSaveAs(target: string): Promise<void> {
    const path = activeEditorPath();
    const instance = path ? instances.get(path) : undefined;
    if (!path || !instance) return;
    const content = instance.plainText;
    const saved = await writeBuffer(target, content);
    if (!saved) return; // writeBuffer already surfaced the error
    // Switch the editable buffer to the new path (close the old, open the new
    // without re-reading — we just wrote it). The recorded mtime must be the
    // file's real mtime: a wall-clock value never matches the on-disk stat
    // and would raise a spurious overwrite confirm on the next Ctrl+S.
    closeBuffer(path);
    const writtenStamp = await readFileStamp(rootDir, target);
    bufferMeta.set(target, {
      savedSnapshot: content,
      mtimeMs: writtenStamp?.mtimeMs ?? Date.now(),
      ino: writtenStamp?.ino ?? 0,
      initialContent: content,
    });
    setEditorOrder((order) => [target, ...order.filter((p) => p !== target)]);
    setActiveEditorPath(target);
    setOpenFile(await readFilePreview(rootDir, target));
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
    meta.ino = read.ino;
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

  // —— external editor handoff (B5 §6) ——

  /** Renderer + spawn primitives, injected by the component (see WorkspacePage). */
  let externalEditorRuntime: EditorRuntime | null = null;
  function registerExternalEditor(runtime: EditorRuntime): () => void {
    externalEditorRuntime = runtime;
    return () => { externalEditorRuntime = null; };
  }

  /** Which file Ctrl+X hands off, by focus region (plan §6.1). */
  function resolveHandoffTarget(): string | null {
    const region = focusRegion();
    if (region === "tree") {
      const row = rows()[selectedIndex()];
      if (!row || row.node.kind !== "file") {
        status("select a file to edit externally", "info");
        return null;
      }
      return row.node.relPath;
    }
    const file = openFile();
    if (file) return file.relPath;
    status("open or select a file to edit externally", "info");
    return null;
  }

  async function handoffToExternal(): Promise<void> {
    const target = resolveHandoffTarget();
    if (!target) return;
    let abs: string;
    try {
      abs = assertProjectRelativePath(rootDir, target);
    } catch (error) {
      status(errMsg(error), "error");
      return;
    }
    const stat = await statEntry(rootDir, target);
    if (stat?.kind === "dir") { status(`${target} is a directory`, "error"); return; }
    // dirty gate (plan §6.1): an unsaved buffer would be silently overwritten
    // by whatever the external editor writes, so refuse and point at Ctrl+S.
    if (dirtyPaths().has(target)) {
      status(`${target} has unsaved edits — press Ctrl+S before the external editor`, "error");
      return;
    }
    const runtime = externalEditorRuntime;
    if (!runtime) { status("external editor is unavailable in this build", "error"); return; }

    let settings: Settings;
    try {
      settings = await loadSettings();
    } catch (error) {
      status(`settings.yaml is malformed — ${errMsg(error)} (fix or remove it)`, "error");
      return;
    }
    const editor = resolveEditorCommand({ env: process.env, settings });
    status(`opening ${target} in ${editor.command}…`, "info");
    let exitCode = 0;
    try {
      const result = await runExternalEditor({ absPath: abs, editor, runtime });
      exitCode = result.exitCode;
    } catch (error) {
      status(`editor "${editor.command}" failed to start — ${errMsg(error)}`, "error");
      return;
    }
    if (exitCode !== 0) status(`editor exited with code ${exitCode}`, "warn");
    await refreshAfterExternalEdit(target);
  }

  /**
   * React to whatever the external editor did: an open editable buffer is
   * reloaded when its disk identity changes (and revalidated, like a save); a
   * deleted or re-linked file is closed; a file that was only in the tree just
   * has its directory cache + index invalidated.
   */
  async function refreshAfterExternalEdit(relPath: string): Promise<void> {
    const meta = bufferMeta.get(relPath);
    if (meta) {
      const currentStamp = await readFileStamp(rootDir, relPath);
      if (currentStamp === null) {
        status(`${relPath} was removed by the external editor`, "error");
        closeBuffer(relPath);
        if (openFile()?.relPath === relPath) { setOpenFile(null); setFocusRegion("tree"); }
        return;
      }
      if (sameFileStamp(currentStamp, meta)) {
        status("no changes from external editor");
        return;
      }
      const read = await readEditableFile(rootDir, relPath);
      if (!read) {
        status(`${relPath} is no longer a readable file`, "error");
        closeBuffer(relPath);
        return;
      }
      const inst = instances.get(relPath);
      if (inst) {
        inst.replaceText(read.content);
        resetStaleHorizontalScroll(inst);
      }
      meta.savedSnapshot = read.content;
      meta.mtimeMs = read.mtimeMs;
      meta.ino = read.ino;
      setExternalChanged((set) => {
        if (!set.has(relPath)) return set;
        const next = new Set(set);
        next.delete(relPath);
        return next;
      });
      setValidationState(runValidation(read.content));
      status(`reloaded ${relPath}`, "success");
      return;
    }
    // Not an editable buffer: refresh the tree, and re-read the viewer if it
    // was showing this file (covers read-only / image / binary handoffs).
    invalidateDirCache(relPath);
    await Promise.all([recomputeRows(), rebuildIndex()]);
    if (openFile()?.relPath === relPath) await reloadViewer();
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
      const stamp = await readFileStamp(rootDir, path);
      if (stamp !== null && !sameFileStamp(stamp, meta)) changed.push(path);
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
    resetStaleHorizontalScroll(instance);
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

  // —— file management (B4 §5.1) ——

  /** Directory prefix of the current tree selection (dir itself, or a file's parent). */
  function selectionDirPrefix(): string {
    const row = rows()[selectedIndex()];
    if (!row) return "";
    const rel = row.node.relPath;
    if (row.node.kind === "dir") return rel.endsWith("/") ? rel : `${rel}/`;
    const slash = rel.lastIndexOf("/");
    return slash >= 0 ? rel.slice(0, slash + 1) : "";
  }

  function openOpsBar(kind: OpsBarKind): void {
    const row = rows()[selectedIndex()];
    if (!row) return;
    const source = row.node.relPath;
    // create-* and move/copy both prefill the directory part so the user types
    // the new name in place (B3 save-as taught us a pre-filled full path just
    // has to be cleared first).
    setOpsBar({ kind, draft: selectionDirPrefix(), source });
  }

  function handleOpsBarKey(key: TuiKeyEvent): boolean {
    const bar = opsBar();
    if (!bar) return false;
    if (key.name === "escape") { setOpsBar(null); return true; }
    if (key.name === "enter") {
      const draft = bar.draft.trim().replace(/\\/g, "/");
      setOpsBar(null);
      if (!draft) { status(`${bar.kind} needs a path`, "error"); return true; }
      try {
        assertProjectRelativePath(rootDir, draft);
      } catch (error) {
        status(String(error instanceof Error ? error.message : error), "error");
        return true;
      }
      if (bar.kind === "create-file") void execCreateFile(draft);
      else if (bar.kind === "create-dir") void execCreateDir(draft);
      else if (bar.kind === "move") void execMove(bar.source, draft, false);
      else void execCopy(bar.source, draft, false);
      return true;
    }
    if (key.name === "backspace") {
      setOpsBar((b) => (b ? { ...b, draft: b.draft.slice(0, -1) } : b));
      return true;
    }
    const ch = printableChar(key);
    if (ch && /[A-Za-z0-9._\-/]/.test(ch)) {
      setOpsBar((b) => (b ? { ...b, draft: b.draft + ch } : b));
    }
    return true;
  }

  async function execCreateFile(relPath: string): Promise<void> {
    try {
      await createFile(rootDir, relPath);
      status(`created ${relPath}`, "success");
      await afterTreeMutation(relPath);
      await openPath(relPath);
    } catch (error) { status(errMsg(error), "error"); }
  }

  async function execCreateDir(relPath: string): Promise<void> {
    try {
      await createDirectory(rootDir, relPath);
      status(`created directory ${relPath}`, "success");
      await afterTreeMutation(relPath);
      selectRelPath(relPath);
    } catch (error) { status(errMsg(error), "error"); }
  }

  async function execMove(source: string, target: string, overwrite: boolean): Promise<void> {
    if (target === source) { status("move target equals source", "error"); return; }
    if (!overwrite && await entryExists(rootDir, target)) {
      setDialog({ kind: "ops-overwrite", path: target, op: "move", source });
      return;
    }
    try {
      if (overwrite) await removeFile(rootDir, target);
      await moveEntry(rootDir, source, target);
      rekeyOpenBuffer(source, target);
      status(`moved ${source} → ${target}`, "success");
      await afterTreeMutation2(source, target);
      selectRelPath(target);
    } catch (error) { status(errMsg(error), "error"); }
  }

  async function execCopy(source: string, target: string, overwrite: boolean): Promise<void> {
    if (target === source) { status("copy target equals source", "error"); return; }
    if (!overwrite && await entryExists(rootDir, target)) {
      setDialog({ kind: "ops-overwrite", path: target, op: "copy", source });
      return;
    }
    try {
      if (overwrite) await removeFile(rootDir, target);
      await copyEntry(rootDir, source, target);
      status(`copied ${source} → ${target}`, "success");
      await afterTreeMutation2(source, target);
      selectRelPath(target);
    } catch (error) { status(errMsg(error), "error"); }
  }

  async function execDelete(relPath: string): Promise<void> {
    try {
      // Drop any open editable buffer for this path first (the confirm already
      // noted unsaved edits); also clear the viewer if it was showing it.
      if (bufferMeta.has(relPath)) closeBuffer(relPath);
      if (openFile()?.relPath === relPath) {
        setOpenFile(null);
        setActiveEditorPath(null);
        setFocusRegion("tree");
        setValidationState(pendingValidation);
      }
      const trashPath = await trashEntry(rootDir, relPath);
      status(`moved ${relPath} → ${trashPath} (trash)`, "success");
      await afterTreeMutation(relPath);
    } catch (error) { status(errMsg(error), "error"); }
  }

  /**
   * Rekey an open editable buffer from oldPath to newPath (rename/move).
   * Content and dirty state survive via the captured plainText → initialValue
   * on remount; the textarea's undo stack does NOT survive the path-keyed
   * remount (a known B4 limitation — finish editing before renaming if undo
   * matters). Read-only viewers just refresh via afterTreeMutation.
   */
  function rekeyOpenBuffer(oldPath: string, newPath: string): void {
    if (oldPath === newPath) return;
    const meta = bufferMeta.get(oldPath);
    if (!meta) return;
    // Renaming A onto an already-open B: close B first — the move is
    // overwriting B on disk, so B's stale buffer + pool slot must go before
    // we rekey A, otherwise editorOrder ends up with newPath twice and B's
    // meta is silently clobbered.
    if (bufferMeta.has(newPath)) closeBuffer(newPath);
    const inst = instances.get(oldPath);
    const currentText = inst?.plainText ?? meta.savedSnapshot;
    bufferMeta.delete(oldPath);
    bufferMeta.set(newPath, { ...meta, initialContent: currentText });
    instances.delete(oldPath);
    setEditorOrder((order) => order.map((p) => (p === oldPath ? newPath : p)));
    setActiveEditorPath((p) => (p === oldPath ? newPath : p));
    setDirtyPaths((set) => rekeySet(set, oldPath, newPath));
    setExternalChanged((set) => rekeySet(set, oldPath, newPath));
    const file = openFile();
    if (file?.relPath === oldPath) setOpenFile({ ...file, relPath: newPath });
  }

  function rekeySet(set: ReadonlySet<string>, oldPath: string, newPath: string): ReadonlySet<string> {
    if (!set.has(oldPath)) return set;
    const next = new Set(set);
    next.delete(oldPath);
    next.add(newPath);
    return next;
  }

  async function afterTreeMutation(relPath: string): Promise<void> {
    invalidateDirCache(relPath);
    await Promise.all([recomputeRows(), rebuildIndex()]);
  }

  async function afterTreeMutation2(source: string, target: string): Promise<void> {
    invalidateDirCache(source);
    invalidateDirCache(target);
    await Promise.all([recomputeRows(), rebuildIndex()]);
  }

  /** Move the tree selection to a project-relative path if it is visible. */
  function selectRelPath(relPath: string): void {
    const idx = rows().findIndex((row) => row.node.relPath === relPath);
    if (idx >= 0) setSelectedIndex(idx);
  }

  function errMsg(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }

  // —— in-page validation (B4 §5.2) ——

  function openFindings(): void {
    const file = openFile();
    if (!file) { status("open a file to validate", "info"); return; }
    setValidationState(runValidation(file.lines?.join("\n") ?? ""));
    setFindingsIndex(0);
    setFindingsOpen(true);
  }

  function handleFindingsKey(key: TuiKeyEvent): boolean {
    const state = validationState();
    const findings = state.state === "result" ? state.findings : [];
    if (key.name === "escape") { setFindingsOpen(false); return true; }
    if (findings.length === 0) return true;
    if (key.name === "up") { setFindingsIndex((i) => Math.max(0, i - 1)); return true; }
    if (key.name === "down") { setFindingsIndex((i) => Math.min(findings.length - 1, i + 1)); return true; }
    if (key.name === "enter") {
      const finding = findings[findingsIndex()];
      if (finding && finding.line !== null) jumpToFinding(finding);
      return true;
    }
    return true;
  }

  /** Land the active editable buffer at a finding's line and close the panel. */
  function jumpToFinding(finding: LocatedFinding): void {
    const file = openFile();
    if (!file || !isEditablePreview(file) || finding.line === null) return;
    if (activeEditorPath() !== file.relPath) setActiveEditorPath(file.relPath);
    setViewMode("source");
    setFocusRegion("editor");
    setFindingsOpen(false);
    const inst = instances.get(file.relPath);
    if (inst) {
      inst.gotoLine(finding.line);
      resetStaleHorizontalScroll(inst);
    }
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
      // Enter with an empty query closes the bar (matches the goto bar) instead
      // of being a silent no-op; a non-empty query with no matches stays open so
      // the user can revise it.
      if (!findQuery()) { closeFind(); return true; }
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
      if (Number.isFinite(target) && target >= 1) {
        const inst = activeInstance();
        if (inst) {
          inst.gotoLine(target - 1);
          resetStaleHorizontalScroll(inst);
        }
      }
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
        dialogActionPending = true;
        void saveActive()
          .then((saved) => {
            if (saved) afterDirtyConfirm();
            else closeAfterSave = true;
          })
          .finally(() => { dialogActionPending = false; });
        return true;
      }
      if (key.name === "n") { setDialog(null); afterDirtyConfirm(); return true; }
      return true;
    }
    if (current.kind === "overwrite-confirm") {
      if (key.name === "o") {
        setDialog(null);
        dialogActionPending = true;
        void forceSaveActive().finally(() => { dialogActionPending = false; });
        return true;
      }
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
    if (current.kind === "delete-confirm") {
      // Plan §5.1: "y deletes / anything else cancels".
      if (key.name === "y") { const p = current.path; setDialog(null); void execDelete(p); return true; }
      setDialog(null);
      return true;
    }
    if (current.kind === "ops-overwrite") {
      if (key.name === "o") {
        const { op, source, path: target } = current;
        setDialog(null);
        if (op === "move") void execMove(source, target, true);
        else void execCopy(source, target, true);
        return true;
      }
      if (key.name === "c") { setDialog(null); return true; }
      return true;
    }
    if (current.kind === "save-as-overwrite") {
      if (key.name === "o") { const p = current.path; setDialog(null); void performSaveAs(p); return true; }
      if (key.name === "c" || key.name === "escape") { setDialog(null); return true; }
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
      case "a": openOpsBar(key.shift ? "create-dir" : "create-file"); return true;
      case "m":
      case "f2": openOpsBar("move"); return true;
      case "c": openOpsBar("copy"); return true;
      case "d": {
        const row = rows()[selectedIndex()];
        if (row) setDialog({ kind: "delete-confirm", path: row.node.relPath });
        return true;
      }
      case "v": openFindings(); return true;
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
      case "v": openFindings(); return true;
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
    if (dialogActionPending) return true;
    if (quickOpenActive()) return handleQuickOpenKey(key);
    if (findingsOpen()) return handleFindingsKey(key);
    if (dialog()) return handleDialogKey(key);
    if (opsBar()) return handleOpsBarKey(key);
    if (findActive()) return handleFindKey(key);
    if (gotoActive()) return handleGotoKey(key);
    if (saveAsActive()) return handleSaveAsKey(key);
    if (key.ctrl && key.name === "p") { openQuickOpen(); return true; }
    // Ctrl+X hands off to the external editor from every Workspace focus
    // region (B5 §6.1); caught here so it also covers the composer region and
    // is intercepted before the editable source textarea can consume it.
    if (isCtrl(key, "x") && !key.shift) { void handoffToExternal(); return true; }
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
    // external editor handoff (B5)
    registerExternalEditor,
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
    // file management (B4)
    opsBar,
    // in-page validation (B4)
    validationState,
    findingsOpen,
    findingsIndex,
    openFindings,
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
