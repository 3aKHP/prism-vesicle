import { palette } from "../theme";
import { normalStageRenderParts, type StageMessageContent as ParsedStageMessageContent } from "../stage-message-content";
import { renderMarkdownPlainText } from "../markdown-display";
import { Show } from "solid-js";

export function StageMessageContent(props: {
  parsed: ParsedStageMessageContent;
  source: boolean;
}) {
  return (
    <Show when={props.source} fallback={
      <box flexDirection="column" width="100%">
        {props.parsed.hud ? <text content={`◇ ${props.parsed.hud.summary}`} fg={palette.textDim} /> : <box height={0} />}
        {normalStageRenderParts(props.parsed).map((part) => part.kind === "anchor"
          ? <box id={part.id} height={0} />
          : <text id={part.segment.id} content={renderMarkdownPlainText(part.segment.raw)} fg={palette.textPrimary} />)}
      </box>
    }>
      <box flexDirection="column" width="100%">
        {props.parsed.segments.map((segment) => <text id={segment.id} content={segment.raw} fg={palette.textPrimary} />)}
      </box>
    </Show>
  );
}
