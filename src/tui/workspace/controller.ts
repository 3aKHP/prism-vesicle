import { createSignal } from "solid-js";
import type { TuiKeyEvent } from "../decision-interaction";
import {
  isEditablePreview,
  readFileStamp,
  sameFileStamp,
  type FileStamp,
} from "./buffer-io";
import { createBufferOwner } from "./buffer-owner";
import {
  copyEntry,
  createDirectory,
  createFile,
  entryExists,
  moveEntry,
  removeFile,
  trashEntry,
} from "../workspace-fileops";
import {
  pendingValidation,
  runValidation,
  type LocatedFinding,
  type ValidationState,
} from "../workspace-validate";
import {
  resolveEditorCommand,
  runExternalEditor,
  type EditorRuntime,
} from "../workspace-external-editor";
import { loadSettings, type Settings } from "../../config/settings";
import { assertProjectRelativePath } from "./paths";
import { readFilePreview, statEntry, type WorkspaceFilePreview } from "./tree-data";
import { createTreeOwner } from "./tree-owner";
import type { ShellPage, WorkspaceFocusRegion, ViewerScrollEdge, EditorStatusTone } from "./types";

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
 * `createBufferOwner`; this factory composes the owners, keeps the
 * page/focus model, viewer, dialogs, file mutations, validation, and
 * external-editor orchestration until their own waves take over.
 */

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
    setEditorStatusState({ text, tone });
  }
  /** Tracks whether the workspace page has been entered at least once. */
  let workspaceEntered = false;

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
      setValidationFor(path, content, stamp);
    },
    onReloaded: ({ path, content, stamp }) => {
      setValidationFor(path, content, stamp);
    },
    onSaveAsTargetActivated: async (target) => {
      setOpenFile(await readFilePreview(rootDir, target));
      setViewMode("source");
      void tree.rebuildIndex();
    },
    onOverwriteConfirm: (path) => setDialog({ kind: "overwrite-confirm", path }),
    onSaveAsOverwrite: (target) => setDialog({ kind: "save-as-overwrite", path: target }),
    onReloadConfirm: (path) => setDialog({ kind: "reload-confirm", path }),
    onSaveStarted: () => {
      closeAfterSave = false;
    },
  });

  // —— viewer ——
  const [openFile, setOpenFile] = createSignal<WorkspaceFilePreview | null>(null);
  const [viewMode, setViewMode] = createSignal<"source" | "preview">("source");
  let viewerScrollBy: ((delta: number) => void) | null = null;
  let viewerScrollEdge: ((edge: ViewerScrollEdge) => void) | null = null;

  // —— editor input dialogs ——
  const [dialog, setDialog] = createSignal<EditorDialog>(null);

  // —— file-management ops bar (B4 §5.1) ——
  const [opsBar, setOpsBar] = createSignal<OpsBar>(null);

  // —— in-page validation (B4 §5.2) ——
  // The snapshot is the retained last result plus the path it describes. The
  // projected `validationState()` folds in the dirty-buffer staleness rule so
  // the view never has to: a result whose owning buffer is dirty reads as the
  // neutral `validation stale` state, and clearing the dirty flag (undo to
  // clean, save, reload) restores it without re-running the validators.
  const [validationSnapshot, setValidationSnapshot] = createSignal<ValidationState>(pendingValidation);
  const [findingsOpen, setFindingsOpen] = createSignal(false);
  const [findingsIndex, setFindingsIndex] = createSignal(0);

  /**
   * Displayed validation state. Reads the snapshot plus dirty-buffer truth: a
   * result/no-match whose path is currently dirty projects to `stale` so the
   * old verdict never reads as current over edited content. Plain function (not
   * a memo) so callers — including tests outside a reactive root — always read
   * the latest projection.
   */
  function validationState(): ValidationState {
    const snap = validationSnapshot();
    if ((snap.state === "result" || snap.state === "no-match") && buffer.dirtyPaths().has(snap.path)) {
      return { state: "stale", path: snap.path };
    }
    return snap;
  }

  /**
   * Disk identity (mtime+ino) of the file the snapshot was computed from. The
   * findings panel compares this against the live file before reusing a
   * snapshot, so a deleted-then-recreated or externally rewritten file at the
   * same path cannot inherit the previous file's findings (Issue #118 review
   * round 2).
   */
  let validationStamp: FileStamp | null = null;

  /** Install a fresh snapshot for `relPath` from its content, with its disk identity. */
  function setValidationFor(relPath: string, content: string, stamp: FileStamp | null = null): void {
    setValidationSnapshot(runValidation(relPath, content));
    validationStamp = stamp;
  }

  /** Clear the snapshot back to pending (close/delete of the validated file). */
  function clearValidation(): void {
    setValidationSnapshot(pendingValidation);
    validationStamp = null;
  }

  /** Rekey the snapshot path after a rename/move; the underlying result is unchanged. */
  function rekeyValidation(oldPath: string, newPath: string): void {
    const snap = validationSnapshot();
    if (snap.state !== "pending" && snap.path === oldPath) {
      setValidationSnapshot({ ...snap, path: newPath } as ValidationState);
    }
  }

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
      && !dialogActionPending
      && !tree.quickOpenActive()
      && !findingsOpen()
      && !buffer.findActive()
      && !buffer.gotoActive()
      && !buffer.saveAsActive()
      && !dialog()
      && !opsBar();
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
    setValidationFor(relPath, preview.lines?.join("\n") ?? "", await readFileStamp(rootDir, relPath));
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
      setValidationFor(file.relPath, preview.lines?.join("\n") ?? "", await readFileStamp(rootDir, file.relPath));
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

  function runDialogAction(action: () => Promise<unknown>): void {
    dialogActionPending = true;
    void action().finally(() => { dialogActionPending = false; });
  }

  async function forceSaveActive(): Promise<void> {
    const saved = await buffer.forceSave();
    if (saved && closeAfterSave) {
      closeAfterSave = false;
      afterDirtyConfirm();
    }
  }

  // —— file management (B4 §5.1) ——

  function openOpsBar(kind: OpsBarKind): void {
    const row = tree.rows()[tree.selectedIndex()];
    if (!row) return;
    const source = row.node.relPath;
    // create-* and move/copy both prefill the directory part so the user types
    // the new name in place (B3 save-as taught us a pre-filled full path just
    // has to be cleared first).
    setOpsBar({ kind, draft: tree.selectionDirPrefix(), source });
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
      tree.selectRelPath(relPath);
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
      rekeyAcrossOwners(source, target);
      status(`moved ${source} → ${target}`, "success");
      await afterTreeMutation2(source, target);
      tree.selectRelPath(target);
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
      tree.selectRelPath(target);
    } catch (error) { status(errMsg(error), "error"); }
  }

  async function execDelete(relPath: string): Promise<void> {
    try {
      // Drop any open editable buffer for this path first (the confirm already
      // noted unsaved edits); also clear the viewer if it was showing it.
      if (buffer.stampOf(relPath)) buffer.close(relPath);
      if (openFile()?.relPath === relPath) {
        setOpenFile(null);
        buffer.setActiveEditorPath(null);
        setFocusRegion("tree");
      }
      // A deleted file may own the validation snapshot even when it was never
      // opened (tree `v` validates the selection without opening it). Clear it
      // whenever the snapshot describes the deleted path, so a recreated file
      // at the same path — or an external rewrite — cannot inherit stale
      // findings (Issue #118 review round 2).
      const deletedSnap = validationSnapshot();
      if (deletedSnap.state !== "pending" && deletedSnap.path === relPath) clearValidation();
      const trashPath = await trashEntry(rootDir, relPath);
      status(`moved ${relPath} → ${trashPath} (trash)`, "success");
      await afterTreeMutation(relPath);
    } catch (error) { status(errMsg(error), "error"); }
  }

  /**
   * Rekey an open editable buffer from oldPath to newPath (rename/move) across
   * the owners: the buffer owner rekeys pool state, the facade rekeys the
   * viewer preview and the validation snapshot. Content and dirty state
   * survive via the captured plainText → initialValue on remount; the
   * textarea's undo stack does NOT survive the path-keyed remount (a known B4
   * limitation — finish editing before renaming if undo matters).
   */
  function rekeyAcrossOwners(oldPath: string, newPath: string): void {
    buffer.rekey(oldPath, newPath);
    const file = openFile();
    if (file?.relPath === oldPath) setOpenFile({ ...file, relPath: newPath });
    rekeyValidation(oldPath, newPath);
  }

  async function afterTreeMutation(relPath: string): Promise<void> {
    tree.invalidateCache(relPath);
    await tree.refreshRowsAndIndex();
  }

  async function afterTreeMutation2(source: string, target: string): Promise<void> {
    tree.invalidateCache(source);
    tree.invalidateCache(target);
    await tree.refreshRowsAndIndex();
  }

  function errMsg(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }

  // —— in-page validation (B4 §5.2) ——

  /**
   * Open the findings panel for a snapshot already current for `relPath`
   * (consume, no re-run). Returns false when the caller should bail. Reuse is
   * gated on the live file's disk identity still matching the snapshot's, so a
   * recreated or externally rewritten file at the same path does not inherit
   * stale findings (Issue #118 review round 2).
   */
  async function openFindingsForCurrent(relPath: string): Promise<boolean> {
    const snap = validationSnapshot();
    if ((snap.state === "result" || snap.state === "no-match") && snap.path === relPath && !buffer.dirtyPaths().has(relPath)) {
      const current = await readFileStamp(rootDir, relPath);
      if (validationStamp !== null && current !== null && sameFileStamp(current, validationStamp)) {
        setFindingsIndex(0);
        setFindingsOpen(true);
        return true;
      }
    }
    return false;
  }

  /**
   * Tree-focus `v` targets the selected row, never an unrelated open file
   * (Issue #118 §3). A directory or empty selection stays closed with a hint;
   * a dirty buffer is not silently validated against its older disk image; a
   * snapshot already current for the selection is consumed rather than re-run.
   */
  async function treeValidate(): Promise<void> {
    const row = tree.rows()[tree.selectedIndex()];
    if (!row || row.node.kind !== "file") {
      status("select a file to validate", "info");
      return;
    }
    const relPath = row.node.relPath;
    if (buffer.dirtyPaths().has(relPath)) {
      status(`save ${relPath} before validating`, "info");
      return;
    }
    if (await openFindingsForCurrent(relPath)) return;
    const preview = await readFilePreview(rootDir, relPath);
    if (!preview) {
      status(`${relPath} is not readable`, "error");
      return;
    }
    const stamp = await readFileStamp(rootDir, relPath);
    setValidationFor(relPath, preview.lines?.join("\n") ?? "", stamp);
    setFindingsIndex(0);
    setFindingsOpen(true);
  }

  /**
   * Viewer-focus `v` targets the open file. Same dirty-buffer and consume
   * rules as the tree path; re-validates only when the snapshot is stale or
   * for a different file.
   */
  async function viewerValidate(): Promise<void> {
    const file = openFile();
    if (!file) { status("open a file to validate", "info"); return; }
    if (buffer.dirtyPaths().has(file.relPath)) {
      status(`save ${file.relPath} before validating`, "info");
      return;
    }
    if (await openFindingsForCurrent(file.relPath)) return;
    const stamp = await readFileStamp(rootDir, file.relPath);
    setValidationFor(file.relPath, file.lines?.join("\n") ?? "", stamp);
    setFindingsIndex(0);
    setFindingsOpen(true);
  }

  /**
   * Whether `Enter` in the findings panel would really jump. Requires an
   * admitted editable buffer for the open file and a selected finding with a
   * resolvable line (Issue #118 §4 — read-only / oversized / refused-buffer
   * targets must neither advertise nor execute a jump).
   */
  function canJumpToSelectedFinding(): boolean {
    const file = openFile();
    if (!file || !canEditOpenFile()) return false;
    const snap = validationSnapshot();
    if (snap.state !== "result") return false;
    // The findings panel can describe a different file than the one open (tree
    // `v` validates the selection without opening it). A jump must target the
    // open buffer, so refuse — and do not advertise Enter — when the snapshot
    // belongs to another file (Issue #118 review: cross-file jump).
    if (snap.path !== file.relPath) return false;
    const finding = snap.findings[findingsIndex()];
    return Boolean(finding && finding.line !== null);
  }

  function handleFindingsKey(key: TuiKeyEvent): boolean {
    const state = validationSnapshot();
    const findings = state.state === "result" ? state.findings : [];
    if (key.name === "escape") { setFindingsOpen(false); return true; }
    if (findings.length === 0) return true;
    if (key.name === "up") { setFindingsIndex((i) => Math.max(0, i - 1)); return true; }
    if (key.name === "down") { setFindingsIndex((i) => Math.min(findings.length - 1, i + 1)); return true; }
    if (key.name === "enter") {
      if (canJumpToSelectedFinding()) {
        const finding = findings[findingsIndex()];
        if (finding) jumpToFinding(finding);
      }
      return true;
    }
    return true;
  }

  /** Land the active editable buffer at a finding's line and close the panel. */
  function jumpToFinding(finding: LocatedFinding): void {
    const file = openFile();
    // Defence-in-depth alongside canJumpToSelectedFinding: never jump a finding
    // from another file's snapshot into the open buffer.
    const snap = validationSnapshot();
    if (!file || !canEditOpenFile() || finding.line === null) return;
    if (snap.state !== "pending" && snap.path !== file.relPath) return;
    if (buffer.activeEditorPath() !== file.relPath) buffer.setActiveEditorPath(file.relPath);
    setViewMode("source");
    setFocusRegion("editor");
    setFindingsOpen(false);
    buffer.gotoLine(finding.line);
  }

  // —— quick open keys ——

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

  // —— key handling ——

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
        runDialogAction(async () => {
          const saved = await buffer.saveActive();
          if (saved) afterDirtyConfirm();
          else closeAfterSave = true;
        });
        return true;
      }
      if (key.name === "n") { setDialog(null); afterDirtyConfirm(); return true; }
      return true;
    }
    if (current.kind === "overwrite-confirm") {
      if (key.name === "o") {
        setDialog(null);
        runDialogAction(forceSaveActive);
        return true;
      }
      // Save-as satisfies the save intent by itself; the buffer moves to the
      // new path and stays open there.
      if (key.name === "s") { closeAfterSave = false; setDialog(null); buffer.openSaveAs(); return true; }
      if (key.name === "c") { closeAfterSave = false; setDialog(null); return true; }
      return true;
    }
    if (current.kind === "reload-confirm") {
      if (key.name === "y") { setDialog(null); runDialogAction(buffer.reloadActiveBuffer); return true; }
      if (key.name === "n") { setDialog(null); return true; }
      return true;
    }
    if (current.kind === "delete-confirm") {
      // Plan §5.1: "y deletes / anything else cancels".
      if (key.name === "y") {
        const p = current.path;
        setDialog(null);
        runDialogAction(() => execDelete(p));
        return true;
      }
      setDialog(null);
      return true;
    }
    if (current.kind === "ops-overwrite") {
      if (key.name === "o") {
        const { op, source, path: target } = current;
        setDialog(null);
        if (op === "move") runDialogAction(() => execMove(source, target, true));
        else runDialogAction(() => execCopy(source, target, true));
        return true;
      }
      if (key.name === "c") { setDialog(null); return true; }
      return true;
    }
    if (current.kind === "save-as-overwrite") {
      if (key.name === "o") {
        const p = current.path;
        setDialog(null);
        runDialogAction(() => buffer.performSaveAs(p));
        return true;
      }
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
    const path = buffer.activeEditorPath();
    if (path) buffer.close(path);
    setOpenFile(null);
    setFocusRegion("tree");
    clearValidation();
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
      case "a": openOpsBar(key.shift ? "create-dir" : "create-file"); return true;
      case "m":
      case "f2": openOpsBar("move"); return true;
      case "c": openOpsBar("copy"); return true;
      case "d": {
        const row = tree.rows()[tree.selectedIndex()];
        if (row) setDialog({ kind: "delete-confirm", path: row.node.relPath });
        return true;
      }
      case "v": void treeValidate(); return true;
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
      case "v": void viewerValidate(); return true;
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
    if (tree.quickOpenActive()) return handleQuickOpenKey(key);
    if (findingsOpen()) return handleFindingsKey(key);
    if (dialog()) return handleDialogKey(key);
    if (opsBar()) return handleOpsBarKey(key);
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
    dialog,
    // file management (B4)
    opsBar,
    // in-page validation (B4)
    validationState,
    validationSnapshot,
    findingsOpen,
    findingsIndex,
    canEditOpenFile,
    canJumpToSelectedFinding,
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
