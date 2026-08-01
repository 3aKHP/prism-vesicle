/**
 * Workspace domain facade. This is the single public import point for the
 * Workspace page outside the domain: App, the page view, and tests import the
 * public surface from here; internal owners do not reach through each other's
 * state. The surface is the complete set of exports external consumers may
 * use; W5 removes the root compat module after callers switch to this path.
 */
export { createWorkspaceController, resetStaleHorizontalScroll } from "./controller";
export type { WorkspaceController } from "./controller";
export type {
  ShellPage,
  WorkspaceFocusRegion,
  ViewerScrollEdge,
  EditorStatusTone,
} from "./types";
export {
  classifyFile,
  OVERSIZED_BYTES,
  PREVIEW_LINE_CAP,
  scanDirectory,
  flattenVisibleTree,
  buildFileIndex,
  matchFiles,
  readFilePreview,
  statEntry,
} from "./tree-data";
export type {
  WorkspaceFileKind,
  WorkspaceTreeNode,
  WorkspaceVisibleRow,
  WorkspaceFilePreview,
} from "./tree-data";
export { assertProjectRelativePath } from "./paths";
