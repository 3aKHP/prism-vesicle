import { createEffect, createMemo, For, onCleanup } from "solid-js";
import type { BoxRenderable, CliRenderer } from "@opentui/core";
import { useRenderer } from "@opentui/solid";
import { composerCursorCoords, layoutComposerText } from "./composer-layout";
import { displayWidth, segmentGraphemes } from "./format";
import { palette } from "./theme";

export type PromptComposerProps = {
  value: string;
  cursor: number;
  placeholder: string;
  width: number;
  maxLines: number;
  focused: boolean;
};

export function PromptComposer(props: PromptComposerProps) {
  const renderer = useRenderer();
  let anchor: BoxRenderable | undefined;
  let postProcessRegistered = false;
  let cursorStyleOwned = false;

  const focused = () => props.focused;

  const contentWidth = () => Math.max(8, props.width);
  const maxLines = () => Math.max(1, props.maxLines);
  const safeCursor = () => Math.max(0, Math.min(props.value.length, props.cursor));
  const layout = createMemo(() => layoutComposerText(
    props.value,
    safeCursor(),
    contentWidth(),
    maxLines(),
  ));
  const lines = createMemo(() => renderComposerLayout(props.value, props.placeholder, contentWidth(), layout()));

  const postProcess = () => {
    if (!focused() || !anchor) return;
    if (!cursorStyleOwned) {
      renderer.setCursorStyle({ style: "line", blinking: true });
      cursorStyleOwned = true;
    }
    const coords = composerCursorCoords(props.value, safeCursor(), layout());
    // Renderable screen coordinates are zero-based; the native cursor API is
    // one-based, matching OpenTUI's TextareaRenderable cursor implementation.
    const x = anchor.screenX + coords.col + 1;
    const y = anchor.screenY + coords.row + 1;
    renderer.setCursorPosition(x, y, true);
  };

  const setAnchor = (value: BoxRenderable) => {
    anchor = value;
    if (postProcessRegistered) return;
    renderer.addPostProcessFn(postProcess);
    postProcessRegistered = true;
    renderer.requestRender();
  };
  createEffect(() => {
    cursorStyleOwned = updateComposerCursorOwnership(renderer, focused());
  });
  onCleanup(() => {
    if (postProcessRegistered) renderer.removePostProcessFn(postProcess);
    renderer.setCursorPosition(0, 0, false);
    renderer.setCursorStyle({ style: "default" });
  });

  return (
    <box ref={setAnchor} flexDirection="column" width="100%">
      <For each={lines()}>
        {(line) => (
          <box height={1} flexDirection="row">
            <text
              content={line.text || " "}
              fg={line.placeholder ? palette.textDim : palette.textPrimary}
              wrapMode="none"
            />
          </box>
        )}
      </For>
    </box>
  );
}

type ComposerCursorRenderer = Pick<CliRenderer, "requestRender" | "setCursorPosition" | "setCursorStyle">;

export function updateComposerCursorOwnership(renderer: ComposerCursorRenderer, focused: boolean): boolean {
  if (focused) {
    renderer.setCursorStyle({ style: "line", blinking: true });
    renderer.requestRender();
    return true;
  }
  renderer.setCursorPosition(0, 0, false);
  renderer.setCursorStyle({ style: "default" });
  return false;
}

export type RenderedComposerLine = {
  text: string;
  placeholder?: boolean;
};

export function renderComposerLines(
  value: string,
  cursor: number,
  placeholder: string,
  width: number,
  maxLines: number,
): RenderedComposerLine[] {
  const contentWidth = Math.max(4, width);
  const safeCursor = Math.max(0, Math.min(value.length, cursor));
  const layout = layoutComposerText(value, safeCursor, contentWidth, maxLines);
  return renderComposerLayout(value, placeholder, contentWidth, layout);
}

function renderComposerLayout(
  value: string,
  placeholder: string,
  contentWidth: number,
  layout: ReturnType<typeof layoutComposerText>,
): RenderedComposerLine[] {
  if (value.length === 0) {
    return [{ text: clipToChars(placeholder, contentWidth), placeholder: true }];
  }

  const rendered = layout.visibleLines.map((line, index) => {
    const text = layout.hiddenBefore > 0
      && index === 0
      && layout.visibleStart !== layout.cursorLine
      ? withHiddenPrefix(line.text)
      : line.text;
    return { text: text || " " };
  });
  return rendered.length > 0 ? rendered : [{ text: " " }];
}

function clipToChars(value: string, width: number): string {
  const limit = Math.max(4, width);
  if (displayWidth(value) <= limit) return value;
  let prefix = "";
  let prefixWidth = 0;
  for (const grapheme of segmentGraphemes(value)) {
    const nextWidth = prefixWidth + displayWidth(grapheme);
    if (nextWidth > limit - 3) break;
    prefix += grapheme;
    prefixWidth = nextWidth;
  }
  return `${prefix}...`;
}

function withHiddenPrefix(value: string): string {
  const graphemes = segmentGraphemes(value);
  if (graphemes.length <= 2) return "⋯";
  return `⋯ ${graphemes.slice(2).join("")}`;
}
