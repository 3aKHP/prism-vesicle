import { createSignal } from "solid-js";
import type { TextareaRenderable } from "@opentui/core";
import {
  atomicWriteFile,
  computeFindOffsets,
  readEditableFile,
  readFileStamp,
  sameFileStamp,
  type FileStamp,
} from "./buffer-io";
import { entryExists } from "./file-operations";
import { assertProjectRelativePath } from "./paths";
import type { EditorStatusTone, ExternalEditOutcome, WorkspaceMutation } from "./types";

/**
 * Workspace editor-buffer owner (Scope B / #62, milestone B3). Uniquely owns
 * the editable-buffer pool state: LRU editor order, the active buffer path,
 * dirty paths, externally-changed paths, per-buffer metadata (saved snapshot +
 * disk identity), textarea instances, cursor readout, and the find / goto /
 * save-as input bars, plus the save / save-as / reload lifecycle.
 *
 * Boundary: dirty/clean truth is `instance.plainText !== meta.savedSnapshot`
 * and disk identity is mtime + inode, both judged only here (or through the
 * shared `sameFileStamp` comparator in buffer-io). The owner never touches the
 * tree scan cache, validation snapshots, or external processes; cross-domain
 * side effects flow through the narrow ports below, and the facade applies
 * them.
 */

export type BufferWritten = {
  path: string;
  content: string;
  stamp: FileStamp | null;
};


export type BufferOwnerPorts = {
  rootDir: string;
  /** Status-line write for buffer-lifecycle messages (facade owns the line). */
  onStatus: (text: string, tone?: EditorStatusTone) => void;
  /** A save landed: invalidate the tree cache and refresh validation. */
  onWritten: (result: BufferWritten) => void;
  /** A reload/replace landed: refresh validation from the new content. */
  onReloaded: (result: BufferWritten) => void;
  /** Save-as switched the active buffer to `target`: refresh viewer + index. */
  onSaveAsTargetActivated: (target: string) => Promise<void>;
  /** The active buffer changed on disk: raise the overwrite confirm. */
  onOverwriteConfirm: (path: string) => void;
  /** Save-as would clobber an existing file: raise the save-as overwrite confirm. */
  onSaveAsOverwrite: (target: string) => void;
  /** A dirty/externally-changed buffer asks to reload: raise the reload confirm. */
  onReloadConfirm: (path: string) => void;
  /** A save is starting: clear any leftover close-intent from a prior dialog chain. */
  onSaveStarted: () => void;
};

function errMsg(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** LRU cap for open editable buffers (spike §4.1 / plan §4.1). */
const EDITOR_LRU_CAP = 8;

type EditorBufferMeta = FileStamp & {
  savedSnapshot: string;
  initialContent: string;
};

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

export function createBufferOwner(options: BufferOwnerPorts) {
  const { rootDir, onStatus } = options;

  // editorOrder: most-recently-used first. activeEditorPath: the editable
  // buffer currently shown (null while a read-only file or no file is open).
  const [editorOrder, setEditorOrder] = createSignal<string[]>([]);
  const [activeEditorPath, setActiveEditorPath] = createSignal<string | null>(null);
  const [dirtyPaths, setDirtyPaths] = createSignal<ReadonlySet<string>>(new Set());
  const [externalChanged, setExternalChanged] = createSignal<ReadonlySet<string>>(new Set());
  const bufferMeta = new Map<string, EditorBufferMeta>();
  const instances = new Map<string, TextareaRenderable>();

  // cursor position of the active buffer (status line Ln:Col), 0-indexed
  const [cursorLn, setCursorLn] = createSignal(0);
  const [cursorCol, setCursorCol] = createSignal(0);

  // —— editor input bars ——
  const [findActive, setFindActive] = createSignal(false);
  const [findQuery, setFindQuery] = createSignal("");
  const [findMatches, setFindMatches] = createSignal<number[]>([]);
  const [findMatchIndex, setFindMatchIndex] = createSignal(-1);
  let findPlainSnapshot = "";

  const [gotoActive, setGotoActive] = createSignal(false);
  const [gotoDraft, setGotoDraft] = createSignal("");

  const [saveAsActive, setSaveAsActive] = createSignal(false);
  const [saveAsDraft, setSaveAsDraft] = createSignal("");

  // —— instance + dirty tracking ——

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
    if (dirty) onStatus("");
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

  // —— pool lifecycle ——

  /**
   * Admit a file into the editable buffer pool (LRU, dirty-protected). On the
   * rare "all dirty" refusal the file still opens in the read-only viewer and
   * a status line explains why no buffer was created.
   */
  async function open(relPath: string): Promise<void> {
    if (!editorOrder().includes(relPath) && editorOrder().length >= EDITOR_LRU_CAP) {
      const victim = [...editorOrder()].reverse().find((path) => !dirtyPaths().has(path));
      if (!victim) {
        onStatus(`${EDITOR_LRU_CAP} buffers open and all dirty — save or close one first`, "error");
        setActiveEditorPath(null);
        return;
      }
      close(victim);
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

  function close(relPath: string): void {
    setEditorOrder((order) => order.filter((path) => path !== relPath));
    bufferMeta.delete(relPath);
    setDirtyPaths((set) => {
      if (!set.has(relPath)) return set;
      const next = new Set(set);
      next.delete(relPath);
      return next;
    });
    // A closed path must leave every pool set: a stale †disk marker would keep
    // the status line pinned to warn after the buffer is gone. The `instances`
    // map is deliberately left to the view's unmount lifecycle
    // (unregisterEditorInstance): the textarea stays mounted while Solid
    // reconciles, and purging here would orphan its registration and silently
    // disable saves after a rekey onto a still-mounted buffer.
    setExternalChanged((set) => {
      if (!set.has(relPath)) return set;
      const next = new Set(set);
      next.delete(relPath);
      return next;
    });
    if (activeEditorPath() === relPath) setActiveEditorPath(null);
  }

  // —— save / save-as / reload ——

  async function saveActive(): Promise<boolean> {
    // Clear any close-intent left over from a prior dirty-confirm chain so it
    // can't leak into this unrelated save (a stale closeAfterSave could close
    // the wrong buffer when a later plain save force-overwrites). The dirty-
    // confirm 'y' path re-arms it in its own .then, after this returns.
    options.onSaveStarted();
    const path = activeEditorPath();
    if (!path) return false;
    const instance = instances.get(path);
    const meta = bufferMeta.get(path);
    if (!instance || !meta) return false;
    const currentStamp = await readFileStamp(rootDir, path);
    if (currentStamp !== null && !sameFileStamp(currentStamp, meta)) {
      options.onOverwriteConfirm(path);
      return false;
    }
    return Boolean(await writeBuffer(path, instance.plainText));
  }

  /** Write the active buffer's content even when the disk identity changed. */
  async function forceSave(): Promise<boolean> {
    const path = activeEditorPath();
    if (!path) return false;
    const instance = instances.get(path);
    if (!instance) return false;
    return Boolean(await writeBuffer(path, instance.plainText));
  }

  /**
   * Atomic write + post-save bookkeeping. Returns null (and surfaces a status
   * error) on a disk failure rather than throwing, so the `void saveActive()`
   * callers don't surface unhandled rejections and the buffer stays dirty.
   */
  async function writeBuffer(relPath: string, content: string): Promise<BufferWritten | null> {
    let abs: string;
    try {
      abs = assertProjectRelativePath(rootDir, relPath);
      await atomicWriteFile(abs, content);
    } catch (error) {
      onStatus(`failed to save ${relPath}: ${errMsg(error)}`, "error");
      return null;
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
    const result = { path: relPath, content, stamp };
    onStatus(`saved ${relPath}`, "success");
    options.onWritten(result);
    return result;
  }

  async function commitSaveAs(target: string): Promise<void> {
    const path = activeEditorPath();
    if (!path) return;
    const instance = instances.get(path);
    if (!instance) return;
    const trimmed = target.trim().replace(/\\/g, "/");
    if (!trimmed) {
      onStatus("save-as needs a path", "error");
      return;
    }
    try {
      assertProjectRelativePath(rootDir, trimmed);
    } catch (error) {
      onStatus(String(error instanceof Error ? error.message : error), "error");
      return;
    }
    // Refuse to silently clobber a different existing file — mirror the
    // move/copy overwrite confirm. 'o' completes the save-as via performSaveAs.
    if (trimmed !== path && await entryExists(rootDir, trimmed)) {
      options.onSaveAsOverwrite(trimmed);
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
    close(path);
    const writtenStamp = await readFileStamp(rootDir, target);
    bufferMeta.set(target, {
      savedSnapshot: content,
      mtimeMs: writtenStamp?.mtimeMs ?? Date.now(),
      ino: writtenStamp?.ino ?? 0,
      initialContent: content,
    });
    setEditorOrder((order) => [target, ...order.filter((p) => p !== target)]);
    setActiveEditorPath(target);
    await options.onSaveAsTargetActivated(target);
  }

  async function reloadActiveBuffer(): Promise<void> {
    const path = activeEditorPath();
    if (!path) return;
    const read = await readEditableFile(rootDir, path);
    if (!read) {
      onStatus(`${path} is gone from disk`, "error");
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
    // Reload is a content change: install a fresh snapshot so the status row
    // never reads the pre-reload verdict as current (Issue #118 §3).
    options.onReloaded({ path, content: read.content, stamp: { mtimeMs: read.mtimeMs, ino: read.ino } });
    onStatus(`reloaded ${path}`, "success");
  }

  function requestReloadActive(): void {
    const path = activeEditorPath();
    if (!path) return;
    if (dirtyPaths().has(path) || externalChanged().has(path)) {
      options.onReloadConfirm(path);
    } else {
      onStatus(`${path} is already current`);
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
    onStatus(`${changed.length} file(s) changed on disk — Ctrl+R to reload`, "warn");
  }

  /**
   * External-editor reconciliation for a resident buffer: compare the live
   * disk identity, replace the buffer content when modified, close it when
   * removed, and surface the outcome class so the facade can react to
   * viewer/focus state. A non-resident path returns `not-resident`.
   */
  async function reconcileExternalChange(relPath: string): Promise<ExternalEditOutcome> {
    const meta = bufferMeta.get(relPath);
    if (!meta) return "not-resident";
    const currentStamp = await readFileStamp(rootDir, relPath);
    if (currentStamp === null) {
      onStatus(`${relPath} was removed by the external editor`, "error");
      close(relPath);
      return "removed";
    }
    if (sameFileStamp(currentStamp, meta)) {
      onStatus("no changes from external editor");
      return "unchanged";
    }
    const read = await readEditableFile(rootDir, relPath);
    if (!read) {
      onStatus(`${relPath} is no longer a readable file`, "error");
      close(relPath);
      return "unreadable";
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
    options.onReloaded({ path: relPath, content: read.content, stamp: { mtimeMs: read.mtimeMs, ino: read.ino } });
    onStatus(`reloaded ${relPath}`, "success");
    return "modified";
  }

  /** Rekey a resident buffer from oldPath to newPath (rename/move). */
  function rekey(oldPath: string, newPath: string): void {
    if (oldPath === newPath) return;
    const meta = bufferMeta.get(oldPath);
    if (!meta) return;
    // Renaming A onto an already-open B: close B first — the move is
    // overwriting B on disk, so B's stale buffer + pool slot must go before
    // we rekey A, otherwise editorOrder ends up with newPath twice and B's
    // meta is silently clobbered.
    if (bufferMeta.has(newPath)) close(newPath);
    const inst = instances.get(oldPath);
    const currentText = inst?.plainText ?? meta.savedSnapshot;
    bufferMeta.delete(oldPath);
    bufferMeta.set(newPath, { ...meta, initialContent: currentText });
    instances.delete(oldPath);
    setEditorOrder((order) => order.map((p) => (p === oldPath ? newPath : p)));
    setActiveEditorPath((p) => (p === oldPath ? newPath : p));
    setDirtyPaths((set) => rekeySet(set, oldPath, newPath));
    setExternalChanged((set) => rekeySet(set, oldPath, newPath));
  }

  function rekeySet(set: ReadonlySet<string>, oldPath: string, newPath: string): ReadonlySet<string> {
    if (!set.has(oldPath)) return set;
    const next = new Set(set);
    next.delete(oldPath);
    next.add(newPath);
    return next;
  }

  /** Apply a frozen file-operation mutation to pool state. */
  function applyMutation(mutation: WorkspaceMutation): void {
    if (mutation.kind === "moved") {
      rekey(mutation.source, mutation.target);
      return;
    }
    if (mutation.kind === "deleted" && stampOf(mutation.path)) {
      close(mutation.path);
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

  function findBackspace(): void {
    setFindQuery((query) => query.slice(0, -1));
    refreshFind();
  }

  function findAppend(char: string): void {
    setFindQuery((query) => query + char);
    refreshFind();
  }

  /** Enter with matches: move to the next/previous match (shift inverts). */
  function advanceFindMatch(step: 1 | -1): void {
    const matches = findMatches();
    if (matches.length === 0) return;
    const next = (findMatchIndex() + step + matches.length) % matches.length;
    setFindMatchIndex(next);
    selectFindMatch(next);
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

  function closeGotoBar(): void {
    setGotoActive(false);
  }

  function gotoBackspace(): void {
    setGotoDraft((draft) => draft.slice(0, -1));
  }

  function gotoAppend(char: string): void {
    setGotoDraft((draft) => draft + char);
  }

  function gotoCommit(): void {
    const target = parseInt(gotoDraft(), 10);
    setGotoActive(false);
    if (Number.isFinite(target) && target >= 1) {
      gotoLine(target - 1);
    }
  }

  function openSaveAs(): void {
    if (!activeEditorPath()) return;
    // Start empty: in a keyboard line-input, typing appends, so pre-filling
    // the current path would force the user to clear it first. The status
    // line shows "save as: ▌" and Enter commits the typed path.
    setSaveAsDraft("");
    setSaveAsActive(true);
  }

  function closeSaveAsBar(): void {
    setSaveAsActive(false);
  }

  function saveAsBackspace(): void {
    setSaveAsDraft((draft) => draft.slice(0, -1));
  }

  function saveAsAppend(char: string): void {
    setSaveAsDraft((draft) => draft + char);
  }

  function saveAsCommit(): void {
    const target = saveAsDraft();
    setSaveAsActive(false);
    void commitSaveAs(target);
  }

  /** Imperative cursor jump on the active buffer (goto bar / findings jump). */
  function gotoLine(line: number): void {
    const inst = activeInstance();
    if (!inst) return;
    inst.gotoLine(line);
    resetStaleHorizontalScroll(inst);
  }

  /** Resident disk identity of an open buffer, or null when not resident. */
  function stampOf(relPath: string): FileStamp | null {
    const meta = bufferMeta.get(relPath);
    return meta ? { mtimeMs: meta.mtimeMs, ino: meta.ino } : null;
  }

  return {
    // editor pool
    editorOrder,
    activeEditorPath,
    dirtyPaths,
    externalChanged,
    editorInitialContent,
    registerEditorInstance,
    unregisterEditorInstance,
    markEditorContentChanged,
    reportCursor,
    cursorLn,
    cursorCol,
    // lifecycle
    open,
    close,
    saveActive,
    forceSave,
    reloadActiveBuffer,
    requestReloadActive,
    checkExternalModifications,
    reconcileExternalChange,
    rekey,
    applyMutation,
    stampOf,
    setActiveEditorPath,
    // find / goto / save-as
    findActive,
    findQuery,
    findMatches,
    findMatchIndex,
    openFind,
    closeFind,
    findBackspace,
    findAppend,
    advanceFindMatch,
    gotoActive,
    gotoDraft,
    openGoto,
    closeGotoBar,
    gotoBackspace,
    gotoAppend,
    gotoCommit,
    saveAsActive,
    saveAsDraft,
    openSaveAs,
    closeSaveAsBar,
    saveAsBackspace,
    saveAsAppend,
    saveAsCommit,
    commitSaveAs,
    performSaveAs,
    gotoLine,
  };
}

export type BufferOwner = ReturnType<typeof createBufferOwner>;
