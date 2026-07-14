import type { Accessor, Setter } from "solid-js";
import type { AgentLoopEvent } from "../core/agent-loop/run";
import type { BackgroundProcessEvent, BackgroundProcessState } from "../core/process/manager";
import type { ProcessToolEvent } from "../core/tools";
import { processEventFromTask } from "../core/tools/shell";
import { displayTextFromThinkingBlocks } from "../providers/shared/thinking";
import type { ResponseUsage } from "../providers/shared/types";
import { applyAgentEvent } from "./agent-view";
import type { ActivityEntry, AgentCardState, Message } from "./types";

export type AgentProcessControllerOptions = {
  sessionId: Accessor<string | undefined>;
  busy: Accessor<boolean>;
  activeEngine: Accessor<import("../core/engine/profile").EngineId>;
  activeModel: Accessor<string>;
  backgroundProcesses: Accessor<BackgroundProcessState[]>;
  setBackgroundProcesses: Setter<BackgroundProcessState[]>;
  setAgentCards: Setter<AgentCardState[]>;
  setMessages: Setter<Message[]>;
  setActivity: Setter<ActivityEntry[]>;
  setStatus: Setter<string>;
  setStreamingAssistant: Setter<string>;
  setStreamingReasoning: Setter<string>;
  setLastDisplayedToolAssistantContent: Setter<string | null>;
  markTurnSawResponse: () => void;
  recordResponseUsage: (usage: ResponseUsage) => void;
  recordIndependentAgentUsage: (usage: ResponseUsage) => void;
  assetDriftKey: Accessor<string | undefined>;
  setAssetDriftKey: (key: string) => void;
};

export function createAgentProcessController(options: AgentProcessControllerOptions) {
  let formingToolName: string | undefined;

  function recordActivity(entry: ActivityEntry): void {
    options.setActivity((previous) => [...previous, entry].slice(-60));
  }

  function appendReasoningMessage(content: string): void {
    if (!content.trim()) return;
    options.setMessages((previous) => [...previous, { role: "system", content, kind: "reasoning" }]);
  }

  function handleAgentEvent(event: AgentLoopEvent): void {
    projectAgentCard(event);
    if (handleAgentLifecycle(event)) return;
    if (handleProcessOrAsset(event)) return;
    if (handleProviderEvent(event)) return;
    if (handleToolEvent(event)) return;
    handleInteractionEvent(event);
  }

  function projectAgentCard(event: AgentLoopEvent): void {
    if (event.type !== "agent_created"
      && event.type !== "agent_started"
      && event.type !== "agent_progress"
      && event.type !== "agent_completed"
      && event.type !== "agent_integrated") return;
    options.setAgentCards((cards) => applyAgentEvent(cards, event));
    if (event.type !== "agent_created") return;
    options.setMessages((current) => current.some((message) => message.kind === "agent" && message.agentRunId === event.agent.runId)
      ? current
      : [...current, { role: "system", content: "", kind: "agent", agentRunId: event.agent.runId }]);
  }

  function handleAgentLifecycle(event: AgentLoopEvent): boolean {
    switch (event.type) {
      case "agent_created":
        recordActivity({ kind: "agent", text: `queued ${event.agent.profileId}: ${event.agent.description}` });
        return true;
      case "agent_started":
        recordActivity({ kind: "agent", text: `started ${event.agent.handle}: ${event.agent.description}` });
        return true;
      case "agent_progress":
        recordActivity({ kind: "agent", text: `${event.handle}: ${event.text}` });
        return true;
      case "agent_completed": {
        const parentIsCurrent = event.result.parentSessionId === options.sessionId() || (!options.sessionId() && options.busy());
        if (parentIsCurrent && event.result.mode === "foreground" && event.result.usage) {
          options.recordIndependentAgentUsage(event.result.usage);
        }
        recordActivity({ kind: "agent", text: `${event.result.status} ${event.result.handle}: ${event.result.description}` });
        return true;
      }
      case "agent_integrated":
        recordActivity({ kind: "agent", text: `integrated ${event.handle}` });
        return true;
      default:
        return false;
    }
  }

  function handleProcessOrAsset(event: AgentLoopEvent): boolean {
    if (event.type === "process_update") {
      applyProcessUpdate(event.callId, event.processEvent);
      if (event.processEvent.executionMode === "foreground") {
        options.setStatus(event.processEvent.status === "running"
          ? `running shell · ${Math.max(0, Math.round(event.processEvent.durationMs / 1000))}s`
          : `shell ${event.processEvent.status}`);
      }
      return true;
    }
    if (event.type !== "asset_drift") return false;
    const key = `${options.sessionId() ?? "unknown"}:${event.fingerprint}`;
    if (options.assetDriftKey() === key) return true;
    options.setAssetDriftKey(key);
    const changed = event.changedPaths.length > 0 ? event.changedPaths.join(", ") : "effective assets";
    options.setMessages((current) => [...current, {
      role: "system",
      content: `Asset drift detected since this session began: ${changed}. This continuation uses the current effective assets.`,
    }]);
    recordActivity({ kind: "system", text: `asset drift: ${changed}` });
    return true;
  }

  function handleProviderEvent(event: AgentLoopEvent): boolean {
    switch (event.type) {
      case "provider_request":
        options.setStreamingAssistant("");
        options.setStreamingReasoning("");
        formingToolName = undefined;
        options.setStatus("sending request");
        recordActivity({ kind: "provider", text: `provider request #${event.iteration + 1}` });
        return true;
      case "assistant_delta":
        options.setStreamingAssistant((previous) => `${previous}${event.delta}`);
        options.setStatus("generating response");
        return true;
      case "assistant_reasoning_delta":
        options.setStreamingReasoning((previous) => `${previous}${event.delta}`);
        options.setStatus("generating response");
        return true;
      case "tool_call_delta":
        if (event.name) {
          formingToolName = event.name;
          recordActivity({ kind: "tool", text: `tool call forming: ${event.name}` });
        }
        options.setStatus(formingToolName ? `calling · ${formingToolName}` : "generating response");
        return true;
      case "assistant_response":
        handleAssistantResponse(event);
        return true;
      default:
        return false;
    }
  }

  function handleAssistantResponse(event: Extract<AgentLoopEvent, { type: "assistant_response" }>): void {
    options.markTurnSawResponse();
    options.setStreamingAssistant("");
    options.setStreamingReasoning("");
    if (event.usage) options.recordResponseUsage(event.usage);
    if (event.toolCalls.length > 0) {
      const reasoningText = displayTextFromThinkingBlocks(event.thinkingBlocks) ?? event.reasoningContent;
      if (reasoningText) appendReasoningMessage(reasoningText);
      if (event.content.trim()) {
        options.setMessages((previous) => [...previous, {
          role: "assistant",
          content: event.content,
          engine: options.activeEngine(),
          model: options.activeModel(),
        }]);
      }
      options.setLastDisplayedToolAssistantContent(event.content);
    }
    recordActivity({
      kind: "assistant",
      text: event.toolCalls.length > 0
        ? `assistant response with ${event.toolCalls.length} tool call${event.toolCalls.length > 1 ? "s" : ""}`
        : "assistant response complete",
    });
  }

  function handleToolEvent(event: AgentLoopEvent): boolean {
    if (event.type === "tool_call") {
      if (event.name === "spawn_agent") {
        options.setStatus("starting SubAgent");
        recordActivity({ kind: "agent", text: "spawn_agent requested" });
        return true;
      }
      options.setMessages((previous) => [...previous, {
        role: "tool",
        toolStage: "call",
        toolName: event.name,
        toolArgs: event.arguments,
        toolCallId: event.callId,
        content: "",
      }]);
      options.setStatus(`calling · ${event.name}`);
      recordActivity({ kind: "tool", text: `calling ${event.name}` });
      return true;
    }
    if (event.type !== "tool_result") return false;
    if (event.name === "spawn_agent") {
      if (!event.ok) {
        options.setStatus("SubAgent launch failed");
        options.setMessages((current) => [...current, { role: "system", content: `SubAgent launch failed: ${event.content}` }]);
      }
      recordActivity({ kind: "agent", text: `${event.ok ? "ok" : "failed"} spawn_agent` });
      return true;
    }
    projectToolResult(event);
    return true;
  }

  function projectToolResult(event: Extract<AgentLoopEvent, { type: "tool_result" }>): void {
    const latestBackgroundProcess = event.processEvent?.taskId
      ? options.backgroundProcesses().find((process) => process.taskId === event.processEvent?.taskId)
      : undefined;
    const displayedProcessEvent = latestBackgroundProcess ? processEventFromTask(latestBackgroundProcess) : event.processEvent;
    options.setMessages((previous) => {
      const next = previous.map((message) => message.toolCallId === event.callId && message.toolStage === "call"
        ? { ...message, toolFileEvent: event.fileEvent, toolWebEvent: event.webEvent, toolMcpEvent: event.mcpEvent, toolProcessEvent: displayedProcessEvent, toolOk: event.ok, images: event.images }
        : message);
      next.push({
        role: "tool",
        toolStage: "result",
        toolName: event.name,
        toolCallId: event.callId,
        toolOk: event.ok,
        toolFileEvent: event.fileEvent,
        toolWebEvent: event.webEvent,
        toolMcpEvent: event.mcpEvent,
        toolProcessEvent: displayedProcessEvent,
        images: event.images,
        content: event.ok ? "" : event.content,
      });
      return next;
    });
    recordActivity({ kind: "tool", text: `${event.ok ? "ok" : "failed"} ${event.name}: ${event.content}` });
  }

  function handleInteractionEvent(event: AgentLoopEvent): void {
    switch (event.type) {
      case "quality_status": {
        const status = event.phase === "checking" ? "checking prose quality"
          : event.phase === "rewriting" ? `rewriting prose ${event.attempt} of 2`
            : event.phase === "exhausted" ? "quality rewrite exhausted"
              : event.phase === "observed" ? `quality observed · ${event.findingCount} finding${event.findingCount === 1 ? "" : "s"}`
                : "prose quality accepted";
        options.setStatus(status);
        if (event.phase === "rewriting") options.markTurnSawResponse();
        recordActivity({ kind: "validation", text: status });
        return;
      }
      case "gate_pending":
        recordActivity({ kind: "gate", text: `gate pending: ${event.gate}` });
        return;
      case "engine_switch_pending":
        recordActivity({ kind: "gate", text: `engine switch pending: ${event.targetEngine}` });
        return;
      case "user_question_pending":
        recordActivity({ kind: "gate", text: `question pending: ${event.header}` });
        return;
      case "validation":
        recordActivity({ kind: "validation", text: event.ok ? "validation passed" : "validation found issues" });
        return;
      default:
        return;
    }
  }

  function handleBackgroundProcessEvent(event: BackgroundProcessEvent): void {
    const process = event.process;
    options.setBackgroundProcesses((current) => {
      const index = current.findIndex((candidate) => candidate.taskId === process.taskId);
      if (index < 0) return [...current, process];
      return current.map((candidate, candidateIndex) => candidateIndex === index ? process : candidate);
    });
    applyProcessUpdate(process.parentToolCallId, processEventFromTask(process));
    if (process.status !== "running") {
      recordActivity({ kind: "tool", text: `${process.taskId} ${process.status}${process.exitCode !== undefined ? ` · exit ${process.exitCode}` : ""}` });
    }
  }

  function applyProcessUpdate(callId: string, processEvent: ProcessToolEvent): void {
    options.setMessages((current) => current.map((message) =>
      message.toolCallId === callId ? { ...message, toolProcessEvent: processEvent } : message
    ));
  }

  return {
    appendReasoningMessage,
    handleAgentEvent,
    handleBackgroundProcessEvent,
    recordActivity,
  };
}
