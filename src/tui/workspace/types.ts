/**
 * Types shared across two or more Workspace domain owners. Owner-local types
 * live beside the owner that owns them; anything here is consumed by at least
 * two Workspace modules (controller composition, buffer/validation owners, the
 * page view, or tests).
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

/**
 * A frozen file-operation result. The file-operation owner returns one of
 * these for every successful mutation; the facade applies it to the owners in
 * the fixed tree → buffer → validation order, so no owner interprets a
 * mutation by reaching into another owner's state.
 */
export type WorkspaceMutation =
  | { kind: "created"; path: string; entryType: "file" | "directory" }
  | { kind: "copied"; source: string; target: string }
  | { kind: "moved"; source: string; target: string }
  | { kind: "deleted"; path: string };
