import type { VesicleMessage } from "../../providers/shared/types";
import { persistedImageAttachments } from "../attachments/store";
import type { ProcessManager } from "../process/manager";
import type { SessionStore } from "../session/store";
import type { ToolResult } from "../tools";
import { trackBackgroundProcessCompletion } from "./background-process";
import type { AgentLoopEvent } from "./types";

type RecordToolResultOptions = {
  result: ToolResult;
  messages: VesicleMessage[];
  session: SessionStore;
  processManager?: ProcessManager;
  metadata?: Record<string, unknown>;
  onEvent?: (event: AgentLoopEvent) => void;
  emitEvent?: boolean;
};

export async function recordToolResult(options: RecordToolResultOptions): Promise<void> {
  const { result } = options;
  const content = JSON.stringify({ ok: result.ok, result: result.content });
  options.messages.push({
    role: "tool",
    toolCallId: result.callId,
    content,
    ...(result.images ? { images: result.images } : {}),
  });
  await options.session.append({
    role: "tool",
    content,
    metadata: {
      name: result.name,
      ok: result.ok,
      toolCallId: result.callId,
      ...(result.fileEvent ? { fileEvent: result.fileEvent } : {}),
      ...(result.webEvent ? { webEvent: result.webEvent } : {}),
      ...(result.mcpEvent ? { mcpEvent: result.mcpEvent } : {}),
      ...(result.processEvent ? { processEvent: result.processEvent } : {}),
      ...(result.instructionEvent ? { instructionEvent: result.instructionEvent } : {}),
      ...(result.images ? { images: persistedImageAttachments(result.images) } : {}),
      ...(options.metadata ?? {}),
    },
  });
  if (options.processManager) {
    trackBackgroundProcessCompletion(options.processManager, options.session, result);
  }
  if (options.emitEvent !== false) {
    emitToolResultEvent(result, options.onEvent);
  }
}

export function emitToolResultEvent(
  result: ToolResult,
  onEvent?: (event: AgentLoopEvent) => void,
): void {
  onEvent?.({
    type: "tool_result",
    name: result.name,
    callId: result.callId,
    ok: result.ok,
    content: result.content,
    ...(result.fileEvent ? { fileEvent: result.fileEvent } : {}),
    ...(result.webEvent ? { webEvent: result.webEvent } : {}),
    ...(result.mcpEvent ? { mcpEvent: result.mcpEvent } : {}),
    ...(result.processEvent ? { processEvent: result.processEvent } : {}),
    ...(result.instructionEvent ? { instructionEvent: result.instructionEvent } : {}),
    ...(result.images ? { images: result.images } : {}),
  });
}

export function failedToolResult(callId: string, name: string, content: string): ToolResult {
  return { callId, name, ok: false, content };
}
