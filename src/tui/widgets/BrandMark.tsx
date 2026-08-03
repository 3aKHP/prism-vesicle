import { ThemedText } from "../theme-text";
import { createMemo, For } from "solid-js";
import { fadedRuns, markRuns } from "../brand-mark";

/**
 * Renders a brand mark snapshot as colored text rows. Static — the caller owns
 * any animation (the splash moves a single light cell over the mark; the hero
 * never animates). `fade` scales every tint down toward the background for the
 * splash's stepped fade-out.
 */
export function BrandMark(props: { mark: readonly string[]; fade?: number }) {
  const rows = createMemo(() => fadedRuns(markRuns(props.mark), props.fade ?? 1));
  return (
    <box flexDirection="column">
      <For each={rows()}>
        {(row) => (
          <box flexDirection="row" height={1}>
            <For each={row}>
              {(run) => <ThemedText content={run.text} fg={run.fg} wrapMode="none" />}
            </For>
          </box>
        )}
      </For>
    </box>
  );
}
