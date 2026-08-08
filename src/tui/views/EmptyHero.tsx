import { ThemedText } from "../theme-text";
import { For, Show } from "solid-js";
import { COMPACT_MARK } from "../brand-mark";
import { palette } from "../theme";
import { BrandMark } from "../widgets/BrandMark";

/**
 * M2 — empty-session hero (visual contract §2): a persistent but quiet brand
 * signature shown only while the stream holds no conversation. Static by
 * design — the workspace's baseline is calm; the blank space is the
 * signature. It is replaced by the real transcript after the first turn.
 *
 * `notices` carries any system-level notices (e.g. the YOLO CLI warning) that
 * must stay visible above the hero.
 */
export function EmptyHero(props: { notices: string[] }) {
  return (
    <box flexDirection="column" width="100%" height="100%">
      <Show when={props.notices.length > 0} fallback={<box height={0} />}>
        <box flexDirection="column" paddingBottom={1}>
          <For each={props.notices}>
            {(notice) => <ThemedText content={notice} fg={palette.system} wrapMode="none" />}
          </For>
        </box>
      </Show>
      <box flexGrow={1} flexDirection="column" alignItems="center" justifyContent="center">
        <BrandMark mark={COMPACT_MARK} />
        <box height={1} />
        <ThemedText content="PRISM VESICLE" fg={palette.brand} attributes={1} wrapMode="none" />
        <ThemedText content="one beam in, the spectrum out" fg={palette.brandDim} wrapMode="none" />
        <box height={1} />
        <ThemedText content="Type a prompt to begin — /help lists commands" fg={palette.textDim} wrapMode="none" />
      </box>
    </box>
  );
}
