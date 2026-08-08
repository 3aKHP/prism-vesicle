import type { TuiKeyEvent } from "../decision-interaction";

/**
 * Workspace keyboard routing (Scope B / #62). Owns ONLY the input priority:
 * quick-open → findings → dialog → ops bar → find → goto → save-as → global
 * Workspace keys → focused region. Each step delegates to a surface handler
 * wired by the facade; no file I/O, mutation, validation, or external-process
 * algorithm lives here.
 *
 * The global paste rule stays outside this router: it lives in the host
 * `input-routing.ts`, which consults the workspace controller's
 * `editableSourcePasteActive()` predicate so an unobscured editable textarea
 * receives bracketed paste directly.
 */

export type InputSurface = {
  /** Whether the surface currently owns keyboard input. */
  active: () => boolean;
  /** Route the key to the surface; true when consumed. */
  handle: (key: TuiKeyEvent) => boolean;
};

export type WorkspaceRouterPorts = {
  /** Keys only reach the router while the Workspace page is active. */
  pageIsWorkspace: () => boolean;
  /** Dialog actions awaiting filesystem I/O own all input. */
  dialogActionPending: () => boolean;
  quickOpen: InputSurface;
  findings: InputSurface;
  dialog: InputSurface;
  opsBar: InputSurface;
  find: InputSurface;
  goto: InputSurface;
  saveAs: InputSurface;
  /** Global Workspace keys (Ctrl+P / Ctrl+X / F6); true when consumed. */
  globalKeys: (key: TuiKeyEvent) => boolean;
  /** Focus-region dispatch (tree / viewer / editable / composer); true when consumed. */
  regionKeys: (key: TuiKeyEvent) => boolean;
};

/** Returns true when the key was consumed by the Workspace page. */
export function routeWorkspaceKey(key: TuiKeyEvent, ports: WorkspaceRouterPorts): boolean {
  if (!ports.pageIsWorkspace()) return false;
  if (ports.dialogActionPending()) return true;
  if (ports.quickOpen.active()) return ports.quickOpen.handle(key);
  if (ports.findings.active()) return ports.findings.handle(key);
  if (ports.dialog.active()) return ports.dialog.handle(key);
  if (ports.opsBar.active()) return ports.opsBar.handle(key);
  if (ports.find.active()) return ports.find.handle(key);
  if (ports.goto.active()) return ports.goto.handle(key);
  if (ports.saveAs.active()) return ports.saveAs.handle(key);
  if (ports.globalKeys(key)) return true;
  return ports.regionKeys(key);
}
