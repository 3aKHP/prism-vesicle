import type { FileToolEvent, McpToolEvent, ProcessToolEvent, WebToolEvent } from "../../core/tools";
import { engineAccent, engineDisplayName, palette } from "../theme";
import { MarkdownContent } from "./MarkdownContent";
import { ReasoningBlock } from "./ReasoningBlock";
import { ToolCard } from "./ToolCard";
import { ArtifactCard } from "./ArtifactCard";
import { AgentCard } from "./AgentCard";
import { StageMessageContent } from "./StageMessageContent";
import { createMemo } from "solid-js";
import { useRenderer } from "@opentui/solid";
import type { AgentCardState } from "../types";
import type { VesicleImageAttachment } from "../../providers/shared/types";
import { parseStageMessageContent, type StageMessageContent as ParsedStageMessageContent } from "../stage-message-content";

type MessageLike = {
  stageSource?: boolean;
  role: string;
  content: string;
  kind?: string;
  artifactPath?: string;
  artifactTruncated?: boolean;
  toolStage?: "call" | "result";
  toolName?: string;
  toolArgs?: string;
  toolOk?: boolean;
  toolFileEvent?: FileToolEvent;
  toolWebEvent?: WebToolEvent;
  toolMcpEvent?: McpToolEvent;
  toolProcessEvent?: ProcessToolEvent;
  engine?: string;
  model?: string;
  images?: VesicleImageAttachment[];
};

/**
 * A single stream entry with the Synaptic Prism boundary treatment:
 *   - a 1-cell left "spectrum lane" coloured by role — the glanceable
 *     who-said-what boundary, and
 *   - asymmetric containment: user input is a bordered card (contained),
 *     assistant output is borderless flowing prose (the reading surface).
 *   - system / tool keep a small role tag (they are meta, not narrative).
 * The lane is engine-independent (role-based); engine accent lives on the
 * header and future turn markers.
 */
export function Message(props: {
  message: MessageLike & { id?: string };
  reasoningMode: string;
  width: number;
  agent?: AgentCardState;
  stageSource?: boolean;
  stageParsed?: ParsedStageMessageContent;
  onStageToggle?: () => void;
  streaming?: boolean;
}) {
  const renderer = useRenderer();

  if (props.message.kind === "agent" && props.agent) {
    return <AgentCard agent={props.agent} width={props.width} />;
  }

  if (props.message.kind === "reasoning") {
    return <ReasoningBlock content={props.message.content} streaming={false} mode={props.reasoningMode} width={props.width} />;
  }

  if (props.message.kind === "artifact" && props.message.artifactPath) {
    return <ArtifactCard path={props.message.artifactPath} content={props.message.content} truncated={props.message.artifactTruncated ?? false} />;
  }

  if (props.message.role === "assistant" && props.message.content.trim()) {
    const stageParsed = createMemo(() => props.message.engine === "stage"
      ? props.stageParsed ?? parseStageMessageContent(props.message.content, props.message.id ?? "stage-message", props.streaming === true)
      : undefined);
    const showStageProjection = createMemo(() => props.message.engine === "stage" && (
      props.message.kind === "stage-bootstrap-opening"
      || stageParsed()?.hud !== undefined
      || stageParsed()?.hasNeuralChain === true
      || stageParsed()?.pendingCommentStart !== undefined
    ));
    let dragged = false;
    const beginPointer = () => { dragged = false; };
    const trackDrag = () => { dragged = true; };
    const endPointer = (event: { button: number; isDragging?: boolean; defaultPrevented: boolean; preventDefault(): void; stopPropagation(): void }) => {
      if (!showStageProjection() || dragged || event.isDragging || event.defaultPrevented || renderer.hasSelection || event.button !== 0) return;
      event.preventDefault();
      event.stopPropagation();
      props.onStageToggle?.();
    };
    return (
      <box
        id={props.message.id}
        flexDirection="column"
      >
        <box flexDirection="row">
          <box
            width={1}
            backgroundColor={palette.laneAssistant}
            onMouseDown={beginPointer}
            onMouseDrag={trackDrag}
            onMouseUp={endPointer}
          />
          <box flexDirection="column" paddingX={1} flexGrow={1}>
            {props.message.engine && (
              <text
                content={`▣ ${engineDisplayName(props.message.engine)}${props.message.model ? `·${props.message.model}` : ""}`}
                fg={engineAccent(props.message.engine)}
                attributes={1}
                onMouseDown={beginPointer}
                onMouseDrag={trackDrag}
                onMouseUp={endPointer}
              />
            )}
            {showStageProjection()
              ? <StageMessageContent parsed={stageParsed()!} source={props.stageSource ?? props.message.stageSource === true} />
              : <MarkdownContent content={props.message.content} />}
          </box>
        </box>
        <text content=" " fg={palette.textDim} />
      </box>
    );
  }

  if (props.message.role === "user") {
    return (
      <box flexDirection="column">
        <box flexDirection="row">
          <box width={1} backgroundColor={palette.laneUser} />
          <box flexDirection="column" border borderColor={palette.sectionBorder} paddingX={1} flexGrow={1}>
            <text content={props.message.content} fg={palette.textPrimary} />
            {(props.message.images ?? []).map((image, index) => (
              <text
                content={`▧ Image #${index + 1} · ${image.sourcePath ?? image.filename ?? image.source} · ${formatImageBytes(image.bytes)}`}
                fg={palette.user}
              />
            ))}
          </box>
        </box>
        <text content=" " fg={palette.textDim} />
      </box>
    );
  }

  // Live tool calls/results render as inline cards (Phase D). Resumed tool
  // records carry no toolStage and fall through to the system/tool summary
  // below.
  if (props.message.role === "tool" && props.message.toolStage) {
    return (
      <ToolCard
        toolStage={props.message.toolStage}
        toolName={props.message.toolName}
        toolArgs={props.message.toolArgs}
        toolOk={props.message.toolOk}
        toolFileEvent={props.message.toolFileEvent}
        toolWebEvent={props.message.toolWebEvent}
        toolMcpEvent={props.message.toolMcpEvent}
        toolProcessEvent={props.message.toolProcessEvent}
        images={props.message.images}
        content={props.message.content}
        width={props.width}
      />
    );
  }

  // system / tool
  const color = props.message.role === "system" ? palette.system : palette.tool;
  const lane = props.message.role === "system" ? palette.laneSystem : palette.laneTool;
  return (
    <box flexDirection="column">
      <box flexDirection="row">
        <box width={1} backgroundColor={lane} />
        <box flexDirection="column" paddingX={1} flexGrow={1}>
          <text content={props.message.role} fg={color} attributes={1} />
          <text content={props.message.content} fg={palette.textPrimary} />
        </box>
      </box>
      <text content=" " fg={palette.textDim} />
    </box>
  );
}

function formatImageBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}
