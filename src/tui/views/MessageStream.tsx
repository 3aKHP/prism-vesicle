import { Show } from "solid-js";
import { palette } from "../theme";
import { Message } from "../widgets/Message";
import { MarkdownContent } from "../widgets/MarkdownContent";
import { ReasoningBlock } from "../widgets/ReasoningBlock";
import type { Message as StreamMessage } from "../types";

/**
 * The hero conversation surface: a sticky-bottom scrollbox of messages plus the
 * in-flight streaming reasoning / assistant blocks. Presentational — all state
 * is owned by the App shell and passed in as props.
 */
export function MessageStream(props: {
  messages: StreamMessage[];
  streamingReasoning: string;
  streamingAssistant: string;
  reasoningMode: string;
  contentWidth: number;
}) {
  return (
    <box title="Messages" border borderColor={palette.sectionBorder} flexGrow={1} padding={1}>
      <scrollbox width="100%" height="100%" stickyScroll stickyStart="bottom">
        <box flexDirection="column">
          {props.messages.map((message) => (
            <Message message={message} reasoningMode={props.reasoningMode} width={props.contentWidth} />
          ))}
          <Show when={props.streamingReasoning.trim().length > 0 && props.reasoningMode !== "hidden"} fallback={<box height={0} />}>
            <ReasoningBlock content={props.streamingReasoning} streaming={true} mode={props.reasoningMode} width={props.contentWidth} />
          </Show>
          <Show when={props.streamingAssistant.trim().length > 0} fallback={<box height={0} />}>
            <box flexDirection="column">
              <text content="━━━━━━━━ assistant streaming" fg={palette.assistant} attributes={1} />
              <MarkdownContent content={props.streamingAssistant} />
            </box>
          </Show>
        </box>
      </scrollbox>
    </box>
  );
}
