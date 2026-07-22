// `/btw` full-area overlay. While active it visually replaces the message
// stream and composer; the main TUI state keeps running underneath. Presentational
// only — exchange state and key handling are owned by the side-question
// controller and passed in as props. The answer renders through the same
// MarkdownContent + syntax highlighting as the main message stream, inside a
// scrollbox; the controller forwards ↑/↓ to the registered scroller.

import { TextAttributes, type ScrollBoxRenderable } from "@opentui/core";
import { Match, Show, Switch, createEffect, onCleanup, onMount } from "solid-js";
import { palette } from "../theme";
import { truncateLine, wrapDisplayLines } from "../format";
import { MarkdownContent } from "../widgets/MarkdownContent";
import type { SideQuestionExchange } from "../side-question-controller";

export type SideQuestionOverlayProps = {
  exchange: SideQuestionExchange | undefined;
  index: number;
  total: number;
  mainStatus: string;
  width: number;
  height: number;
  /** Register a scroll driver so the controller's ↑/↓ scroll the answer. */
  registerScroller?: (scroll: (delta: number) => void) => () => void;
};

const FOOTER_HINT = "Esc close · ↑/↓ scroll · ←/→ exchanges · c copy · x clear";

export function SideQuestionOverlay(props: SideQuestionOverlayProps) {
  const innerWidth = () => Math.max(8, props.width - 4);
  let scrollbox: ScrollBoxRenderable | undefined;

  const phase = () => props.exchange?.phase;
  const answer = () => props.exchange?.answer ?? "";

  onMount(() => {
    if (!props.registerScroller) return;
    const cleanup = props.registerScroller((delta) => {
      const box = scrollbox;
      if (!box?.viewport) return;
      const max = Math.max(0, box.scrollHeight - box.viewport.height);
      const next = Math.max(0, Math.min(max, box.scrollTop + delta));
      box.scrollTo({ x: box.scrollLeft, y: next });
    });
    onCleanup(cleanup);
  });

  // Reset to the top whenever the shown exchange or its phase changes, so a
  // completed answer is read from the start and navigation lands at the top.
  createEffect(() => {
    void props.exchange?.id;
    void phase();
    setTimeout(() => {
      if (scrollbox?.viewport) scrollbox.scrollTo({ x: scrollbox.scrollLeft, y: 0 });
    }, 0);
  });

  onCleanup(() => { scrollbox = undefined; });

  const title = () => {
    const count = props.total > 0 ? `${props.index + 1}/${props.total}` : "—";
    return `BTW · ${count}`;
  };

  const questionLines = () => wrapDisplayLines(`Q: ${props.exchange?.question ?? ""}`, innerWidth()).slice(0, 2);

  const usageText = () => {
    const usage = phase() === "complete" ? props.exchange?.usage : undefined;
    if (!usage) return "";
    const parts: string[] = [];
    if (typeof usage.inputTokens === "number") parts.push(`↑${usage.inputTokens}`);
    if (typeof usage.outputTokens === "number") parts.push(`↓${usage.outputTokens}`);
    return parts.length > 0 ? `side tokens ${parts.join(" ")}` : "";
  };

  return (
    <box flexDirection="column" width="100%" height="100%" border borderColor={palette.panelBorder} paddingX={1}>
      <box flexDirection="row" height={1}>
        <text content={title()} fg={palette.brand} attributes={TextAttributes.BOLD} wrapMode="none" />
        <text content={`  ${props.mainStatus}`} fg={palette.textMuted} wrapMode="none" />
      </box>
      {questionLines().map((line) => (
        <box height={1}>
          <text content={truncateLine(line, innerWidth())} fg={palette.user} wrapMode="none" />
        </box>
      ))}
      <scrollbox ref={scrollbox} width="100%" flexGrow={1} stickyScroll stickyStart="bottom">
        <box flexDirection="column" width="100%">
          <Switch>
            <Match when={phase() === "loading" && answer().trim().length > 0}>
              <MarkdownContent content={`${answer()}\n\n…`} />
            </Match>
            <Match when={phase() === "loading"}>
              <text content="Thinking…" fg={palette.textMuted} />
            </Match>
            <Match when={phase() === "error"}>
              <text content={`Error: ${props.exchange?.error ?? "unknown"}`} fg={palette.error} wrapMode="word" />
            </Match>
            <Match when={phase() === "cancelled"}>
              <text content="Side question cancelled." fg={palette.textMuted} />
            </Match>
            <Match when={phase() === "complete"}>
              <MarkdownContent content={answer()} />
            </Match>
          </Switch>
        </box>
      </scrollbox>
      <Show when={usageText().length > 0} fallback={<box height={0} />}>
        <box height={1}>
          <text content={truncateLine(usageText(), innerWidth())} fg={palette.textDim} wrapMode="none" />
        </box>
      </Show>
      <box height={1}>
        <text content={truncateLine(FOOTER_HINT, innerWidth())} fg={palette.textDim} wrapMode="none" />
      </box>
    </box>
  );
}
