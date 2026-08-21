import { ThemedText } from "../theme-text";
import { createMemo, createSignal, For, onCleanup, Show, type Accessor } from "solid-js";
import type { ScrollBoxRenderable } from "@3akhp/opentui-core";
import { useRenderer } from "@3akhp/opentui-solid";
import { palette } from "../theme";
import { Message } from "../widgets/Message";
import { ReasoningBlock } from "../widgets/ReasoningBlock";
import { EmptyHero } from "./EmptyHero";
import type { AgentCardState, Message as StreamMessage } from "../types";
import type { TuiKeyEvent } from "../decision-interaction";
import { parseStageMessageContent, type StageMessageContent } from "../stage-message-content";
import { isStageMessageToggleShortcut } from "../stage-message-interaction";
import type { TurnAnchor } from "../turn-anchors";

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
  showHero?: boolean;
  onStageViewChange?: (id: string, source: boolean) => void;
  registerStageKeyHandler?: (handler: (key: TuiKeyEvent) => boolean) => void;
  /** Active horizontal-candidate switcher for the current turn (#88), or null. */
  candidateSwitcher?: Accessor<{ index: number; total: number } | null>;
  onCandidateSwitch?: (direction: -1 | 1) => void;
  /** Called when Alt+←/→ cannot switch (no armed switcher); never silent. */
  onCandidateSwitchRejected?: () => void;
  /** Turn-level focus anchors for the unified Alt+↑/↓ cursor. */
  turnAnchors?: Accessor<TurnAnchor[]>;
  focusedTurn?: Accessor<string | null>;
  onFocusTurn?: (forkUuid: string) => void;
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

  const stageMessageMetadata = createMemo(() => {
    const parsedById = new Map<string, StageMessageContent>();
    const eligibleIds: string[] = [];
    for (const [index, message] of props.messages.entries()) {
      if (message.role !== "assistant" || message.engine !== "stage") continue;
      const id = messageId(message, index);
      const parsed = parseStageMessageContent(message.content, id);
      parsedById.set(id, parsed);
      if (message.kind === "stage-bootstrap-opening" || parsed.hud || parsed.hasNeuralChain) eligibleIds.push(id);
    }
    return { parsedById, eligibleIds };
  });

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
      const parsed = stageMessageMetadata().parsedById.get(id);
      if (!parsed || (message.kind !== "stage-bootstrap-opening" && !parsed.hud && !parsed.hasNeuralChain)) return [id];
      return parsed.segments.map((segment) => segment.id);
    });
  }

  function eligibleStageMessageIds(): string[] {
    return stageMessageMetadata().eligibleIds;
  }

  function stageMessageAt(y: number): string | undefined {
    return eligibleStageMessageIds().find((id) => {
      const renderable = scrollbox?.getRenderable(id);
      return renderable !== undefined && y >= renderable.screenY && y < renderable.screenY + renderable.height;
    });
  }

  /**
   * Alt+arrow dispatch. Precedence: candidate cycling beats turn-focus
   * navigation beats Stage toggle; the legacy Stage-only navigation remains
   * the fallback when no turn anchors are provided. Alt arrives as `option`
   * under enhanced keyboard protocols and `meta` in legacy terminals.
   */
  function handleStageMessageKey(key: TuiKeyEvent): boolean {
    const altLike = key.meta === true || key.option === true;
    if (!altLike || key.ctrl) return isStageMessageToggleShortcut(key) && handleStageToggle(key);
    if (key.name === "left" || key.name === "right") return handleCandidateCycle(key);
    if (key.name === "up" || key.name === "down") {
      if (handleTurnFocusNavigation(key)) return true;
      return handleLegacyStageNavigation(key);
    }
    return false;
  }

  /** Alt+←/→: cycle the armed switcher, else report guidance (never silent). */
  function handleCandidateCycle(key: TuiKeyEvent): boolean {
    const switcher = props.candidateSwitcher?.();
    if (switcher && switcher.total > 1) {
      props.onCandidateSwitch?.(key.name === "left" ? -1 : 1);
      return true;
    }
    if (props.onCandidateSwitchRejected) {
      props.onCandidateSwitchRejected();
      return true;
    }
    return false;
  }

  /** Alt+↑/↓: move the transcript-wide turn-focus cursor (wrapping). */
  function handleTurnFocusNavigation(key: TuiKeyEvent): boolean {
    const anchors = props.turnAnchors?.() ?? [];
    if (anchors.length === 0) return false;
    const focused = props.focusedTurn?.() ?? null;
    const currentIndex = focused ? anchors.findIndex((anchor) => anchor.forkUuid === focused) : -1;
    const direction = key.name === "up" ? -1 : 1;
    const nextIndex = currentIndex < 0
      ? (direction > 0 ? 0 : anchors.length - 1)
      : (currentIndex + direction + anchors.length) % anchors.length;
    const anchor = anchors[nextIndex]!;
    props.onFocusTurn?.(anchor.forkUuid);
    scrollbox?.scrollChildIntoView(anchor.userMessageId);
    // Keep the Stage mechanism's focus in sync so Ctrl+Alt+S and mouse
    // toggling keep working on eligible focused turns.
    if (anchor.assistantMessageId && eligibleStageMessageIds().includes(anchor.assistantMessageId)) {
      setFocusedStageMessageId(anchor.assistantMessageId);
    }
    return true;
  }

  /** Ctrl+Alt+S: toggle the focused turn's Stage message (or the legacy focus). */
  function handleStageToggle(key: TuiKeyEvent): boolean {
    if (!isStageMessageToggleShortcut(key)) return false;
    const anchors = props.turnAnchors?.() ?? [];
    const focusedFork = props.focusedTurn?.() ?? null;
    const anchor = anchors.length > 0 && focusedFork
      ? anchors.find((entry) => entry.forkUuid === focusedFork)
      : undefined;
    const target = anchor?.assistantMessageId && eligibleStageMessageIds().includes(anchor.assistantMessageId)
      ? anchor.assistantMessageId
      : focusedStageMessageId();
    if (target && eligibleStageMessageIds().includes(target)) {
      toggleStageMessage(target);
      return true;
    }
    return false;
  }

  /** Fallback (no turn anchors provided): Stage-only navigation. */
  function handleLegacyStageNavigation(key: TuiKeyEvent): boolean {
    const ids = eligibleStageMessageIds();
    if (ids.length === 0) return false;
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

  props.registerStageKeyHandler?.(handleStageMessageKey);
  onCleanup(() => props.registerStageKeyHandler?.(() => false));

  const candidateLabel = createMemo(() => {
    const switcher = props.candidateSwitcher?.();
    if (!switcher || switcher.total <= 1) return null;
    return `< ${switcher.index + 1}/${switcher.total} >  Option+←/→ switch · Ctrl+R regenerate`;
  });

  /** Display ids highlighted by the turn-focus cursor (prompt + final reply). */
  const focusedMessageIds = createMemo(() => {
    const focusedFork = props.focusedTurn?.() ?? null;
    if (!focusedFork) return new Set<string>();
    const anchor = (props.turnAnchors?.() ?? []).find((entry) => entry.forkUuid === focusedFork);
    if (!anchor) return new Set<string>();
    return new Set([anchor.userMessageId, ...(anchor.assistantMessageId ? [anchor.assistantMessageId] : [])]);
  });

  const stream = (
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
            parsed={stageMessageMetadata().parsedById.get(id)}
            onToggle={() => toggleStageMessage(id)}
            focused={focusedMessageIds().has(id)}
          />;
        }}</For>
        <Show when={props.streamingReasoning.trim().length > 0 && props.reasoningMode !== "hidden"} fallback={<box height={0} />}>
          <ReasoningBlock content={props.streamingReasoning} streaming={true} mode={props.reasoningMode} width={props.contentWidth} />
        </Show>
        <Show when={props.streamingAssistant.trim().length > 0} fallback={<box height={0} />}>
          <box flexDirection="column">
            <ThemedText content="━━━━━━━━ assistant streaming" fg={palette.assistant} attributes={1} />
            <Message
              message={{ id: `stream:${props.sessionId ?? "new"}`, role: "assistant", content: props.streamingAssistant, ...(props.activeEngine === "stage" ? { engine: "stage" as const } : {}) }}
              reasoningMode={props.reasoningMode}
              width={props.contentWidth}
              streaming
            />
          </box>
        </Show>
        <Show when={candidateLabel()} fallback={<box height={0} />}>
          <box height={1}>
            <ThemedText content={candidateLabel()!} fg={palette.brand} attributes={1} />
          </box>
        </Show>
      </box>
    </scrollbox>
  );

  return (
    <box title="Messages" border borderColor={palette.sectionBorder} flexGrow={1} padding={1}>
      <Show
        when={!props.showHero}
        fallback={<EmptyHero notices={props.messages.filter((message) => message.role === "system" && !message.kind).map((message) => message.content)} />}
      >{stream}</Show>
    </box>
  );
}

function StageStreamMessage(props: {
  message: StreamMessage;
  reasoningMode: string;
  width: number;
  agent?: AgentCardState;
  expanded: Accessor<boolean>;
  parsed?: StageMessageContent;
  onToggle: () => void;
  focused?: boolean;
}) {
  const message = (stageSource: boolean) => <Message
    message={props.message}
    reasoningMode={props.reasoningMode}
    width={props.width}
    agent={props.agent}
    stageSource={stageSource}
    stageParsed={props.parsed}
    onStageToggle={props.onToggle}
    focused={props.focused}
  />;
  return <Show when={props.expanded()} fallback={message(false)}>{message(true)}</Show>;
}
