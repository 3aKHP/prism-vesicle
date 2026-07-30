import type { VesicleMessage, VesicleResponse } from "../../providers/shared/types";
import type { EngineProfile } from "../engine/profile";
import type { SessionStore } from "../session/store";
import { withExecutionRound } from "../session/store";
import type { ToolCall } from "../tools";
import { cloneProviderStateEnvelope } from "../../providers/shared/state";

export async function recordAssistantToolCalls(options: {
  response: VesicleResponse;
  toolCalls: ToolCall[];
  messages: VesicleMessage[];
  session: SessionStore;
  profile: EngineProfile;
  model: string;
  metadata?: Record<string, unknown>;
}): Promise<VesicleMessage[]> {
  const { response, toolCalls } = options;
  const providerState = response.providerState ? cloneProviderStateEnvelope(response.providerState) : undefined;
  const parentMessages = [...options.messages];
  options.messages.push({
    role: "assistant",
    content: response.content,
    ...(response.reasoningContent ? { reasoningContent: response.reasoningContent } : {}),
    ...(response.thinkingBlocks ? { thinkingBlocks: response.thinkingBlocks } : {}),
    ...(providerState ? { providerState: cloneProviderStateEnvelope(providerState) } : {}),
    toolCalls,
  });
  await options.session.append({
    role: "assistant",
    content: response.content,
    metadata: withExecutionRound(options.session.sessionId, {
      engine: options.profile.id,
      model: options.model,
      providerResponseId: response.id,
      finishReason: response.finishReason,
      ...(response.reasoningContent ? { reasoningContent: response.reasoningContent } : {}),
      ...(response.thinkingBlocks ? { thinkingBlocks: response.thinkingBlocks } : {}),
      ...(response.usage ? { usage: response.usage } : {}),
      ...(providerState ? { providerState } : {}),
      ...(options.metadata ?? {}),
      toolCalls,
    }),
  });
  return parentMessages;
}
