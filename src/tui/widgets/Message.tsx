import type { FileToolEvent, McpToolEvent, WebToolEvent } from "../../core/tools";
import { engineAccent, engineDisplayName, palette } from "../theme";
import { MarkdownContent } from "./MarkdownContent";
import { ReasoningBlock } from "./ReasoningBlock";
import { ToolCard } from "./ToolCard";
import { ArtifactCard } from "./ArtifactCard";
import type { VesicleImageAttachment } from "../../providers/shared/types";

type MessageLike = {
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
export function Message(props: { message: MessageLike; reasoningMode: string; width: number }) {
  const m = props.message;

  if (m.kind === "reasoning") {
    return <ReasoningBlock content={m.content} streaming={false} mode={props.reasoningMode} width={props.width} />;
  }

  if (m.kind === "artifact" && m.artifactPath) {
    return <ArtifactCard path={m.artifactPath} content={m.content} truncated={m.artifactTruncated ?? false} />;
  }

  if (m.role === "assistant" && m.content.trim()) {
    return (
      <box flexDirection="column">
        <box flexDirection="row">
          <box width={1} backgroundColor={palette.laneAssistant} />
          <box flexDirection="column" paddingX={1} flexGrow={1}>
            {m.engine && (
              <text content={`▣ ${engineDisplayName(m.engine)}${m.model ? `·${m.model}` : ""}`} fg={engineAccent(m.engine)} attributes={1} />
            )}
            <MarkdownContent content={m.content} />
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
