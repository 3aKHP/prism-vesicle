import { createMemo, For, Show } from "solid-js";
import { palette } from "../theme";
import { truncateLine } from "../format";

function reasoningDisplayLines(content: string, width: number, maxLines: number): string[] {
  const cleaned = content.replace(/\t/g, "  ");
  const rawLines = cleaned.split(/\r?\n/).map((line) => truncateLine(line || " ", width));
  if (rawLines.length <= maxLines) return rawLines;
  const visibleTailLines = Math.max(0, maxLines - 1);
  const hidden = rawLines.length - visibleTailLines;
  return [`... ${hidden} earlier reasoning line${hidden === 1 ? "" : "s"} hidden`, ...rawLines.slice(-visibleTailLines)];
}

/**
 * A provider thinking / reasoning block. Collapsed mode shows a bounded tail
 * preview; expanded shows more. Hidden or empty renders nothing. All derived
 * values are memos / inline JSX so the block updates as content streams and as
 * the reasoning display mode changes.
 */
export function ReasoningBlock(props: { content: string; streaming: boolean; mode: string; width: number }) {
  const lines = createMemo(() => reasoningDisplayLines(props.content, props.width, props.mode === "expanded" ? 14 : 4));
  const rawLineCount = createMemo(() => props.content.split(/\r?\n/).length);
  return (
    <Show when={props.mode !== "hidden" && props.content.trim().length > 0} fallback={<box height={0} />}>
      <box flexDirection="column">
        <text
          content={`━━━━━━━━ ${props.streaming ? "thinking streaming" : props.mode === "expanded" ? "thinking expanded" : "thinking collapsed"} (${props.content.length} chars, ${rawLineCount()} line${rawLineCount() === 1 ? "" : "s"}) ${props.mode === "expanded" ? "/reasoning collapse" : "/reasoning expand"}`}
          fg={palette.textMuted}
          attributes={1}
        />
        <For each={lines()}>
          {(line) => <text content={line} fg={palette.textDim} />}
        </For>
        <text content=" " fg={palette.textDim} />
      </box>
    </Show>
  );
}
