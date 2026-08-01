/**
 * Compatibility re-export for the Workspace domain (W1). Callers still import
 * the public Workspace surface from this path; the thin facade lives in
 * `./workspace/index.ts`. Removed in W5 when all callers switch to the
 * workspace directory. The surface is intentionally limited to the exports the
 * original `workspace-controller.ts` shipped, so the W5 removal never breaks a
 * consumer that relied on this module.
 */
export { createWorkspaceController, resetStaleHorizontalScroll } from "./workspace";
export type {
  WorkspaceController,
  ShellPage,
  WorkspaceFocusRegion,
  ViewerScrollEdge,
  EditorStatusTone,
} from "./workspace";
