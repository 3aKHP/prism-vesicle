import { createSignal } from "solid-js";

/**
 * Shell page state for the two-page model (Scope B / #62): the chat surface
 * and the Workspace page are the two top-level pages. Page state lives in a
 * controller outside the component tree so switching pages never loses the
 * workspace's context — the selected tree node, open files, cursor, and
 * scroll arrive in B2/B3 and hang off this controller; B1 ships the page
 * skeleton and reserves the focus-region slot.
 *
 * Purely transient TUI state: never written to session JSONL, checkpoints,
 * or rewind records.
 */
export type ShellPage = "chat" | "workspace";

/** Region focus inside the Workspace page; consumed from B2 (file tree). */
export type WorkspaceFocusRegion = "tree" | "editor";

export function createWorkspaceController() {
  const [page, setPage] = createSignal<ShellPage>("chat");
  const [focusRegion, setFocusRegion] = createSignal<WorkspaceFocusRegion>("tree");

  function togglePage(): void {
    setPage((current) => (current === "chat" ? "workspace" : "chat"));
  }

  return {
    activePage: page,
    setActivePage: setPage,
    togglePage,
    focusRegion,
    setFocusRegion,
  };
}

export type WorkspaceController = ReturnType<typeof createWorkspaceController>;
