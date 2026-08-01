import { createSignal } from "solid-js";
import type { TuiKeyEvent } from "../decision-interaction";
import { isEditablePreview, readFileStamp } from "./buffer-io";
import { createBufferOwner } from "./buffer-owner";
import { createFileOperationOwner } from "./file-operation-owner";
import {
  resolveEditorCommand,
  runExternalEditor,
  type EditorRuntime,
} from "../workspace-external-editor";
import { loadSettings, type Settings } from "../../config/settings";
import { assertProjectRelativePath } from "./paths";
import { readFilePreview, statEntry, type WorkspaceFilePreview } from "./tree-data";
import { createTreeOwner } from "./tree-owner";
import { createValidationOwner } from "./validation-owner";
import type { ShellPage, WorkspaceFocusRegion, ViewerScrollEdge, EditorStatusTone, WorkspaceMutation } from "./types";

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
 * Page state lives outside the component tree so switching pages keeps the
 * tree, open file, and focus; nothing here touches session JSONL,
 * checkpoints, or rewind.
 *
 * Ownership: tree navigation + quick-open state live in `createTreeOwner`,
 * the editable-buffer pool / save / reload / find / goto / save-as live in
 * `createBufferOwner`, file mutations + ops bar + confirm dialogs live in
 * `createFileOperationOwner`, and validation state + findings navigation live
 * in `createValidationOwner`. This factory composes the owners, keeps the
 * page/focus model and viewer state, applies frozen mutations in the fixed
 * tree → buffer → validation order, and routes keys until the input-router
 * wave takes over.
 */

const FOCUS_CYCLE: WorkspaceFocusRegion[] = ["tree", "editor", "composer"];

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

  const [editorStatusState, setEditorStatusState] = createSignal<{ text: string; tone: EditorStatusTone }>({ text: "", tone: "info" });
  /** Status text (the component reads this for the status-line body). */
  const editorStatus = () => editorStatusState().text;
  /** Status tone (drives the status-line colour — see EditorStatusTone). */
  const editorStatusTone = () => editorStatusState().tone;
  /** Typed setter; clears to neutral info when called with no tone. */
  function status(text: string, tone: EditorStatusTone = "info"): void {
    const current = editorStatusState();
    // Skip identical writes: the dirty tracker clears the line on every
    // keystroke, and an empty-line clear must not re-trigger the status
    // render on each keypress (hot path — see markEditorContentChanged).
    if (current.text === text && current.tone === tone) return;
    setEditorStatusState({ text, tone });
  }
  /** Tracks whether the workspace page has been entered at least once. */
  let workspaceEntered = false;

  // —— viewer ——
  const [openFile, setOpenFile] = createSignal<WorkspaceFilePreview | null>(null);
  const [viewMode, setViewMode] = createSignal<"source" | "preview">("source");
  let viewerScrollBy: ((delta: number) => void) | null = null;
  let viewerScrollEdge: ((edge: ViewerScrollEdge) => void) | null = null;

  const tree = createTreeOwner({
    rootDir,
    onOpenPath: (relPath) => openPath(relPath),
    onLoadError: (message) => status(`failed to load workspace: ${message}`, "error"),
  });

  const buffer = createBufferOwner({
    rootDir,
    onStatus: (text, tone) => status(text, tone),
    onWritten: ({ path, content, stamp }) => {
      tree.invalidateCache(path);
      validation.setFor(path, content, stamp);
    },
    onReloaded: ({ path, content, stamp }) => {
      validation.setFor(path, content, stamp);
    },
    onSaveAsTargetActivated: async (target) => {
      setOpenFile(await readFilePreview(rootDir, target));
      setViewMode("source");
      void tree.rebuildIndex();
    },
    onOverwriteConfirm: (path) => fileOps.raiseDialog({ kind: "overwrite-confirm", path }),
    onSaveAsOverwrite: (target) => fileOps.raiseDialog({ kind: "save-as-overwrite", path: target }),
    onReloadConfirm: (path) => fileOps.raiseDialog({ kind: "reload-confirm", path }),
    onSaveStarted: () => {
      fileOps.clearCloseAfterSave();
    },
  });

  const fileOps = createFileOperationOwner({
    rootDir,
    onStatus: (text, tone) => status(text, tone),
  });

  const validation = createValidationOwner({
    rootDir,
    onStatus: (text, tone) => status(text, tone),
    isDirty: (path) => buffer.dirtyPaths().has(path),
    selectedFilePath: () => {
      const row = tree.rows()[tree.selectedIndex()];
      return row && row.node.kind === "file" ? row.node.relPath : null;
    },
    openFile: () => openFile(),
    canEditOpenFile: () => canEditOpenFile(),
    onJumpTo: (relPath, line) => {
      if (buffer.activeEditorPath() !== relPath) buffer.setActiveEditorPath(relPath);
      setViewMode("source");
      setFocusRegion("editor");
      buffer.gotoLine(line);
    },
  });

  function activatePage(next: ShellPage): void {
    const reentering = next === "workspace" && page() === "workspace";
    setPage(next);
    if (next === "workspace") {
      void tree.ensureLoaded();
      if (reentering || workspaceEntered) void buffer.checkExternalModifications();
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

  // —— viewer actions ——

  /** Whether the currently open file is shown in the editable textarea. */
  function isEditing(): boolean {
    return canEditOpenFile() && viewMode() === "source";
  }

  /** Whether paste may fall through to the focused editable textarea. */
  function editableSourcePasteActive(): boolean {
    return page() === "workspace"
      && focusRegion() === "editor"
      && isEditing()
      && !fileOps.dialogActionPending()
      && !tree.quickOpenActive()
      && !validation.findingsOpen()
      && !buffer.findActive()
      && !buffer.gotoActive()
      && !buffer.saveAsActive()
      && !fileOps.dialog()
      && !fileOps.opsBar();
  }

  /**
   * Whether the open file actually has an admitted editable buffer for its
   * path — i.e. `m edit` would really enter the editor. The file-shape check
   * alone is not enough: the 8-buffer LRU pool can refuse a ninth file when
   * every resident buffer is dirty, leaving the file in the read-only viewer
   * even though `isEditablePreview` is true (Issue #118 §4).
   */
  function canEditOpenFile(): boolean {
    const file = openFile();
    return Boolean(file && isEditablePreview(file) && buffer.activeEditorPath() === file.relPath);
  }

  async function openPath(relPath: string): Promise<boolean> {
    const preview = await readFilePreview(rootDir, relPath);
    if (!preview) return false;
    setOpenFile(preview);
    setViewMode(preview.kind === "markdown" ? "preview" : "source");
    setFocusRegion("editor");
    status("");
    validation.setFor(relPath, preview.lines?.join("\n") ?? "", await readFileStamp(rootDir, relPath));
    if (isEditablePreview(preview)) {
      await buffer.open(relPath);
    } else {
      buffer.setActiveEditorPath(null);
    }
    return true;
  }

  /** Command bridge: open the page, ensure the model is loaded, locate. */
  async function openWorkspaceTarget(relPath?: string): Promise<"file" | "dir" | null> {
    activatePage("workspace");
    await tree.ensureLoaded();
    if (!relPath) return null;
    return tree.locatePath(relPath);
  }

  /**
   * Toggle Markdown preview ↔ source. Requires a Markdown file with loaded
   * text lines: a metadata-only symlink has `kind: "markdown"` but no lines,
   * so advertising or executing a toggle there is a no-op lie (Issue #118 §4/§5).
   */
  function toggleViewMode(): void {
    const file = openFile();
    if (!file || file.kind !== "markdown" || !file.lines) return;
    setViewMode((mode) => (mode === "source" ? "preview" : "source"));
  }

  /** Re-read the open file's preview (viewer `r` — refresh the read-only view). */
  async function reloadViewer(): Promise<void> {
    const file = openFile();
    if (!file) return;
    const preview = await readFilePreview(rootDir, file.relPath);
    if (preview) {
      setOpenFile(preview);
      validation.setFor(file.relPath, preview.lines?.join("\n") ?? "", await readFileStamp(rootDir, file.relPath));
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

  // —— mutation application (fixed tree → buffer → validation order) ——

  /**
   * Apply a frozen file-operation mutation across the owners. The viewer and
   * tree-selection reactions are the facade's own state; buffer rekey/close
   * and validation rekey/clear are each owner's `applyMutation`.
   */
  async function applyMutation(mutation: WorkspaceMutation): Promise<void> {
    await tree.applyMutation(mutation);
    buffer.applyMutation(mutation);
    validation.applyMutation(mutation);
    if (mutation.kind === "created" && mutation.entryType === "directory") {
      tree.selectRelPath(mutation.path);
    }
    if (mutation.kind === "copied" || mutation.kind === "moved") {
      tree.selectRelPath(mutation.target);
    }
    if (mutation.kind === "moved" && openFile()?.relPath === mutation.source) {
      const file = openFile();
      if (file) setOpenFile({ ...file, relPath: mutation.target });
    }
    if (mutation.kind === "deleted" && openFile()?.relPath === mutation.path) {
      setOpenFile(null);
      setFocusRegion("tree");
    }
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
      const row = tree.rows()[tree.selectedIndex()];
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
    if (buffer.dirtyPaths().has(target)) {
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
   * React to whatever the external editor did: a resident buffer is reconciled
   * by the buffer owner (unchanged/modified/removed), and the facade only
   * reacts to viewer/focus state; a non-resident file just has its tree cache
   * + index invalidated and the viewer re-read if it was showing the file.
   */
  async function refreshAfterExternalEdit(relPath: string): Promise<void> {
    const outcome = await buffer.reconcileExternalChange(relPath);
    if (outcome === "not-resident") {
      tree.invalidateCache(relPath);
      await tree.refreshRowsAndIndex();
      if (openFile()?.relPath === relPath) await reloadViewer();
      return;
    }
    if (outcome === "removed" && openFile()?.relPath === relPath) {
      setOpenFile(null);
      setFocusRegion("tree");
    }
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

  // —— save / dialog orchestration ——

  async function forceSaveActive(): Promise<void> {
    const saved = await buffer.forceSave();
    if (saved && fileOps.closeAfterSavePending()) {
      fileOps.clearCloseAfterSave();
      afterDirtyConfirm();
    }
  }

  /**
   * After a dirty-confirm save/discard: drop the buffer's local state, close
   * the file, and return focus to the tree.
   */
  function afterDirtyConfirm(): void {
    const path = buffer.activeEditorPath();
    if (path) buffer.close(path);
    setOpenFile(null);
    setFocusRegion("tree");
    validation.clear();
  }

  function errMsg(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }

  // —— key handling ——

  function handleQuickOpenKey(key: TuiKeyEvent): boolean {
    if (key.name === "escape") { tree.closeQuickOpen(); return true; }
    if (key.name === "up") { tree.moveQuickIndex(-1); return true; }
    if (key.name === "down") { tree.moveQuickIndex(1); return true; }
    if (key.name === "enter") { void tree.chooseQuickMatch(); return true; }
    if (key.name === "backspace") { tree.quickOpenBackspace(); return true; }
    const char = printableChar(key);
    if (char) tree.quickOpenAppend(char);
    return true; // the panel owns all input while open
  }

  function handleFindKey(key: TuiKeyEvent): boolean {
    if (key.name === "escape") { buffer.closeFind(); return true; }
    if (key.name === "enter") {
      // Enter with an empty query closes the bar (matches the goto bar) instead
      // of being a silent no-op; a non-empty query with no matches stays open so
      // the user can revise it.
      if (!buffer.findQuery()) { buffer.closeFind(); return true; }
      const matches = buffer.findMatches();
      if (matches.length === 0) return true;
      buffer.advanceFindMatch(key.shift ? -1 : 1);
      return true;
    }
    if (key.name === "backspace") {
      buffer.findBackspace();
      return true;
    }
    const char = printableChar(key);
    if (char) {
      buffer.findAppend(char);
    }
    return true;
  }

  function handleGotoKey(key: TuiKeyEvent): boolean {
    if (key.name === "escape") { buffer.closeGotoBar(); return true; }
    if (key.name === "enter") {
      buffer.gotoCommit();
      return true;
    }
    if (key.name === "backspace") {
      buffer.gotoBackspace();
      return true;
    }
    const char = printableChar(key);
    if (char && /[0-9]/.test(char)) buffer.gotoAppend(char);
    return true;
  }

  function handleSaveAsKey(key: TuiKeyEvent): boolean {
    if (key.name === "escape") { buffer.closeSaveAsBar(); return true; }
    if (key.name === "enter") {
      buffer.saveAsCommit();
      return true;
    }
    if (key.name === "backspace") {
      buffer.saveAsBackspace();
      return true;
    }
    const char = printableChar(key);
    if (char && /[A-Za-z0-9._\-/]/.test(char)) buffer.saveAsAppend(char);
    return true;
  }

  function handleOpsBarKey(key: TuiKeyEvent): boolean {
    const bar = fileOps.opsBar();
    if (!bar) return false;
    if (key.name === "escape") { fileOps.closeOpsBar(); return true; }
    if (key.name === "enter") {
      void fileOps.opsBarCommit().then(async (mutation) => {
        if (!mutation) return;
        await applyMutation(mutation);
        if (mutation.kind === "created" && mutation.entryType === "file") {
          await openPath(mutation.path);
        }
      });
      return true;
    }
    if (key.name === "backspace") {
      fileOps.opsBarBackspace();
      return true;
    }
    const ch = printableChar(key);
    if (ch && /[A-Za-z0-9._\-/]/.test(ch)) {
      fileOps.opsBarAppend(ch);
    }
    return true;
  }

  function handleDialogKey(key: TuiKeyEvent): boolean {
    const current = fileOps.dialog();
    if (!current) return false;
    if (key.name === "escape") { fileOps.clearCloseAfterSave(); fileOps.closeDialog(); return true; }
    if (current.kind === "dirty-confirm") {
      if (key.name === "y") {
        fileOps.closeDialog();
        // Close only when the save actually landed. A save diverted to the
        // overwrite confirm keeps the buffer open and arms closeAfterSave so
        // force-overwriting completes the close — the edits are never
        // discarded under the user's feet.
        fileOps.runDialogAction(async () => {
          const saved = await buffer.saveActive();
          if (saved) afterDirtyConfirm();
          else fileOps.armCloseAfterSave();
        });
        return true;
      }
      if (key.name === "n") { fileOps.closeDialog(); afterDirtyConfirm(); return true; }
      return true;
    }
    if (current.kind === "overwrite-confirm") {
      if (key.name === "o") {
        fileOps.closeDialog();
        fileOps.runDialogAction(forceSaveActive);
        return true;
      }
      // Save-as satisfies the save intent by itself; the buffer moves to the
      // new path and stays open there.
      if (key.name === "s") { fileOps.clearCloseAfterSave(); fileOps.closeDialog(); buffer.openSaveAs(); return true; }
      if (key.name === "c") { fileOps.clearCloseAfterSave(); fileOps.closeDialog(); return true; }
      return true;
    }
    if (current.kind === "reload-confirm") {
      if (key.name === "y") { fileOps.closeDialog(); fileOps.runDialogAction(buffer.reloadActiveBuffer); return true; }
      if (key.name === "n") { fileOps.closeDialog(); return true; }
      return true;
    }
    if (current.kind === "delete-confirm") {
      // Plan §5.1: "y deletes / anything else cancels".
      if (key.name === "y") {
        const p = current.path;
        fileOps.closeDialog();
        fileOps.runDialogAction(async () => {
          const mutation = await fileOps.execDelete(p);
          if (mutation) await applyMutation(mutation);
        });
        return true;
      }
      fileOps.closeDialog();
      return true;
    }
    if (current.kind === "ops-overwrite") {
      if (key.name === "o") {
        const { op, source, path: target } = current;
        fileOps.closeDialog();
        fileOps.runDialogAction(async () => {
          const mutation = op === "move"
            ? await fileOps.execMove(source, target, true)
            : await fileOps.execCopy(source, target, true);
          if (mutation) await applyMutation(mutation);
        });
        return true;
      }
      if (key.name === "c") { fileOps.closeDialog(); return true; }
      return true;
    }
    if (current.kind === "save-as-overwrite") {
      if (key.name === "o") {
        const p = current.path;
        fileOps.closeDialog();
        fileOps.runDialogAction(() => buffer.performSaveAs(p));
        return true;
      }
      if (key.name === "c" || key.name === "escape") { fileOps.closeDialog(); return true; }
      return true;
    }
    return true;
  }

  function handleTreeKey(key: TuiKeyEvent): boolean {
    switch (key.name) {
      case "up": tree.moveSelection(-1); return true;
      case "down": tree.moveSelection(1); return true;
      case "left": void tree.collapseSelected(); return true;
      case "right": void tree.expandSelected(); return true;
      case "enter": void tree.openSelected(); return true;
      case "r": void tree.refresh(); return true;
      case ".": void tree.toggleHidden(); return true;
      case "/": tree.openQuickOpen(); return true;
      case "a": {
        const row = tree.rows()[tree.selectedIndex()];
        if (row) fileOps.openOpsBar(key.shift ? "create-dir" : "create-file", row.node.relPath, tree.selectionDirPrefix());
        return true;
      }
      case "m":
      case "f2": {
        const row = tree.rows()[tree.selectedIndex()];
        if (row) fileOps.openOpsBar("move", row.node.relPath, tree.selectionDirPrefix());
        return true;
      }
      case "c": {
        const row = tree.rows()[tree.selectedIndex()];
        if (row) fileOps.openOpsBar("copy", row.node.relPath, tree.selectionDirPrefix());
        return true;
      }
      case "d": {
        const row = tree.rows()[tree.selectedIndex()];
        if (row) fileOps.raiseDialog({ kind: "delete-confirm", path: row.node.relPath });
        return true;
      }
      case "v": void validation.treeValidate(); return true;
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
      case "v": void validation.viewerValidate(); return true;
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
    if (key.ctrl && key.shift && key.name === "s") { buffer.openSaveAs(); return true; }
    if (isSaveKey(key)) { void buffer.saveActive(); return true; }
    if (isCtrl(key, "f")) { buffer.openFind(); return true; }
    if (isCtrl(key, "g")) { buffer.openGoto(); return true; }
    if (isCtrl(key, "r")) { buffer.requestReloadActive(); return true; }
    // undo / redo / ctrl+_ legacy fallback: the textarea's custom keyBindings
    // own these — let the key propagate.
    if (key.ctrl && (key.name === "z" || key.name === "y" || key.name === "_")) return false;
    if (key.name === "escape") {
      const path = buffer.activeEditorPath();
      if (path && buffer.dirtyPaths().has(path)) {
        fileOps.raiseDialog({ kind: "dirty-confirm", path });
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
    if (fileOps.dialogActionPending()) return true;
    if (tree.quickOpenActive()) return handleQuickOpenKey(key);
    if (validation.findingsOpen()) return validation.handleFindingsKey(key);
    if (fileOps.dialog()) return handleDialogKey(key);
    if (fileOps.opsBar()) return handleOpsBarKey(key);
    if (buffer.findActive()) return handleFindKey(key);
    if (buffer.gotoActive()) return handleGotoKey(key);
    if (buffer.saveAsActive()) return handleSaveAsKey(key);
    if (key.ctrl && key.name === "p") { tree.openQuickOpen(); return true; }
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
    rows: tree.rows,
    selectedIndex: tree.selectedIndex,
    loading: tree.loading,
    showHidden: tree.showHidden,
    refresh: tree.refresh,
    toggleHidden: tree.toggleHidden,
    locatePath: tree.locatePath,
    openPath,
    // viewer
    openFile,
    viewMode,
    toggleViewMode,
    registerViewerScroller,
    // external editor handoff (B5)
    registerExternalEditor,
    // editor pool
    editorOrder: buffer.editorOrder,
    activeEditorPath: buffer.activeEditorPath,
    dirtyPaths: buffer.dirtyPaths,
    externalChanged: buffer.externalChanged,
    editorStatus,
    editorStatusTone,
    editorInitialContent: buffer.editorInitialContent,
    isEditing,
    editableSourcePasteActive,
    registerEditorInstance: buffer.registerEditorInstance,
    unregisterEditorInstance: buffer.unregisterEditorInstance,
    markEditorContentChanged: buffer.markEditorContentChanged,
    reportCursor: buffer.reportCursor,
    cursorLn: buffer.cursorLn,
    cursorCol: buffer.cursorCol,
    saveActive: buffer.saveActive,
    reloadActiveBuffer: buffer.reloadActiveBuffer,
    // editor bars / dialogs
    findActive: buffer.findActive,
    findQuery: buffer.findQuery,
    findMatches: buffer.findMatches,
    findMatchIndex: buffer.findMatchIndex,
    gotoActive: buffer.gotoActive,
    gotoDraft: buffer.gotoDraft,
    saveAsActive: buffer.saveAsActive,
    saveAsDraft: buffer.saveAsDraft,
    dialog: fileOps.dialog,
    // file management (B4)
    opsBar: fileOps.opsBar,
    // in-page validation (B4)
    validationState: validation.validationState,
    validationSnapshot: validation.validationSnapshot,
    findingsOpen: validation.findingsOpen,
    findingsIndex: validation.findingsIndex,
    canEditOpenFile,
    canJumpToSelectedFinding: validation.canJumpToSelectedFinding,
    // quick open
    quickOpenActive: tree.quickOpenActive,
    quickQuery: tree.quickQuery,
    quickIndex: tree.quickIndex,
    quickMatches: tree.quickMatches,
    openQuickOpen: tree.openQuickOpen,
    closeQuickOpen: tree.closeQuickOpen,
    // keys
    handleKey,
  };
}

export type WorkspaceController = ReturnType<typeof createWorkspaceController>;
