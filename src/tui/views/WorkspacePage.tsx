import { createEffect, createMemo, createSignal, For, onCleanup, onMount, Show } from "solid-js";
import { useRenderer } from "@opentui/solid";
import type { BoxRenderable, KeyBinding, ScrollBoxRenderable, TextareaRenderable } from "@opentui/core";
import { palette } from "../theme";
import { MarkdownContent } from "../widgets/MarkdownContent";
import type { WorkspaceController, EditorStatusTone } from "../workspace-controller";
import { resetStaleHorizontalScroll } from "../workspace-controller";
import type { WorkspaceFileKind } from "../workspace/tree-data";
import { pendingValidation, validationSeverity, validationSummary } from "../workspace-validate";
import type { ValidationState } from "../workspace-validate";
import { displayWidth, truncateMiddle } from "../format";
import {
  dialogStatus,
  editorStatus,
  findingsStatus,
  inputBarStatus,
  truncatePath,
  treeStatus,
  viewerStatus,
} from "../workspace-status";

/**
 * Workspace page (Scope B / #62): the project-file workbench — lazy file tree
 * on the left, viewer / editor on the right, quick-open over the page, and a
 * status line of key hints above the shell's bottom surface. The keyboard
 * focus model lives in the controller (F6 cycles tree → editor → composer,
 * Esc steps back); this component only renders controller state and wires the
 * viewer's scroll driver and the editor's textarea pool.
 *
 * B3 turns source mode into a real editor: one OpenTUI textarea per open file
 * is kept mounted (inactive ones `visible={false}`, which Yoga treats as
 * `display:none`) so per-file undo history survives buffer and preview↔source
 * switches. Markdown still renders through MarkdownContent in preview mode;
 * image, binary, symlink, and oversized files stay in the read-only viewer.
 */

const KIND_BADGES: Record<WorkspaceFileKind, string> = {
  markdown: "md",
  text: "text",
  image: "image",
  binary: "bin",
};

/**
 * Custom textarea key bindings. The default table maps undo to `ctrl+-` which
 * fails on legacy terminals (the 0x1F byte parses as `name:"_"`, not `"-"` —
 * spike finding), so we bind `ctrl+z` / `ctrl+y` explicitly and route the
 * legacy `ctrl+_` to undo as a fallback. Merge is override-by-name, so these
 * replace the broken defaults without touching the rest of the table.
 */
const EDITOR_KEY_BINDINGS: KeyBinding[] = [
  { name: "z", ctrl: true, action: "undo" },
  { name: "y", ctrl: true, action: "redo" },
  { name: "_", ctrl: true, action: "undo" },
];

/**
 * Keys that move the cursor to a different line and so can leave a stale
 * horizontal scroll offset (see `resetStaleHorizontalScroll` in the
 * controller). Printable keys are excluded — the textarea's own
 * scroll-while-typing is correct there.
 */
const NAVIGATION_KEYS = new Set([
  "up", "down", "left", "right", "home", "end", "pageup", "pagedown",
  "enter", "backspace", "delete",
]);

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

export function WorkspacePage(props: {
  controller: WorkspaceController;
  projectRoot: string;
  width: number;
  height: number;
  treeWidth: number;
  compact: boolean;
}) {
  const c = props.controller;

  // —— viewer scroll driver (same pattern as the side-question overlay) ——
  let scrollbox: ScrollBoxRenderable | undefined;
  const unregister = c.registerViewerScroller(
    (delta) => {
      const box = scrollbox;
      if (!box?.viewport) return;
      const max = Math.max(0, box.scrollHeight - box.viewport.height);
      const next = Math.max(0, Math.min(max, box.scrollTop + delta));
      box.scrollTo({ x: box.scrollLeft, y: next });
    },
    (edge) => {
      const box = scrollbox;
      if (!box) return;
      box.scrollTo({ x: box.scrollLeft, y: edge === "home" ? 0 : box.scrollHeight });
    },
  );
  onCleanup(unregister);

  // —— external editor handoff (B5): suspend the renderer so the editor owns
  // the tty, spawn it with inherited stdio, then resume. The controller drives
  // the orchestration; this just wires the real CliRenderer + Bun.spawn. ——
  const renderer = useRenderer();
  const unregisterEditor = c.registerExternalEditor({
    suspend: () => renderer.suspend(),
    resume: () => renderer.resume(),
    spawn: async (command, args) => {
      const child = Bun.spawn([command, ...args], { stdio: ["inherit", "inherit", "inherit"] });
      return await child.exited;
    },
  });
  onCleanup(unregisterEditor);

  createEffect(() => {
    c.openFile()?.relPath;
    scrollbox?.scrollTo({ x: 0, y: 0 });
  });

  // —— measured height: the page must fill the main row exactly. The shell's
  // bottom surface (composer / gate / picker) is dynamically sized, so an
  // explicit height prop would overflow into it; flex-stretch plus measuring
  // the tree box keeps the tree window slice inside the painted area. ——
  const [treeHeight, setTreeHeight] = createSignal(props.height);
  let treeBox: BoxRenderable | undefined;
  onMount(() => {
    const box = treeBox;
    if (!box) return;
    box.onSizeChange = () => setTreeHeight(box.height);
    setTreeHeight(box.height);
    onCleanup(() => { box.onSizeChange = undefined; });
  });

  // —— tree window: the visible slice follows the selection ——
  const treeViewport = createMemo(() => {
    const all = c.rows();
    const capacity = Math.max(1, treeHeight() - 2);
    const selected = c.selectedIndex();
    const start = Math.max(0, Math.min(selected - Math.floor(capacity / 2), all.length - capacity));
    return { rows: all.slice(start, start + capacity), offset: start };
  });

  const numberedSource = createMemo(() => {
    const file = c.openFile();
    if (!file?.lines) return "";
    const gutter = String(file.lines.length).length;
    return file.lines.map((line, index) => `${String(index + 1).padStart(gutter)}  ${line}`).join("\n");
  });

  const viewerTitle = createMemo(() => {
    const file = c.openFile();
    if (!file) return " No file ";
    const editing = c.isEditing();
    // Mode vocabulary (Issue #118 §5): editing = "source"; Markdown preview or
    // non-editable source = "preview"/"source view"; everything else = "viewer".
    // Disk restrictions stay explicit flags (RO/link/truncated) rather than a
    // blanket "read-only" that also names the viewing mode.
    const modeLabel = editing
      ? "source"
      : file.kind === "markdown"
        ? (c.viewMode() === "source" ? "source view" : "preview")
        : "viewer";
    const flags = [
      editing && c.dirtyPaths().has(file.relPath) ? "●" : null,
      c.externalChanged().has(file.relPath) ? "†disk" : null,
      !editing && file.readonly ? "RO" : null,
      !editing && file.symlink ? "link" : null,
      !editing && file.truncated ? "truncated" : null,
    ].filter(Boolean).join(" ");
    return ` ${file.relPath} · ${KIND_BADGES[file.kind]} · ${modeLabel}${flags ? ` · ${flags}` : ""} `;
  });

  const showTree = () => !props.compact || !(c.focusRegion() === "editor" && c.openFile());
  const showViewer = () => !props.compact || (c.focusRegion() === "editor" && c.openFile());

  /**
   * Validation state bound to a surface's target: the controller's projected
   * (stale-aware) state when the snapshot owns `target`, otherwise pending.
   * This is the single place that decides whether validation binds to the
   * current focus (Issue #118 §3/§5 — a tree selection never wears another
   * file's verdict, and neither does its colour). Reads the projected state so
   * a dirty owner — including a dirty non-card file — reads as `validation
   * stale` rather than the old verdict or nothing at all.
   */
  const boundValidationState = (target: string | null | undefined): ValidationState => {
    if (!target) return pendingValidation;
    const snap = c.validationSnapshot();
    if (snap.state === "pending" || snap.path !== target) return pendingValidation;
    return c.validationState();
  };

  /**
   * Validation summary text for the bound target. Only actual outcomes
   * (`result`/`stale`) surface inline; `no-match` is the default for non-card
   * files and is stated explicitly in the findings header on demand so it never
   * crowds the editor hints.
   */
  const validationTextFor = (target: string | null | undefined): string => {
    const s = boundValidationState(target);
    if (s.state === "pending" || s.state === "no-match") return "";
    return validationSummary(s);
  };

  const selectedRelPath = () => {
    const row = c.rows()[c.selectedIndex()];
    return row?.node.kind === "file" ? row.node.relPath : null;
  };

  /** Reachable Markdown mode-toggle hint, or "" (Issue #118 §4/§5). */
  const toggleHint = (): string => {
    const file = c.openFile();
    if (!file || file.kind !== "markdown" || !file.lines) return "";
    if (c.viewMode() === "preview") return c.canEditOpenFile() ? "m edit" : "m source";
    // Non-editable source view can step back to preview; editable source is the
    // editor region, which does not reach this hint.
    return c.canEditOpenFile() ? "" : "m preview";
  };

  const statusBudget = () => Math.max(8, props.width - 1);

  const statusLine = createMemo(() => {
    const budget = statusBudget();
    if (c.findingsOpen()) {
      return findingsStatus({ budget, canJump: c.canJumpToSelectedFinding() });
    }
    if (c.findActive()) {
      const count = c.findMatches().length;
      const idx = count > 0 ? c.findMatchIndex() + 1 : 0;
      return inputBarStatus({
        budget,
        label: "find:",
        draft: `${c.findQuery()}▌  ${idx}/${count}`,
        choices: "Enter next · Shift+Enter prev · Esc close",
      });
    }
    if (c.gotoActive()) {
      return inputBarStatus({
        budget,
        label: "goto line:",
        draft: `${c.gotoDraft() || " "}▌`,
        choices: "Enter jump · Esc close",
      });
    }
    if (c.saveAsActive()) {
      return inputBarStatus({
        budget,
        label: "save as:",
        draft: `${c.saveAsDraft() || " "}▌`,
        choices: "Enter save · Esc close",
      });
    }
    const ops = c.opsBar();
    if (ops) {
      const label = ops.kind === "create-file" ? "new file:"
        : ops.kind === "create-dir" ? "new dir:"
        : ops.kind === "move" ? `move ${ops.source} →:`
        : `copy ${ops.source} →:`;
      return inputBarStatus({
        budget,
        label,
        draft: `${ops.draft || " "}▌`,
        choices: "Enter confirm · Esc close",
      });
    }
    const d = c.dialog();
    if (d?.kind === "dirty-confirm") {
      return dialogStatus({ budget, lead: `${d.path} has unsaved edits`, choices: "y save · n discard · Esc cancel" });
    }
    if (d?.kind === "overwrite-confirm") {
      return dialogStatus({ budget, lead: `${d.path} changed on disk`, choices: "o overwrite · s save as · c cancel" });
    }
    if (d?.kind === "reload-confirm") {
      return dialogStatus({ budget, lead: `reload ${d.path}? local edits lost`, choices: "y reload · n cancel" });
    }
    if (d?.kind === "delete-confirm") {
      const dirty = c.dirtyPaths().has(d.path);
      return dialogStatus({
        budget,
        lead: `delete ${d.path}?${dirty ? " (has unsaved edits)" : ""}`,
        choices: "y delete (to trash) · any other key cancels",
      });
    }
    if (d?.kind === "ops-overwrite" || d?.kind === "save-as-overwrite") {
      return dialogStatus({ budget, lead: `${d.path} exists`, choices: "o overwrite · c cancel" });
    }
    const region = c.focusRegion();
    if (region === "tree") {
      return treeStatus({
        budget,
        selectedIsFile: selectedRelPath() !== null,
        validation: validationTextFor(selectedRelPath()),
        note: c.editorStatus(),
      });
    }
    const file = c.openFile();
    if (region === "editor" && file) {
      if (c.isEditing()) {
        return editorStatus({
          budget,
          target: file.relPath,
          dirtyMark: c.dirtyPaths().has(file.relPath) ? "●" : "",
          diskMark: c.externalChanged().has(file.relPath) ? "†disk" : "",
          cursor: `Ln ${c.cursorLn() + 1}:${c.cursorCol() + 1}`,
          validation: validationTextFor(file.relPath),
          note: c.editorStatus(),
        });
      }
      const flags = [
        file.readonly ? "RO" : null,
        file.symlink ? "link" : null,
        file.truncated ? "truncated" : null,
      ].filter(Boolean).join(" ");
      const modeLabel = file.kind === "markdown"
        ? (c.viewMode() === "source" ? "source view" : "preview")
        : "viewer";
      const vText = validationTextFor(file.relPath);
      // `v findings` is reachable only when there is a current (non-stale,
      // non-no-match) result AND the buffer is clean — viewerValidate refuses a
      // dirty target, so advertising otherwise is a dead affordance.
      const dirty = c.dirtyPaths().has(file.relPath);
      return viewerStatus({
        budget,
        target: file.relPath,
        mode: modeLabel,
        flags,
        validation: vText,
        toggleHint: toggleHint(),
        canViewFindings: Boolean(vText) && !dirty,
        note: c.editorStatus(),
      });
    }
    return "";
  });

  /**
   * Colour tone for the status line. Input bars (find/goto/save-as/ops) and the
   * findings panel stay muted — they are prompts, not alerts. The confirm
   * dialogs (data-loss or destructive) and disk-change notices escalate to
   * amber; validation errors go red, warnings amber, a clean pass emerald.
   * Warn/error also render bold so a "delete?" or "✗ 2" actually reads.
   */
  const statusTone = createMemo<EditorStatusTone>(() => {
    if (c.findingsOpen() || c.findActive() || c.gotoActive() || c.saveAsActive() || c.opsBar()) return "info";
    if (c.dialog()) return "warn";
    if (c.externalChanged().size > 0) return "warn";
    // Severity binds to the focused target, matching the path-bound text above
    // (Issue #118 §5 review): navigating the tree away from the validated file
    // no longer paints the row red/green for a verdict the row does not show.
    const region = c.focusRegion();
    const target = region === "tree" ? selectedRelPath() : c.openFile()?.relPath ?? null;
    switch (validationSeverity(boundValidationState(target))) {
      case 2: return "error";
      case 1: return "warn";
      case 0: return "success";
      default: break;
    }
    return c.editorStatusTone();
  });
  const statusFg = createMemo(() => {
    switch (statusTone()) {
      case "error": return palette.error;
      case "warn": return palette.warn;
      case "success": return palette.success;
      default: return palette.textMuted;
    }
  });
  const statusBold = () => statusTone() === "warn" || statusTone() === "error";

  return (
    <box flexDirection="column" flexGrow={1} width="100%">
      <box flexDirection="row" flexGrow={1} width="100%">
        {/* —— file tree —— */}
        <Show when={showTree()} fallback={<box width={0} />}>
          <box
            ref={treeBox}
            title={c.loading() ? " Files · loading… " : " Files "}
            border
            borderColor={c.focusRegion() === "tree" ? palette.brand : palette.panelBorder}
            width={props.compact ? props.width : props.treeWidth}
            flexDirection="column"
          >
            <For each={treeViewport().rows}>
              {(row, index) => {
                const isSelected = () => treeViewport().offset + index() === c.selectedIndex();
                const marker = () =>
                  row.node.kind === "dir" ? (row.expanded ? "▾ " : "▸ ") : "  ";
                const suffix = () =>
                  [row.node.symlink ? "@" : null, row.node.readonly ? "RO" : null]
                    .filter(Boolean)
                    .join(" ");
                return (
                  <text
                    content={`${"  ".repeat(row.depth)}${marker()}${row.node.name}${suffix() ? ` ${suffix()}` : ""}`}
                    fg={
                      isSelected()
                        ? (c.focusRegion() === "tree" ? palette.brand : palette.textPrimary)
                        : row.node.kind === "dir"
                          ? palette.textSecondary
                          : palette.textPrimary
                    }
                    attributes={isSelected() ? 1 : 0}
                    wrapMode="none"
                  />
                );
              }}
            </For>
            <Show when={!c.loading() && c.rows().length === 0} fallback={<box height={0} />}>
              <text content="(empty project)" fg={palette.textDim} wrapMode="none" />
            </Show>
          </box>
        </Show>

        {/* —— viewer / editor —— */}
        <Show when={showViewer()} fallback={<box width={0} />}>
          <box
            title={viewerTitle()}
            border
            borderColor={c.focusRegion() === "editor" ? palette.brand : palette.panelBorder}
            flexGrow={1}
            flexDirection="column"
          >
            {/* Editable pool: one textarea per open buffer, kept mounted so
                per-file undo survives switches. Inactive buffers are
                display:none; only the active editable source is shown. */}
            <For each={c.editorOrder()}>
              {(relPath) => (
                <EditorBuffer
                  controller={c}
                  relPath={relPath}
                  active={() => relPath === c.activeEditorPath() && c.isEditing()}
                  focused={() => relPath === c.activeEditorPath() && c.focusRegion() === "editor" && c.isEditing()}
                />
              )}
            </For>

            <Show when={c.openFile()} fallback={
              <box flexGrow={1} alignItems="center" justifyContent="center">
                <text
                  content="No file open — Enter opens the selection, Ctrl+P quick open"
                  fg={palette.textDim}
                  wrapMode="none"
                />
              </box>
            }>
              {(file) => (
                <Show when={!c.isEditing()} fallback={<box width={0} height={0} />}>
                  <Show
                    when={file().lines}
                    fallback={
                      <box flexDirection="column" padding={1} gap={1}>
                        <text content={`${KIND_BADGES[file().kind]} file · ${formatSize(file().size)}`} fg={palette.textSecondary} wrapMode="none" />
                        <Show when={file().symlink} fallback={<box height={0} />}>
                          <text content="symbolic link" fg={palette.warn} wrapMode="none" />
                        </Show>
                        <Show when={file().readonly} fallback={<box height={0} />}>
                          <text content="read-only" fg={palette.warn} wrapMode="none" />
                        </Show>
                        <text
                          content={file().kind === "image"
                            ? "Image preview is not inline-renderable in the terminal; press Ctrl+X to open in your external editor."
                            : file().symlink
                              ? "Symbolic-link targets are not loaded; press Ctrl+X to open in your external editor."
                            : "Binary file — editing is not supported; press Ctrl+X to open in your external editor."}
                          fg={palette.textDim}
                          wrapMode="none"
                        />
                      </box>
                    }
                  >
                    <scrollbox ref={scrollbox} width="100%" flexGrow={1}>
                      <box flexDirection="column" width="100%">
                        <Show
                          when={file().kind === "markdown" && c.viewMode() === "preview"}
                          fallback={<text content={numberedSource()} fg={palette.textPrimary} wrapMode="none" />}
                        >
                          <MarkdownContent content={file().lines?.join("\n") ?? ""} />
                        </Show>
                      </box>
                    </scrollbox>
                  </Show>
                </Show>
              )}
            </Show>
          </box>
        </Show>

        {/* —— quick open —— */}
        <Show when={c.quickOpenActive()} fallback={<box width={0} height={0} />}>
          <box
            position="absolute"
            left={Math.max(0, Math.floor((props.width - quickOpenWidth(props.width)) / 2))}
            top={1}
            width={quickOpenWidth(props.width)}
            border
            borderColor={palette.brand}
            backgroundColor={palette.bg}
            flexDirection="column"
            paddingX={1}
          >
            <text content={`Open file: ${c.quickQuery()}▌`} fg={palette.textPrimary} wrapMode="none" />
            <For each={c.quickMatches().slice(0, 10)}>
              {(path, index) => (
                <text
                  content={path}
                  fg={index() === c.quickIndex() ? palette.brand : palette.textSecondary}
                  attributes={index() === c.quickIndex() ? 1 : 0}
                  wrapMode="none"
                />
              )}
            </For>
            <Show when={c.quickMatches().length === 0} fallback={<box height={0} />}>
              <text content="(no matches)" fg={palette.textDim} wrapMode="none" />
            </Show>
            <text content="↑↓ select · Enter open · Esc close" fg={palette.textDim} wrapMode="none" />
          </box>
        </Show>

        {/* —— validation findings panel (B4 §5.2) —— */}
        <Show when={c.findingsOpen()} fallback={<box width={0} height={0} />}>
          <box
            position="absolute"
            left={Math.max(0, Math.floor((props.width - quickOpenWidth(props.width)) / 2))}
            top={1}
            width={quickOpenWidth(props.width)}
            border
            borderColor={palette.brand}
            backgroundColor={palette.bg}
            flexDirection="column"
            paddingX={1}
          >
            <FindingsHeader state={c.validationState()} width={quickOpenWidth(props.width)} />
            <For each={findingsList(c.validationState())}>
              {(finding, index) => (
                <text
                  content={`${finding.severity === "error" ? "✗" : "⚠"} ${finding.text}${finding.anchored ? "" : "  (no anchor)"}`}
                  fg={index() === c.findingsIndex() ? palette.brand : finding.severity === "error" ? palette.error : palette.warn}
                  attributes={index() === c.findingsIndex() ? 1 : 0}
                  wrapMode="none"
                />
              )}
            </For>
            <Show when={findingsList(c.validationState()).length === 0} fallback={<box height={0} />}>
              <text content="(nothing to report)" fg={palette.textDim} wrapMode="none" />
            </Show>
            <text
              content={findingsStatus({ budget: Math.max(8, quickOpenWidth(props.width) - 4), canJump: c.canJumpToSelectedFinding() })}
              fg={palette.textDim}
              wrapMode="none"
            />
          </box>
        </Show>
      </box>

      {/* —— editor status line (D5 low-band hint bar) —— */}
      <box height={1} paddingLeft={1}>
        <text
          content={statusLine()}
          fg={statusFg()}
          attributes={statusBold() ? 1 : 0}
          wrapMode="none"
        />
      </box>
    </box>
  );
}

/**
 * One mounted textarea per open editable buffer. The instance registers itself
 * with the controller on mount (so save/find/goto can drive it imperatively)
 * and unregisters on cleanup. Tab inserts two spaces — the textarea's action
 * set has no "insert tab", so the only way is to intercept it here before the
 * default key handler would move focus.
 */
function EditorBuffer(props: {
  controller: WorkspaceController;
  relPath: string;
  active: () => boolean;
  focused: () => boolean;
}) {
  const c = props.controller;
  let ta: TextareaRenderable | undefined;
  onCleanup(() => {
    if (ta) c.unregisterEditorInstance(props.relPath);
  });
  // Hidden→visible viewport re-sync. Pool instances mount with
  // `visible={false}` (Yoga display:none → width clamped to 1, and onResize
  // is skipped while invisible), so the EditorView keeps its constructor
  // fallback width (80). OpenTUI does not reliably re-fire onResize when the
  // node is shown again, which leaves soft-wrap computed against the stale
  // width — wraps land in the wrong places. Re-sync once the node has been
  // laid out again (deferred past the visibility change).
  createEffect(() => {
    if (!props.active()) return;
    const ed = ta;
    if (!ed) return;
    setTimeout(() => {
      if (!ed.isDestroyed && ed.width > 1) ed.editorView.setViewportSize(ed.width, ed.height);
    }, 0);
  });
  return (
    <box width="100%" flexGrow={1} flexDirection="row" visible={props.active()}>
      <line_number fg={palette.textDim} minWidth={4} paddingRight={1}>
        <textarea
          ref={(r: TextareaRenderable) => {
            ta = r;
            c.registerEditorInstance(props.relPath, r);
          }}
          initialValue={c.editorInitialContent(props.relPath)}
          focused={props.focused()}
          width="100%"
          height="100%"
          // Soft wrap (VSCode-style): long lines continue on the next visual
          // row and the gutter stays blank there — no horizontal scrolling at
          // all. (The textarea's default scroll margin also starts horizontal
          // scroll ~20% before the right edge under wrapMode="none", which is
          // why the old build felt like it scrolled at three-quarter width.)
          wrapMode="word"
          keyBindings={EDITOR_KEY_BINDINGS}
          onKeyDown={(e) => {
            if (e.name === "tab" && !e.shift) {
              ta?.insertText("  ");
              e.preventDefault();
              return;
            }
            // Defer the horizontal-scroll reset past the textarea's own key
            // handling (onKeyDown fires before handleKeyPress moves the cursor).
            if (ta && NAVIGATION_KEYS.has(e.name ?? "")) {
              const ed = ta;
              setTimeout(() => resetStaleHorizontalScroll(ed), 0);
            }
          }}
          onContentChange={() => c.markEditorContentChanged(props.relPath)}
          onCursorChange={(event) => c.reportCursor(event.line, event.visualColumn)}
        />
      </line_number>
    </box>
  );
}

function quickOpenWidth(pageWidth: number): number {
  return Math.max(30, Math.min(72, Math.floor(pageWidth * 0.6)));
}

function findingsList(state: import("../workspace-validate").ValidationState): import("../workspace-validate").LocatedFinding[] {
  return state.state === "result" ? state.findings : [];
}

/**
 * Findings panel header. Identifies the target file by a bounded path and
 * states the pure summary — never an action token like `v view` (Issue #118
 * §1/§5). The panel is already open, so the header must not tell the user to
 * open it again. The path is middle-truncated to the real content width minus
 * the `findings: `/` — ` chrome and the summary, so a long or CJK path can
 * never clip the verdict (Issue #118 §8).
 */
function FindingsHeader(props: { state: import("../workspace-validate").ValidationState; width: number }) {
  const content = () => {
    const s = props.state;
    const summary = validationSummary(s) || "—";
    const summaryW = displayWidth(summary);
    // Panel content width: full width minus border (2) and paddingX (2).
    const contentWidth = Math.max(8, props.width - 4);
    const lead = displayWidth("findings: ");
    if (s.state === "pending") return `findings: ${summary}`;
    const sep = displayWidth(" — ");
    const pathBudget = contentWidth - lead - sep - summaryW;
    // If the path cannot fit at all (very narrow panel), drop it rather than
    // overflow; the summary still identifies the outcome.
    const path = pathBudget >= 8 ? truncatePath(s.path, pathBudget) : "";
    const full = path ? `findings: ${path} — ${summary}` : `findings: ${summary}`;
    // A long summary ("no validator matched", "✓ validators passed") can still
    // exceed a narrow panel once the path is dropped — middle-truncate the
    // composed line so the header never overflows its box (Issue #118 §8).
    return displayWidth(full) <= contentWidth ? full : truncateMiddle(full, contentWidth);
  };
  return <text content={content()} fg={palette.textPrimary} wrapMode="none" />;
}
