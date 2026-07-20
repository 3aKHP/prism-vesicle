// TUI-wide shared types. Extracted from app.tsx so the command subsystem
// (src/tui/commands/) can reference them without a circular import on the
// App component. Keep this module free of runtime code — types only.

import type { FileToolEvent, McpToolEvent, ProcessToolEvent, WebToolEvent } from "../core/tools";
import type { EngineId } from "../core/engine/profile";
import type { SessionSummary } from "../core/session/store";
import type { ArtifactPreview } from "../core/artifacts/workbench";
import type { RewindPoint } from "../core/rewind/service";
import type { VesicleImageAttachment } from "../providers/shared/types";
import type { AgentExecutionMode } from "../core/agents/profile";
import type { ResponseUsage } from "../providers/shared/types";

export type Role = "user" | "assistant" | "system" | "tool";

export type Message = {
  id?: string;
  /** Ephemeral Stage source-view state; never written to session records. */
  stageSource?: boolean;
  role: Role;
  content: string;
  kind?: "reasoning" | "artifact" | "agent" | "stage-bootstrap-opening";
  agentRunId?: string;
  artifactPath?: string;
  artifactTruncated?: boolean;
  toolStage?: "call" | "result";
  toolName?: string;
  toolArgs?: string;
  toolCallId?: string;
  toolOk?: boolean;
  toolFileEvent?: FileToolEvent;
  toolWebEvent?: WebToolEvent;
  toolMcpEvent?: McpToolEvent;
  toolProcessEvent?: ProcessToolEvent;
  engine?: EngineId;
  model?: string;
  images?: VesicleImageAttachment[];
};

export type AgentCardStatus = "queued" | "running" | "ready" | "integrating" | "integrated" | "completed" | "failed" | "cancelled";

export type AgentCardState = {
  runId: string;
  handle: string;
  profileId: string;
  parentToolCallId: string;
  parentSessionId: string;
  description: string;
  mode: AgentExecutionMode;
  status: AgentCardStatus;
  delivery?: "pending" | "integrating" | "integrated";
  progress?: string;
  resultPreview?: string;
  createdAt: string;
  updatedAt: string;
  usage?: ResponseUsage;
  toolUses?: number;
};

export type SelectedArtifact = ArtifactPreview;

export type ActivityEntry = {
  kind: "provider" | "assistant" | "tool" | "agent" | "gate" | "validation" | "system";
  text: string;
};

export type SessionPickerState = {
  sessions: SessionSummary[];
  selected: number;
};

export type RewindRestoreOption = "both" | "conversation" | "code" | "summarize" | "nevermind";

export type RewindPickerState = {
  points: RewindPoint[];
  /** points.length is the virtual CC-compatible `(current)` row. */
  selected: number;
  target?: RewindPoint;
  restoreSelected: number;
  summaryFeedback: string;
  summaryCursor: number;
  busy: boolean;
  restoringOption?: RewindRestoreOption;
  error?: string;
};

export type OptionItem = {
  id: string;
  label: string;
  detail?: string;
};
