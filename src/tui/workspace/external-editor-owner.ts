import { loadSettings, type Settings } from "../../config/settings";
import { assertProjectRelativePath } from "./paths";
import { statEntry } from "./tree-data";
import type { ExternalEditOutcome } from "./buffer-owner";
import {
  resolveEditorCommand,
  runExternalEditor,
  type EditorRuntime,
} from "./external-editor-runtime";
import type { EditorStatusTone } from "./types";

/**
 * Workspace external-editor owner (Scope B / #62, milestone B5 §6). Owns the
 * Ctrl+X handoff use case: target handoff, dirty gate, renderer suspend /
 * spawn / resume through the injected runtime, and the return reconciliation
 * that distinguishes unchanged / modified / removed / unreadable / non-
 * resident outcomes.
 *
 * Boundary: the owner never holds the Workspace controller or another owner's
 * signals. It requests state through narrow BufferPort / TreePort / ViewerPort
 * objects wired by the facade, and reports status through `onStatus`.
 */

export type ExternalBufferPort = {
  /** Whether the path has an unsaved buffer (dirty gate). */
  isDirty: (path: string) => boolean;
  /** Reconcile a resident buffer after the editor returned. */
  reconcile: (path: string) => Promise<ExternalEditOutcome>;
};

export type ExternalTreePort = {
  /** Drop the scan-cache entries for a path's ancestors. */
  invalidateCache: (relPath: string) => void;
  /** Rebuild tree rows + quick-open index. */
  refreshRowsAndIndex: () => Promise<void>;
};

export type ExternalViewerPort = {
  /** Re-read the preview if the viewer is showing this path. */
  reloadIfShowing: (relPath: string) => Promise<void>;
  /** Close the viewer (and return focus to the tree) if it shows this path. */
  closeIfShowing: (relPath: string) => void;
};

export type ExternalEditorOwnerPorts = {
  rootDir: string;
  /** Status-line write (facade owns the line). */
  onStatus: (text: string, tone?: EditorStatusTone) => void;
  /** Resolve the Ctrl+X target by focus region (page state lives in the facade). */
  resolveHandoffTarget: () => string | null;
  buffer: ExternalBufferPort;
  tree: ExternalTreePort;
  viewer: ExternalViewerPort;
};

function errMsg(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function createExternalEditorOwner(options: ExternalEditorOwnerPorts) {
  const { rootDir, onStatus } = options;

  /** Renderer + spawn primitives, injected by the component (see WorkspacePage). */
  let externalEditorRuntime: EditorRuntime | null = null;
  function registerExternalEditor(runtime: EditorRuntime): () => void {
    externalEditorRuntime = runtime;
    return () => { externalEditorRuntime = null; };
  }

  async function handoffToExternal(): Promise<void> {
    const target = options.resolveHandoffTarget();
    if (!target) return;
    let abs: string;
    try {
      abs = assertProjectRelativePath(rootDir, target);
    } catch (error) {
      onStatus(errMsg(error), "error");
      return;
    }
    const stat = await statEntry(rootDir, target);
    if (stat?.kind === "dir") { onStatus(`${target} is a directory`, "error"); return; }
    // dirty gate (plan §6.1): an unsaved buffer would be silently overwritten
    // by whatever the external editor writes, so refuse and point at Ctrl+S.
    if (options.buffer.isDirty(target)) {
      onStatus(`${target} has unsaved edits — press Ctrl+S before the external editor`, "error");
      return;
    }
    const runtime = externalEditorRuntime;
    if (!runtime) { onStatus("external editor is unavailable in this build", "error"); return; }

    let settings: Settings;
    try {
      settings = await loadSettings();
    } catch (error) {
      onStatus(`settings.yaml is malformed — ${errMsg(error)} (fix or remove it)`, "error");
      return;
    }
    const editor = resolveEditorCommand({ env: process.env, settings });
    onStatus(`opening ${target} in ${editor.command}…`, "info");
    let exitCode = 0;
    try {
      const result = await runExternalEditor({ absPath: abs, editor, runtime });
      exitCode = result.exitCode;
    } catch (error) {
      onStatus(`editor "${editor.command}" failed to start — ${errMsg(error)}`, "error");
      return;
    }
    if (exitCode !== 0) onStatus(`editor exited with code ${exitCode}`, "warn");
    await refreshAfterExternalEdit(target);
  }

  /**
   * React to whatever the external editor did. A resident buffer is reconciled
   * by the buffer port (unchanged / modified / removed / unreadable, with
   * status + revalidation inside the buffer owner); a non-resident file just
   * has its tree cache + index invalidated and the viewer re-read when it was
   * showing the file.
   */
  async function refreshAfterExternalEdit(relPath: string): Promise<void> {
    const outcome = await options.buffer.reconcile(relPath);
    if (outcome === "not-resident") {
      options.tree.invalidateCache(relPath);
      await options.tree.refreshRowsAndIndex();
      await options.viewer.reloadIfShowing(relPath);
      return;
    }
    if (outcome === "removed") {
      options.viewer.closeIfShowing(relPath);
    }
  }

  return {
    registerExternalEditor,
    handoffToExternal,
    refreshAfterExternalEdit,
  };
}

export type ExternalEditorOwner = ReturnType<typeof createExternalEditorOwner>;
