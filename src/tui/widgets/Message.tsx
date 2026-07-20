import type { FileToolEvent, McpToolEvent, ProcessToolEvent, WebToolEvent } from "../../core/tools";
import { engineAccent, engineDisplayName, palette } from "../theme";
import { MarkdownContent } from "./MarkdownContent";
import { ReasoningBlock } from "./ReasoningBlock";
import { ToolCard } from "./ToolCard";
import { ArtifactCard } from "./ArtifactCard";
import { AgentCard } from "./AgentCard";
import { StageMessageContent } from "./StageMessageContent";
import { useRenderer } from "@opentui/solid";
import type { AgentCardState } from "../types";
import type { VesicleImageAttachment } from "../../providers/shared/types";
import { parseStageMessageContent } from "../stage-message-content";
import { isStageMessageToggleShortcut } from "../stage-message-interaction";

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
  onStageToggle?: () => void;
  streaming?: boolean;
}) {
  const renderer = useRenderer();
  const m = props.message;

  if (m.kind === "agent" && props.agent) {
    return <AgentCard agent={props.agent} width={props.width} />;
  }

  if (m.kind === "reasoning") {
    return <ReasoningBlock content={m.content} streaming={false} mode={props.reasoningMode} width={props.width} />;
  }

  if (m.kind === "artifact" && m.artifactPath) {
    return <ArtifactCard path={m.artifactPath} content={m.content} truncated={m.artifactTruncated ?? false} />;
  }

  if (m.role === "assistant" && m.content.trim()) {
    const stageParsed = m.engine === "stage" ? parseStageMessageContent(m.content, m.id ?? "stage-message", props.streaming === true) : undefined;
    const showStageProjection = m.engine === "stage" && (
      m.kind === "stage-bootstrap-opening"
      || stageParsed?.hud !== undefined
      || stageParsed?.pendingCommentStart !== undefined
      || (props.streaming === true && stageParsed?.segments.some((segment) => segment.kind === "comment" && segment.raw.includes("[!Neural Chain]")))
    );
    let dragged = false;
    const beginPointer = () => { dragged = false; };
    const trackDrag = () => { dragged = true; };
    const endPointer = (event: { button: number; isDragging?: boolean; defaultPrevented: boolean }) => {
      if (!showStageProjection || dragged || event.isDragging || event.defaultPrevented || renderer.hasSelection || event.button !== 0) return;
      props.onStageToggle?.();
    };
    return (
      <box
        id={m.id}
        flexDirection="column"
        focusable={showStageProjection}
        onKeyDown={(key) => {
          if (!showStageProjection || !isStageMessageToggleShortcut(key)) return;
          key.preventDefault();
          key.stopPropagation();
          props.onStageToggle?.();
        }}
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
            {m.engine && (
              <text
                content={`▣ ${engineDisplayName(m.engine)}${m.model ? `·${m.model}` : ""}`}
                fg={engineAccent(m.engine)}
                attributes={1}
                onMouseDown={beginPointer}
                onMouseDrag={trackDrag}
                onMouseUp={endPointer}
              />
            )}
            {showStageProjection
              ? <StageMessageContent content={m.content} messageId={m.id ?? "stage-message"} source={props.stageSource ?? m.stageSource === true} streaming={props.streaming} />
              : <MarkdownContent content={m.content} />}
          </box>
        </box>
        <text content=" " fg={palette.textDim} />
      </box>
    );
  }

  if (m.role === "user") {
    return (
      <box flexDirection="column">
        <box flexDirection="row">
          <box width={1} backgroundColor={palette.laneUser} />
          <box flexDirection="column" border borderColor={palette.sectionBorder} paddingX={1} flexGrow={1}>
            <text content={m.content} fg={palette.textPrimary} />
            {(m.images ?? []).map((image, index) => (
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
  if (m.role === "tool" && m.toolStage) {
    return (
      <ToolCard
        toolStage={m.toolStage}
        toolName={m.toolName}
        toolArgs={m.toolArgs}
        toolOk={m.toolOk}
        toolFileEvent={m.toolFileEvent}
        toolWebEvent={m.toolWebEvent}
        toolMcpEvent={m.toolMcpEvent}
        toolProcessEvent={m.toolProcessEvent}
        images={m.images}
        content={m.content}
        width={props.width}
      />
    );
  }

  // system / tool
  const color = m.role === "system" ? palette.system : palette.tool;
  const lane = m.role === "system" ? palette.laneSystem : palette.laneTool;
  return (
    <box flexDirection="column">
      <box flexDirection="row">
        <box width={1} backgroundColor={lane} />
        <box flexDirection="column" paddingX={1} flexGrow={1}>
          <text content={m.role} fg={color} attributes={1} />
          <text content={m.content} fg={palette.textPrimary} />
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
