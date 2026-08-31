import type { ProviderAdapter, VesicleMessage, VesicleRequest, VesicleResponse } from "../../providers/shared/types";
import { prepareProviderMessages } from "../attachments/store";
import type { EngineId } from "../engine/profile";
import type { ProviderSelection } from "../../config/providers";
import type { SessionStore } from "../session/store";
import { withExecutionRound } from "../session/store";
import type { ToolDefinition } from "../tools";
import type { ProcessManager } from "../process/manager";
import type { AgentLoopEvent } from "./types";
import { findPersistedProcessResults, renderBackgroundProcessNotifications } from "./background-process";
import { cloneSideQuestionMessages, type SideQuestionContextSnapshot } from "../side-question/types";
import { ProviderAttemptCommitBarrier } from "../../providers/shared/attempt-commit";

type ProviderRoundOptions = {
  rootDir: string;
  provider: ProviderAdapter;
  providerId: string;
  model: string;
  engine: EngineId;
  providerSelection: ProviderSelection;
  visionEnabled: boolean;
  /** Declare the provider-native built-in web search for this round's request. */
  webSearch?: boolean;
  systemPrompt: string;
  tools: ToolDefinition[];
  generation?: VesicleRequest["generation"];
  messages: VesicleMessage[];
  session: SessionStore;
  processManager: ProcessManager;
  iteration: number;
  bufferAssistant?: boolean;
  signal?: AbortSignal;
  onEvent?: (event: AgentLoopEvent) => void;
  onProviderContextSnapshot?: (snapshot: SideQuestionContextSnapshot) => void;
  /** The Agent Loop already drained notifications before its exact send guard. */
  backgroundAlreadyMaterialized?: boolean;
};

export async function completeProviderRound(options: ProviderRoundOptions): Promise<VesicleResponse> {
  if (!options.backgroundAlreadyMaterialized) await materializeBackgroundProcessNotifications(options);

  // Publish the immutable side-question context boundary immediately before
  // materializing images and sending the request. At this point `messages`
  // holds the exact logical history for the next main provider request, with
  // every prior tool call matched by its tool result, so `/btw` never observes
  // a half-written tool round. The clone drops base64 image bytes.
  options.onProviderContextSnapshot?.({
    sessionId: options.session.sessionId,
    engine: options.engine,
    providerSelection: options.providerSelection,
    ...(options.generation ? { generation: options.generation } : {}),
    visionEnabled: options.visionEnabled,
    engineSystemPrompt: options.systemPrompt,
    messages: cloneSideQuestionMessages(options.messages),
  });

  options.onEvent?.({ type: "provider_request", iteration: options.iteration });
  const messages = await prepareProviderMessages(options.rootDir, options.messages, options.visionEnabled);
  const barrier = new ProviderAttemptCommitBarrier();
  const response = await completeWithStreaming(options.provider, {
    id: options.session.sessionId,
    model: { provider: options.providerId, model: options.model },
    system: [options.systemPrompt],
    messages,
    tools: options.tools,
    ...(options.webSearch ? { webSearch: true } : {}),
    generation: options.generation,
    signal: options.signal,
    onRetry: options.onEvent ? (info) => options.onEvent?.({
      type: "provider_retry",
      attempt: info.attempt,
      maxRetries: info.maxRetries,
      delayMs: info.delayMs,
      ...(info.status !== undefined ? { status: info.status } : {}),
      iteration: options.iteration,
    }) : undefined,
  }, options.onEvent, options.bufferAssistant === true, barrier);
  return response;
}

export async function materializeBackgroundProcessNotifications(
  options: Pick<ProviderRoundOptions, "rootDir" | "messages" | "processManager" | "session">,
): Promise<void> {
  const backgroundNotifications = await options.processManager.collectNotifications(options.session.sessionId);
  if (backgroundNotifications.length === 0) return;
  const taskIds = backgroundNotifications.map((task) => task.taskId).sort();
  // The durable record is the delivery, so the `notified` flip happens only
  // after the record is safe. Coverage is per task: a crash between the record
  // append and the flip can regrow the replayed batch, and only the uncovered
  // complement may append or send a second copy. Covered tasks whose records
  // dropped out of projection (a failed-turn drop) still need the wire copy,
  // because the active conversation no longer carries them.
  const persisted = await findPersistedProcessResults(options.rootDir, options.session.sessionId, taskIds);
  const undelivered = backgroundNotifications.filter((task) => !persisted.coveredTaskIds.has(task.taskId));
  const droppedFromProjection = backgroundNotifications.filter((task) => persisted.invisibleTaskIds.has(task.taskId));
  const needsWire = [...undelivered, ...droppedFromProjection];
  if (undelivered.length > 0) {
    const content = renderBackgroundProcessNotifications(needsWire);
    options.messages.push({ role: "user", content });
    await options.session.append({
      // Host packet, not authored input: persisted as a system record and
      // projected back into a provider-visible user message by the history
      // projector, which keeps audit history free of user-role process data.
      role: "system",
      content,
      metadata: withExecutionRound(options.session.sessionId, {
        kind: "background-process-results",
        taskIds: needsWire.map((task) => task.taskId).sort(),
      }),
    });
  } else if (droppedFromProjection.length > 0) {
    options.messages.push({ role: "user", content: renderBackgroundProcessNotifications(droppedFromProjection) });
  }
  await options.processManager.markNotified(taskIds);
}

export function emitAssistantResponse(response: VesicleResponse, onEvent?: (event: AgentLoopEvent) => void): void {
  const toolCalls = response.toolCalls ?? [];
  onEvent?.({
    type: "assistant_response",
    content: response.content,
    ...(response.reasoningContent ? { reasoningContent: response.reasoningContent } : {}),
    ...(response.thinkingBlocks ? { thinkingBlocks: response.thinkingBlocks } : {}),
    ...(response.usage ? { usage: response.usage } : {}),
    ...(response.webSearch ? { webSearch: response.webSearch } : {}),
    toolCalls: toolCalls.map((call) => ({ id: call.id, name: call.name, arguments: call.arguments })),
  });
}

async function completeWithStreaming(
  provider: ProviderAdapter,
  request: VesicleRequest,
  onEvent?: (event: AgentLoopEvent) => void,
  bufferAssistant = false,
  barrier = new ProviderAttemptCommitBarrier(),
): Promise<VesicleResponse> {
  if (!provider.stream) return barrier.commit(await provider.complete(request));

  for await (const event of provider.stream(request)) {
    switch (event.type) {
      case "content_delta":
        if (!bufferAssistant) onEvent?.({ type: "assistant_delta", delta: event.delta });
        break;
      case "reasoning_delta":
        onEvent?.({ type: "assistant_reasoning_delta", delta: event.delta });
        break;
      case "tool_call_delta":
        onEvent?.({ type: "tool_call_delta", name: event.name, argumentsDelta: event.argumentsDelta });
        break;
      case "attempt_started":
        barrier.start(event.attempt);
        break;
      case "tool_call_candidate":
        barrier.addCandidate(event.attempt, event.toolCall);
        break;
      case "attempt_discarded":
        barrier.discard(event.attempt);
        break;
      case "complete":
        return barrier.commit(event.response, event.attempt);
    }
  }
  throw new Error("Provider stream ended without a final response.");
}
