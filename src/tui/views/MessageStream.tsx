import { createSignal, For, onCleanup, Show, type Accessor } from "solid-js";
import type { ScrollBoxRenderable } from "@opentui/core";
import { useRenderer } from "@opentui/solid";
import { palette } from "../theme";
import { Message } from "../widgets/Message";
import { ReasoningBlock } from "../widgets/ReasoningBlock";
import type { AgentCardState, Message as StreamMessage } from "../types";
import type { TuiKeyEvent } from "../decision-interaction";
import { parseStageMessageContent } from "../stage-message-content";

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
  agents: AgentCardState[];
  activeEngine?: string;
  sessionId?: string;
  transcriptKey?: string;
  onStageViewChange?: (id: string, source: boolean) => void;
  registerStageKeyHandler?: (handler: (key: TuiKeyEvent) => boolean) => void;
}) {
  const renderer = useRenderer();
  const [focusedStageMessageId, setFocusedStageMessageId] = createSignal<string | undefined>();
  let scrollbox: ScrollBoxRenderable | undefined;
  let scrollTransaction = 0;
  let pointerStartMessageId: string | undefined;
  let pointerDragged = false;


  function messageId(message: StreamMessage, index: number): string {
    return message.id ?? `message:${props.sessionId ?? "new"}:${index}`;
  }

  function toggleStageMessage(id: string): void {
    setFocusedStageMessageId(id);
    const box = scrollbox;
    const viewport = box?.viewport;
    const followingBottom = Boolean(box && viewport && box.scrollHeight - (box.scrollTop + viewport.height) <= 1);
    const anchor = !followingBottom && box && viewport
      ? stableAnchorIds().map((id) => box.getRenderable(id)).find((renderable) => renderable && renderable.screenY + renderable.height >= viewport.screenY)
      : undefined;
    const anchorId = anchor?.id;
    const anchorOffset = anchor && viewport ? anchor.screenY - viewport.screenY : undefined;
    const transaction = ++scrollTransaction;

    const source = !props.messages.some((message, index) => messageId(message, index) === id && message.stageSource === true);
    props.onStageViewChange?.(id, source);

    const restore = (retry: boolean) => {
      if (transaction !== scrollTransaction || !box || !viewport) return;
      if (followingBottom) {
        box.scrollTo({ x: box.scrollLeft, y: box.scrollHeight });
        return;
      }
      if (anchorId && anchorOffset !== undefined) {
        const after = box.getRenderable(anchorId);
        if (after) box.scrollTo({ x: box.scrollLeft, y: box.scrollTop + after.screenY - viewport.screenY - anchorOffset });
        else if (!retry) setTimeout(() => restore(true), 0);
        return;
      }
    };
    queueMicrotask(() => restore(false));
  }

  function stableAnchorIds(): string[] {
    return props.messages.flatMap((message, index) => {
      const id = messageId(message, index);
      if (message.role !== "assistant" || message.engine !== "stage") return [id];
      const parsed = parseStageMessageContent(message.content, id);
      if (message.kind !== "stage-bootstrap-opening" && !parsed.hud) return [id];
      return parsed.segments.flatMap((segment) => segment.kind === "comment" ? [segment.id] : [segment.id]);
    });
  }

  function eligibleStageMessageIds(): string[] {
    return props.messages.flatMap((message, index) => {
      if (message.role !== "assistant" || message.engine !== "stage") return [];
      const id = messageId(message, index);
      const parsed = parseStageMessageContent(message.content, id);
      return message.kind === "stage-bootstrap-opening" || parsed.hud ? [id] : [];
    });
  }

  function stageMessageAt(y: number): string | undefined {
    return eligibleStageMessageIds().find((id) => {
      const renderable = scrollbox?.getRenderable(id);
      return renderable !== undefined && y >= renderable.screenY && y < renderable.screenY + renderable.height;
    });
  }

  function handleStageMessageKey(key: TuiKeyEvent): boolean {
    const ids = eligibleStageMessageIds();
    if (ids.length === 0) return false;
    if (key.option && (key.name === "up" || key.name === "down")) {
      const current = focusedStageMessageId();
      const currentIndex = current ? ids.indexOf(current) : -1;
      const direction = key.name === "up" ? -1 : 1;
      const nextIndex = currentIndex < 0
        ? (direction > 0 ? 0 : ids.length - 1)
        : (currentIndex + direction + ids.length) % ids.length;
      const id = ids[nextIndex]!;
      setFocusedStageMessageId(id);
      scrollbox?.scrollChildIntoView(id);
      return true;
    }
    const focused = focusedStageMessageId();
    if (focused && (key.name === "enter" || key.name === "return" || key.name === "space")) {
      toggleStageMessage(focused);
      return true;
    }
    return false;
  }

  props.registerStageKeyHandler?.(handleStageMessageKey);
  onCleanup(() => props.registerStageKeyHandler?.(() => false));

  return (
    <box title="Messages" border borderColor={palette.sectionBorder} flexGrow={1} padding={1}>
      <scrollbox
        ref={scrollbox}
        width="100%"
        height="100%"
        stickyScroll
        stickyStart="bottom"
        onMouseDown={(event) => { pointerStartMessageId = stageMessageAt(event.y); pointerDragged = false; }}
        onMouseDrag={() => { pointerDragged = true; }}
        onMouseUp={(event) => {
          const messageId = stageMessageAt(event.y);
          if (!pointerStartMessageId || pointerStartMessageId !== messageId || pointerDragged || event.isDragging || event.defaultPrevented || renderer.hasSelection || event.button !== 0) return;
          toggleStageMessage(messageId);
        }}
      >
        <box flexDirection="column">
          <For each={props.messages}>{(message, index) => {
            const id = messageId(message, index());
            return <StageStreamMessage
              message={{ ...message, id }}
              reasoningMode={props.reasoningMode}
              width={props.contentWidth}
              agent={message.agentRunId ? props.agents.find((agent) => agent.runId === message.agentRunId) : undefined}
              expanded={() => message.stageSource === true}
              onToggle={() => toggleStageMessage(id)}
            />;
          }}</For>
          <Show when={props.streamingReasoning.trim().length > 0 && props.reasoningMode !== "hidden"} fallback={<box height={0} />}>
            <ReasoningBlock content={props.streamingReasoning} streaming={true} mode={props.reasoningMode} width={props.contentWidth} />
          </Show>
          <Show when={props.streamingAssistant.trim().length > 0} fallback={<box height={0} />}>
            <box flexDirection="column">
              <text content="━━━━━━━━ assistant streaming" fg={palette.assistant} attributes={1} />
              <Message
                message={{ id: `stream:${props.sessionId ?? "new"}`, role: "assistant", content: props.streamingAssistant, ...(props.activeEngine === "stage" ? { engine: "stage" as const } : {}) }}
                reasoningMode={props.reasoningMode}
                width={props.contentWidth}
                streaming
              />
            </box>
          </Show>
        </box>
      </scrollbox>
    </box>
  );
}

function StageStreamMessage(props: {
  message: StreamMessage;
  reasoningMode: string;
  width: number;
  agent?: AgentCardState;
  expanded: Accessor<boolean>;
  onToggle: () => void;
}) {
  const message = (stageSource: boolean) => <Message
    message={props.message}
    reasoningMode={props.reasoningMode}
    width={props.width}
    agent={props.agent}
    stageSource={stageSource}
    onStageToggle={props.onToggle}
  />;
  return <Show when={props.expanded()} fallback={message(false)}>{message(true)}</Show>;
}
