import { palette } from "../theme";
import { normalStageRenderParts, parseStageMessageContent } from "../stage-message-content";
import { renderMarkdownPlainText } from "../markdown-display";
import { Show } from "solid-js";

export function StageMessageContent(props: {
  content: string;
  messageId: string;
  source: boolean;
  streaming?: boolean;
}) {
  const parsed = () => parseStageMessageContent(props.content, props.messageId, props.streaming === true);

  return (
    <Show when={props.source} fallback={
      <box flexDirection="column" width="100%">
        {parsed().hud ? <text content={`◇ ${parsed().hud!.summary}`} fg={palette.textDim} /> : <box height={0} />}
        {normalStageRenderParts(parsed()).map((part) => part.kind === "anchor"
          ? <box id={part.id} height={0} />
          : <text id={part.segment.id} content={renderMarkdownPlainText(part.segment.raw)} fg={palette.textPrimary} />)}
      </box>
    }>
      <box flexDirection="column" width="100%">
        {parsed().segments.map((segment) => <text id={segment.id} content={segment.raw} fg={palette.textPrimary} />)}
      </box>
    </Show>
  );
}
