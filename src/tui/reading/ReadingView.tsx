import { For, Show } from "solid-js";
import { ThemedText } from "../theme-text";
import { palette } from "../theme";
import { truncateLine } from "../format";
import type { ReadingController } from "./controller";
import type { ReadingTone } from "./document";

/** A transparent hit-test shield also protects editors during compact reading. */
export function ReadingOverlay(props: { controller: ReadingController; width: number; height: number }) {
  return <box position="absolute" top={3} left={0} width={props.width} height={props.height} zIndex={80}
    onMouse={(event) => { event.preventDefault(); event.stopPropagation(); }}>
    <Show when={props.controller.expanded()} fallback={<box height={0} />}><ReadingView {...props} /></Show>
  </box>;
}

export function ReadingView(props: { controller: ReadingController; width: number; height: number }) {
  const reader = props.controller;
  const color = (tone: ReadingTone) => tone === "danger" ? palette.error
    : tone === "warning" ? palette.warn : tone === "muted" ? palette.textDim : palette.textPrimary;
  return (
    <box width={props.width} height={props.height} border borderColor={palette.gateBorder} paddingX={1} flexDirection="column" backgroundColor={palette.bg}>
      <box height={1} flexShrink={0}>
        <ThemedText content={truncateLine(reader.document()?.title ?? "Read", props.width - 4)} fg={palette.brand} attributes={1} wrapMode="none" />
      </box>
      <box height={reader.capacity()} flexShrink={0} flexDirection="column">
        <For each={reader.rows().slice(reader.start(), reader.start() + reader.capacity())}>
          {(row) => <box height={1} flexShrink={0}><ThemedText content={row.text || " "} fg={color(row.tone)} wrapMode="none" /></box>}
        </For>
      </box>
      <box height={1} flexShrink={0}>
        <ThemedText content={truncateLine(`Tab/Enter/Esc back · ↑/↓ scroll · Home/End · ${reader.start() + 1}-${Math.min(reader.rows().length, reader.start() + reader.capacity())}/${reader.rows().length}`, props.width - 4)} fg={palette.textDim} wrapMode="none" />
      </box>
    </box>
  );
}
