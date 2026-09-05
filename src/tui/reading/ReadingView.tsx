import { createEffect, For, onCleanup, Show } from "solid-js";
import { type ScrollBoxRenderable, TextAttributes } from "@3akhp/opentui-core";
import { useRenderer } from "@3akhp/opentui-solid";
import { ThemedText } from "../theme-text";
import { palette } from "../theme";
import { truncateLine } from "../format";
import type { ReadingController } from "./controller";
import { readingText, type ReadingTone } from "./document";
import { MarkdownContent } from "../widgets/MarkdownContent";
import { renderedReadingRows } from "./layout";

/** A transparent hit-test shield also protects editors during compact reading. */
export function ReadingOverlay(props: { controller: ReadingController; width: number; height: number }) {
  return <box position="absolute" top={3} left={0} width={props.width} height={props.height} zIndex={80}
    onMouse={(event) => { event.preventDefault(); event.stopPropagation(); }}>
    <Show when={props.controller.expanded()} fallback={<box height={0} />}><ReadingView {...props} /></Show>
  </box>;
}

export function ReadingView(props: { controller: ReadingController; width: number; height: number }) {
  const reader = props.controller;
  const renderer = useRenderer();
  let scrollbox: ScrollBoxRenderable | undefined;
  const color = (tone: ReadingTone) => tone === "danger" ? palette.error
    : tone === "warning" ? palette.warn : tone === "muted" ? palette.textDim : tone === "title" ? palette.brand : palette.textPrimary;
  const syncLayout = () => {
    const document = reader.document();
    if (!scrollbox || !document) return;
    reader.updateLayout(document, props.width, renderedReadingRows(scrollbox.content));
    scrollbox.scrollTo(reader.start());
  };
  renderer.addPostProcessFn(syncLayout);
  onCleanup(() => renderer.removePostProcessFn(syncLayout));
  createEffect(() => { scrollbox?.scrollTo(reader.start()); });
  return (
    <box width={props.width} height={props.height} border borderColor={palette.gateBorder} paddingX={1} flexDirection="column" backgroundColor={palette.bg}
      onMouseScroll={() => {
        // Wheel events bubble here after the native scrollbox applies its delta.
        // Save that position before the next frame restores the reading anchor.
        if (scrollbox) reader.scrollTo(scrollbox.scrollTop);
      }}>
      <scrollbox ref={(value: ScrollBoxRenderable) => { scrollbox = value; }} height={reader.capacity()} flexShrink={0}
        scrollX={false} scrollY={true} scrollbarOptions={{ visible: false }} viewportCulling={false}>
        <For each={reader.document()?.blocks}>
          {(block) => <box flexDirection="column" flexShrink={0} width="100%">
            <Show when={block.format === "markdown"} fallback={
              <ThemedText content={readingText(block.text) || " "} fg={color(block.tone ?? "normal")}
                attributes={block.tone === "title" ? TextAttributes.BOLD : TextAttributes.NONE} wrapMode="char" />
            }>
              <MarkdownContent content={readingText(block.text)} />
            </Show>
          </box>}
        </For>
      </scrollbox>
      <box height={1} flexShrink={0}>
        <ThemedText content={truncateLine(`Tab/Enter/Esc back · ↑/↓ scroll · Home/End · ${reader.start() + 1}-${Math.min(reader.rows().length, reader.start() + reader.capacity())}/${reader.rows().length}`, props.width - 4)} fg={palette.textDim} wrapMode="none" />
      </box>
    </box>
  );
}
