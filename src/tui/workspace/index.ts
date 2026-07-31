/**
 * Workspace domain facade. This is the only cross-owner public wiring layer
 * for the Workspace page besides `controller.ts` and `types.ts`: App, the page
 * view, and tests import the public surface from here; internal owners do not
 * reach through each other's state.
 */
export { createWorkspaceController, resetStaleHorizontalScroll } from "./controller";
export type { WorkspaceController } from "./controller";
export type {
  ShellPage,
  WorkspaceFocusRegion,
  ViewerScrollEdge,
  EditorStatusTone,
} from "./types";
export type {
  WorkspaceFileKind,
  WorkspaceTreeNode,
  WorkspaceVisibleRow,
  WorkspaceFilePreview,
} from "./tree-data";
export { classifyFile, OVERSIZED_BYTES, PREVIEW_LINE_CAP } from "./tree-data";
