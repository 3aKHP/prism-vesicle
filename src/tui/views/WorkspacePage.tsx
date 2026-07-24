import { createEffect, createMemo, For, onCleanup, Show } from "solid-js";
import type { ScrollBoxRenderable } from "@opentui/core";
import { palette } from "../theme";
import { MarkdownContent } from "../widgets/MarkdownContent";
import type { WorkspaceController } from "../workspace-controller";
import type { WorkspaceFileKind } from "../workspace-files";

/**
 * Workspace page (Scope B / #62, milestone B2): the project-file workbench —
 * lazy file tree on the left, read-only viewer on the right, and a quick-open
 * panel over the page. The keyboard focus model lives in the controller
 * (F6 cycles tree → editor → composer, Esc steps back); this component only
 * renders controller state and registers the viewer's scroll driver.
 *
 * The viewer is read-only in B2: markdown renders Source/Preview (`m`
 * toggles), other text shows numbered lines, image/binary files show
 * metadata until the external-editor handoff (B5). Editing arrives in B3.
 */

const KIND_BADGES: Record<WorkspaceFileKind, string> = {
  markdown: "md",
  text: "text",
  image: "image",
  binary: "bin",
};

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
  createEffect(() => {
    c.openFile()?.relPath;
    scrollbox?.scrollTo({ x: 0, y: 0 });
  });

  // —— tree window: the visible slice follows the selection ——
  const treeViewport = createMemo(() => {
    const all = c.rows();
    const capacity = Math.max(1, props.height - 2);
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
    const mode = file.kind === "markdown" ? ` · ${c.viewMode()}` : "";
    const flags = [
      file.readonly ? "RO" : null,
      file.symlink ? "link" : null,
      file.truncated ? "truncated" : null,
    ].filter(Boolean).join(" ");
    return ` ${file.relPath} · ${KIND_BADGES[file.kind]}${mode}${flags ? ` · ${flags}` : ""} `;
  });

  const showTree = () => !props.compact || !(c.focusRegion() === "editor" && c.openFile());
  const showViewer = () => !props.compact || (c.focusRegion() === "editor" && c.openFile());

  return (
    <box flexDirection="row" width={props.width} height={props.height}>
      {/* —— file tree —— */}
      <Show when={showTree()} fallback={<box width={0} />}>
        <box
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

      {/* —— viewer —— */}
      <Show when={showViewer()} fallback={<box width={0} />}>
        <box
          title={viewerTitle()}
          border
          borderColor={c.focusRegion() === "editor" ? palette.brand : palette.panelBorder}
          flexGrow={1}
          flexDirection="column"
        >
          <Show
            when={c.openFile()}
            fallback={
              <box flexGrow={1} alignItems="center" justifyContent="center">
                <text
                  content="No file open — Enter opens the selection, Ctrl+P quick open"
                  fg={palette.textDim}
                  wrapMode="none"
                />
              </box>
            }
          >
            {(file) => (
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
                        ? "Image preview is not inline-renderable in the terminal; external editor handoff arrives in B5."
                        : "Binary file — editing is not supported; external editor handoff arrives in B5."}
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
    </box>
  );
}

function quickOpenWidth(pageWidth: number): number {
  return Math.max(30, Math.min(72, Math.floor(pageWidth * 0.6)));
}
