import { For, onCleanup, onMount } from "solid-js";
import type { BoxRenderable } from "@opentui/core";
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
  focused?: boolean;
};

export function PromptComposer(props: PromptComposerProps) {
  const renderer = useRenderer();
  let anchor: BoxRenderable | undefined;

  const focused = () => props.focused !== false;

  const lines = () => renderComposerLines(
    props.value,
    props.cursor,
    props.placeholder,
    Math.max(8, props.width),
    Math.max(1, props.maxLines),
  );

  const postProcess = () => {
    if (!focused() || !anchor) return;
    const contentWidth = Math.max(4, Math.max(8, props.width));
    const layout = layoutComposerText(
      props.value,
      Math.max(0, Math.min(props.value.length, props.cursor)),
      contentWidth,
      Math.max(1, props.maxLines),
    );
    const coords = composerCursorCoords(props.value, props.cursor, layout);
    const x = anchor.screenX + coords.col;
    const y = anchor.screenY + coords.row;
    renderer.setCursorPosition(x, y, true);
    renderer.setCursorStyle({ style: "line", blinking: true });
  };

  onMount(() => {
    renderer.addPostProcessFn(postProcess);
  });
  onCleanup(() => {
    renderer.removePostProcessFn(postProcess);
    renderer.setCursorStyle({ style: "default" });
  });

  return (
    <box ref={anchor} flexDirection="column" width="100%">
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
  if (value.length === 0) {
    return [{ text: clipToChars(placeholder, contentWidth), placeholder: true }];
  }

  const safeCursor = Math.max(0, Math.min(value.length, cursor));
  const layout = layoutComposerText(value, safeCursor, contentWidth, maxLines);
  const rendered = layout.visibleLines.map((line, index) => {
    const text = layout.hiddenBefore > 0 && index === 0
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
