/**
 * Workspace domain facade — the single public import point for the Workspace
 * page outside the domain. App and the cross-domain tests import the
 * controller factory from here; internal owners, the page view, and
 * domain-focused tests import their target modules directly. Only the
 * consumed surface is re-exported: adding an export here is a public-surface
 * decision, not an automatic barrel.
 */
export { createWorkspaceController } from "./controller";
export { resetStaleHorizontalScroll } from "./buffer-owner";
export type { WorkspaceController } from "./controller";
export type { EditorStatusTone } from "./types";
