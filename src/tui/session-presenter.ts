import { ENGINE_HANDOFF_KIND } from "../core/engine/transition";
import type { ResumedMessage } from "../core/session/store";
import type { VesicleMessage } from "../providers/shared/types";
import { displayTextFromThinkingBlocks } from "../providers/shared/thinking";
import { renderResumedToolResultSummary } from "./tool-summary";
import type { AgentCardState, Message } from "./types";

export function unresolvedToolCalls(messages: ResumedMessage[], activeToolCallId: string) {
  const answered = new Set(messages.flatMap((message) => message.toolCallId ? [message.toolCallId] : []));
  for (let index = messages.length - 1; index >= 0; index--) {
    const calls = messages[index].toolCalls;
    if (!calls?.some((call) => call.id === activeToolCallId)) continue;
    return calls.filter((call) => call.id !== activeToolCallId && !answered.has(call.id));
  }
  return [];
}

export function vesicleMessagesFromResumed(messages: ResumedMessage[]): VesicleMessage[] {
  return messages.map((message) => ({
    role: message.role,
    content: message.content,
    ...(message.kind ? { kind: message.kind } : {}),
    ...(message.reasoningContent ? { reasoningContent: message.reasoningContent } : {}),
    ...(message.thinkingBlocks ? { thinkingBlocks: message.thinkingBlocks.map((block) => ({ ...block })) } : {}),
    ...(message.toolCallId ? { toolCallId: message.toolCallId } : {}),
    ...(message.toolCalls ? { toolCalls: message.toolCalls.map((call) => ({ ...call })) } : {}),
    ...(message.images ? { images: message.images.map((image) => ({ ...image })) } : {}),
  }));
}

export function displayTranscriptFromSnapshot(messages: ResumedMessage[], agents: AgentCardState[] = []): Message[] {
  const argsByCallId = new Map<string, { name: string; arguments: string }>();
  for (const message of messages) {
    for (const call of message.toolCalls ?? []) {
      argsByCallId.set(call.id, { name: call.name, arguments: call.arguments });
    }
  }
  const agentsByToolCallId = new Map(agents.map((agent) => [agent.parentToolCallId, agent]));
  return messages.flatMap((message) => displayMessagesFromResumed(message, argsByCallId, agentsByToolCallId));
}

export function displayMessagesFromResumed(
  message: ResumedMessage,
  argsByCallId: Map<string, { name: string; arguments: string }>,
  agentsByToolCallId: Map<string, AgentCardState> = new Map(),
): Message[] {
  if (message.kind === ENGINE_HANDOFF_KIND) {
    return [{
      role: "system",
      content: message.content
        .replace(/^\[engine_handoff\]\s*/i, "Engine handoff\n")
        .replace(/\s*\[\/engine_handoff\]\s*$/i, ""),
    }];
  }
  if (message.kind === "compact-summary") {
    return [{ role: "system", content: message.content.replace(/^\[conversation summary\]\s*/i, "Conversation summary\n") }];
  }
  if (message.role === "assistant") {
    if (message.kind === "quality-rejected-candidate") return [];
    const reasoningText = displayTextFromThinkingBlocks(message.thinkingBlocks) ?? message.reasoningContent;
    const out: Message[] = [];
    if (reasoningText?.trim()) out.push({ role: "system", content: reasoningText, kind: "reasoning" });
    if (message.content.trim()) {
      out.push({
        ...(message.recordUuid ? { id: message.recordUuid } : {}),
        role: "assistant",
        content: message.content,
        ...(message.kind === "stage-bootstrap-opening" ? { kind: "stage-bootstrap-opening" as const } : {}),
        ...(message.engine ? { engine: message.engine } : {}),
        ...(message.model ? { model: message.model } : {}),
      });
    }
    return out;
  }
  if (message.role === "tool") {
    const lookup = message.toolCallId ? argsByCallId.get(message.toolCallId) : undefined;
    if (lookup?.name === "spawn_agent") {
      const agent = message.toolCallId ? agentsByToolCallId.get(message.toolCallId) : undefined;
      return agent ? [{ role: "system", content: "", kind: "agent", agentRunId: agent.runId }] : [];
    }
    if (lookup) {
      const ok = message.toolOk ?? true;
      return [
        {
          role: "tool",
          toolStage: "call",
          toolName: lookup.name,
          toolArgs: lookup.arguments,
          toolCallId: message.toolCallId,
          toolFileEvent: message.toolFileEvent,
          toolWebEvent: message.toolWebEvent,
          toolMcpEvent: message.toolMcpEvent,
          toolProcessEvent: message.toolProcessEvent,
          toolOk: ok,
          images: message.images,
          content: "",
        },
        {
          role: "tool",
          toolStage: "result",
          toolName: lookup.name,
          toolCallId: message.toolCallId,
          toolOk: ok,
          toolFileEvent: message.toolFileEvent,
          toolWebEvent: message.toolWebEvent,
          toolMcpEvent: message.toolMcpEvent,
          toolProcessEvent: message.toolProcessEvent,
          images: message.images,
          content: ok ? "" : extractResultContent(message.content),
        },
      ];
    }
    return [{ role: "tool", content: renderResumedToolResultSummary(message.content), images: message.images }];
  }
  if (message.role === "user" && message.kind === "subagent-results") {
    return [{ role: "system", content: "Background SubAgent results were delivered to the parent Engine." }];
  }
  if (message.role === "user" && message.kind === "background-process-results") {
    return [{ role: "system", content: "Background shell completion was delivered to the active Engine." }];
  }
  if (message.role === "user" && message.kind === "quality-rewrite-feedback") {
    return [{ role: "system", content: "Output Quality Guard requested a rewrite before delivery." }];
  }
  if (message.role === "user") {
    return [{
      role: message.role,
      content: message.content,
      ...(message.images ? { images: message.images.map((image) => ({ ...image })) } : {}),
    }];
  }
  return [{ role: "system", content: message.content }];
}

export function joinSessionPath(sessionId: string): string {
  return `.vesicle/sessions/${sessionId}.jsonl`;
}

function extractResultContent(raw: string): string {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && typeof (parsed as { result?: unknown }).result === "string") {
      return (parsed as { result: string }).result;
    }
  } catch {
    // Preserve the original stored text when it is not a structured result.
  }
  return raw;
}
