import { createSignal } from "solid-js";
import type { TuiKeyEvent } from "../decision-interaction";
import { readFileStamp, sameFileStamp, type FileStamp } from "./buffer-io";
import { readFilePreview, type WorkspaceFilePreview } from "./tree-data";
import {
  pendingValidation,
  runValidation,
  type LocatedFinding,
  type ValidationState,
} from "./validation";
import type { WorkspaceMutation } from "./types";

/**
 * Workspace in-page validation owner (Scope B / #62, milestone B4 §5.2).
 * Uniquely owns the path-owned validation snapshot, its disk-identity stamp,
 * the dirty-to-stale projection, and the findings panel state (open / index /
 * jump), plus the validation triggering rules for tree and viewer focus.
 *
 * Boundary: the owner never mutates the filesystem and never reads editor
 * instance state. Dirty-buffer truth, tree selection, and the open file /
 * editable admission arrive through narrow accessor ports wired by the
 * facade; content reads go through the same pure modules the other owners
 * use (tree-data previews, buffer-io stamps).
 */

export type ValidationOwnerPorts = {
  rootDir: string;
  /** Status-line write for validation messages (facade owns the line). */
  onStatus: (text: string, tone?: "info" | "success" | "warn" | "error") => void;
  /** Dirty-buffer truth from the buffer owner (drives the stale projection). */
  isDirty: (path: string) => boolean;
  /** The tree selection's file path, or null when not a file row. */
  selectedFilePath: () => string | null;
  /** The open preview (viewer state), or null when nothing is open. */
  openFile: () => WorkspaceFilePreview | null;
  /** Whether an editable buffer is admitted for the open file. */
  canEditOpenFile: () => boolean;
  /** Land the open editable buffer at a finding's line (buffer/viewer/focus). */
  onJumpTo: (relPath: string, line: number) => void;
};

export function createValidationOwner(options: ValidationOwnerPorts) {
  const { rootDir, onStatus } = options;

  // The snapshot is the retained last result plus the path it describes. The
  // projected `validationState()` folds in the dirty-buffer staleness rule so
  // the view never has to: a result whose owning buffer is dirty reads as the
  // neutral `validation stale` state, and clearing the dirty flag (undo to
  // clean, save, reload) restores it without re-running the validators.
  const [validationSnapshot, setValidationSnapshot] = createSignal<ValidationState>(pendingValidation);
  const [findingsOpen, setFindingsOpen] = createSignal(false);
  const [findingsIndex, setFindingsIndex] = createSignal(0);

  /**
   * Disk identity (mtime+ino) of the file the snapshot was computed from. The
   * findings panel compares this against the live file before reusing a
   * snapshot, so a deleted-then-recreated or externally rewritten file at the
   * same path cannot inherit the previous file's findings (Issue #118 review
   * round 2).
   */
  let validationStamp: FileStamp | null = null;

  /**
   * Displayed validation state. Reads the snapshot plus dirty-buffer truth: a
   * result/no-match whose path is currently dirty projects to `stale` so the
   * old verdict never reads as current over edited content. Plain function (not
   * a memo) so callers — including tests outside a reactive root — always read
   * the latest projection.
   */
  function validationState(): ValidationState {
    const snap = validationSnapshot();
    if ((snap.state === "result" || snap.state === "no-match") && options.isDirty(snap.path)) {
      return { state: "stale", path: snap.path };
    }
    return snap;
  }

  /** Install a fresh snapshot for `relPath` from its content, with its disk identity. */
  function setFor(relPath: string, content: string, stamp: FileStamp | null = null): void {
    setValidationSnapshot(runValidation(relPath, content));
    validationStamp = stamp;
  }

  /** Clear the snapshot back to pending (close/delete of the validated file). */
  function clear(): void {
    setValidationSnapshot(pendingValidation);
    validationStamp = null;
  }

  /** Rekey the snapshot path after a rename/move; the underlying result is unchanged. */
  function rekey(oldPath: string, newPath: string): void {
    const snap = validationSnapshot();
    if (snap.state !== "pending" && snap.path === oldPath) {
      setValidationSnapshot({ ...snap, path: newPath } as ValidationState);
    }
  }

  /** Apply a frozen file-operation mutation to this owner's state. */
  function applyMutation(mutation: WorkspaceMutation): void {
    if (mutation.kind === "moved") {
      rekey(mutation.source, mutation.target);
      return;
    }
    if (mutation.kind === "deleted") {
      // A deleted file may own the validation snapshot even when it was never
      // opened (tree `v` validates the selection without opening it). Clear it
      // whenever the snapshot describes the deleted path, so a recreated file
      // at the same path — or an external rewrite — cannot inherit stale
      // findings (Issue #118 review round 2).
      const snap = validationSnapshot();
      if (snap.state !== "pending" && snap.path === mutation.path) clear();
    }
  }

  /**
   * Open the findings panel for a snapshot already current for `relPath`
   * (consume, no re-run). Returns false when the caller should bail. Reuse is
   * gated on the live file's disk identity still matching the snapshot's, so a
   * recreated or externally rewritten file at the same path does not inherit
   * stale findings (Issue #118 review round 2).
   */
  async function openFindingsForCurrent(relPath: string): Promise<boolean> {
    const snap = validationSnapshot();
    if ((snap.state === "result" || snap.state === "no-match") && snap.path === relPath && !options.isDirty(relPath)) {
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
    const relPath = options.selectedFilePath();
    if (!relPath) {
      onStatus("select a file to validate", "info");
      return;
    }
    if (options.isDirty(relPath)) {
      onStatus(`save ${relPath} before validating`, "info");
      return;
    }
    if (await openFindingsForCurrent(relPath)) return;
    const preview = await readFilePreview(rootDir, relPath);
    if (!preview) {
      onStatus(`${relPath} is not readable`, "error");
      return;
    }
    const stamp = await readFileStamp(rootDir, relPath);
    setFor(relPath, preview.lines?.join("\n") ?? "", stamp);
    setFindingsIndex(0);
    setFindingsOpen(true);
  }

  /**
   * Viewer-focus `v` targets the open file. Same dirty-buffer and consume
   * rules as the tree path; re-validates only when the snapshot is stale or
   * for a different file.
   */
  async function viewerValidate(): Promise<void> {
    const file = options.openFile();
    if (!file) { onStatus("open a file to validate", "info"); return; }
    if (options.isDirty(file.relPath)) {
      onStatus(`save ${file.relPath} before validating`, "info");
      return;
    }
    if (await openFindingsForCurrent(file.relPath)) return;
    const stamp = await readFileStamp(rootDir, file.relPath);
    setFor(file.relPath, file.lines?.join("\n") ?? "", stamp);
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
    const file = options.openFile();
    if (!file || !options.canEditOpenFile()) return false;
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
    const file = options.openFile();
    // Defence-in-depth alongside canJumpToSelectedFinding: never jump a finding
    // from another file's snapshot into the open buffer.
    const snap = validationSnapshot();
    if (!file || !options.canEditOpenFile() || finding.line === null) return;
    if (snap.state !== "pending" && snap.path !== file.relPath) return;
    setFindingsOpen(false);
    options.onJumpTo(file.relPath, finding.line);
  }

  return {
    // snapshot + findings state
    validationSnapshot,
    validationState,
    findingsOpen,
    findingsIndex,
    // installers
    setFor,
    clear,
    rekey,
    applyMutation,
    // triggering + navigation
    openFindingsForCurrent,
    treeValidate,
    viewerValidate,
    canJumpToSelectedFinding,
    handleFindingsKey,
  };
}

export type ValidationOwner = ReturnType<typeof createValidationOwner>;
