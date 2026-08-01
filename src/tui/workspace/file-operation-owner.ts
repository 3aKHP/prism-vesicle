import { createSignal } from "solid-js";
import {
  copyEntry,
  createDirectory,
  createFile,
  entryExists,
  moveEntry,
  removeFile,
  trashEntry,
} from "./file-operations";
import { assertProjectRelativePath } from "./paths";
import type { EditorStatusTone, WorkspaceMutation } from "./types";

/**
 * Workspace file-operation owner (Scope B / #62, milestone B4). Uniquely owns
 * the tree file-management state: the ops bar (create/move/copy path prompts),
 * the overwrite/delete confirm dialog surface and its action serialization,
 * and the guarded mutation execution (create / move / copy / delete).
 *
 * Boundary: every successful mutation is returned as a frozen
 * `WorkspaceMutation`; the facade applies it to the owners in the fixed
 * tree → buffer → validation order. This owner never reads editor instances
 * or validation snapshots, and it never rekeys another owner's state.
 */

export type OpsBarKind = "create-file" | "create-dir" | "move" | "copy";
export type OpsBar = { kind: OpsBarKind; draft: string; source: string } | null;

export type FileOpOwnerPorts = {
  rootDir: string;
  /** Status-line write for mutation results and refusals (facade owns the line). */
  onStatus: (text: string, tone?: EditorStatusTone) => void;
};

function errMsg(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function createFileOperationOwner(options: FileOpOwnerPorts) {
  const { rootDir, onStatus } = options;

  // —— tree file-management ops bar (B4 §5.1) ——
  const [opsBar, setOpsBar] = createSignal<OpsBar>(null);

  // —— confirm dialogs + action serialization ——
  // The dialog signal is the page's single modal surface; B3 buffer dialogs
  // (dirty/overwrite/reload/save-as overwrite) are raised through the facade
  // into this owner, which serializes every async dialog action behind
  // `dialogActionPending` so a fast Esc cannot reopen a dialog against an
  // in-flight save.
  const [dialog, setDialog] = createSignal<EditorDialog>(null);
  let dialogActionPending = false;

  /**
   * Set when a dirty-confirm "save and close" diverts to the overwrite
   * confirm: the close intent survives, so force-overwriting completes the
   * close. saveActive() clears it at the start of every save (via the facade's
   * onSaveStarted wiring) so it can't leak across buffers; choosing save-as or
   * cancelling clears it too.
   */
  let closeAfterSave = false;

  function raiseDialog(next: EditorDialog): void {
    setDialog(next);
  }

  function closeDialog(): void {
    setDialog(null);
  }

  function runDialogAction(action: () => Promise<unknown>): void {
    dialogActionPending = true;
    void action().finally(() => { dialogActionPending = false; });
  }

  function armCloseAfterSave(): void {
    closeAfterSave = true;
  }

  function clearCloseAfterSave(): void {
    closeAfterSave = false;
  }

  // —— ops bar ——

  /**
   * Open an ops bar with the tree selection's directory prefix pre-filled.
   * The facade supplies the selected row and its directory prefix (tree
   * state); this owner only shapes the bar.
   */
  function openOpsBar(kind: OpsBarKind, source: string, dirPrefix: string): void {
    // create-* and move/copy both prefill the directory part so the user types
    // the new name in place (B3 save-as taught us a pre-filled full path just
    // has to be cleared first).
    setOpsBar({ kind, draft: dirPrefix, source });
  }

  function closeOpsBar(): void {
    setOpsBar(null);
  }

  function opsBarBackspace(): void {
    setOpsBar((b) => (b ? { ...b, draft: b.draft.slice(0, -1) } : b));
  }

  function opsBarAppend(char: string): void {
    setOpsBar((b) => (b ? { ...b, draft: b.draft + char } : b));
  }

  /** Enter on the ops bar: commit the draft as a guarded mutation. */
  async function opsBarCommit(): Promise<WorkspaceMutation | null> {
    const bar = opsBar();
    if (!bar) return null;
    const draft = bar.draft.trim().replace(/\\/g, "/");
    setOpsBar(null);
    if (!draft) { onStatus(`${bar.kind} needs a path`, "error"); return null; }
    try {
      assertProjectRelativePath(rootDir, draft);
    } catch (error) {
      onStatus(String(error instanceof Error ? error.message : error), "error");
      return null;
    }
    if (bar.kind === "create-file") return execCreateFile(draft);
    if (bar.kind === "create-dir") return execCreateDir(draft);
    if (bar.kind === "move") return execMove(bar.source, draft, false);
    return execCopy(bar.source, draft, false);
  }

  // —— guarded mutations ——

  async function execCreateFile(relPath: string): Promise<WorkspaceMutation | null> {
    try {
      await createFile(rootDir, relPath);
      onStatus(`created ${relPath}`, "success");
      return { kind: "created", path: relPath, entryType: "file" };
    } catch (error) { onStatus(errMsg(error), "error"); return null; }
  }

  async function execCreateDir(relPath: string): Promise<WorkspaceMutation | null> {
    try {
      await createDirectory(rootDir, relPath);
      onStatus(`created directory ${relPath}`, "success");
      return { kind: "created", path: relPath, entryType: "directory" };
    } catch (error) { onStatus(errMsg(error), "error"); return null; }
  }

  async function execMove(source: string, target: string, overwrite: boolean): Promise<WorkspaceMutation | null> {
    if (target === source) { onStatus("move target equals source", "error"); return null; }
    if (!overwrite && await entryExists(rootDir, target)) {
      raiseDialog({ kind: "ops-overwrite", path: target, op: "move", source });
      return null;
    }
    try {
      if (overwrite) await removeFile(rootDir, target);
      await moveEntry(rootDir, source, target);
      onStatus(`moved ${source} → ${target}`, "success");
      return { kind: "moved", source, target };
    } catch (error) { onStatus(errMsg(error), "error"); return null; }
  }

  async function execCopy(source: string, target: string, overwrite: boolean): Promise<WorkspaceMutation | null> {
    if (target === source) { onStatus("copy target equals source", "error"); return null; }
    if (!overwrite && await entryExists(rootDir, target)) {
      raiseDialog({ kind: "ops-overwrite", path: target, op: "copy", source });
      return null;
    }
    try {
      if (overwrite) await removeFile(rootDir, target);
      await copyEntry(rootDir, source, target);
      onStatus(`copied ${source} → ${target}`, "success");
      return { kind: "copied", source, target };
    } catch (error) { onStatus(errMsg(error), "error"); return null; }
  }

  async function execDelete(relPath: string): Promise<WorkspaceMutation | null> {
    try {
      const trashPath = await trashEntry(rootDir, relPath);
      onStatus(`moved ${relPath} → ${trashPath} (trash)`, "success");
      return { kind: "deleted", path: relPath };
    } catch (error) { onStatus(errMsg(error), "error"); return null; }
  }

  return {
    // ops bar
    opsBar,
    openOpsBar,
    closeOpsBar,
    opsBarBackspace,
    opsBarAppend,
    opsBarCommit,
    // dialogs + serialization
    dialog,
    raiseDialog,
    closeDialog,
    runDialogAction,
    dialogActionPending: () => dialogActionPending,
    armCloseAfterSave,
    clearCloseAfterSave,
    closeAfterSavePending: () => closeAfterSave,
    // mutations
    execCreateFile,
    execCreateDir,
    execMove,
    execCopy,
    execDelete,
  };
}

export type FileOperationOwner = ReturnType<typeof createFileOperationOwner>;

export type EditorDialog =
  | { kind: "dirty-confirm"; path: string }
  | { kind: "overwrite-confirm"; path: string }
  | { kind: "reload-confirm"; path: string }
  | { kind: "delete-confirm"; path: string }
  | { kind: "ops-overwrite"; path: string; op: "move" | "copy"; source: string }
  | { kind: "save-as-overwrite"; path: string }
  | null;
